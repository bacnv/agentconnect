/**
 * `cron/author` (D→C REQ → `cron/author/ok`) — an agent schedules itself.
 *
 * The same write path as `PUT /crons/:id`: validate, fence, upsert, recompute duties, audit,
 * push `cron/upsert` down. Two things differ. The cron id is DERIVED from the frame's
 * `requestId`, because the correlator re-sends a REQ whose reply was dropped and a retried
 * authoring must answer the same cron instead of minting a second. And no creator is stamped —
 * an agent-authored row has no human behind it, which the console already renders as "—".
 */
import { createHash } from 'node:crypto'
import { Cron } from 'croner'
import { isFrame, isSessionIdentityPlatform } from '@agentconnect.md/protocol'
import { AgentId, CronId, DaemonId, IntegrationId } from '../../domain/ids.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { cronToUpsert } from '../../orchestrator/placement.js'
import { toDbPlatform } from '../../persistence/platform.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

/** A schedule the agent can repair in the same turn — the reply carries the reason. */
class BadSchedule extends Error {}

/** ECMA-402 also accepts fixed-offset ids such as "+07:00", which are not zones. */
function isIanaTimezone(timezone: string): boolean {
  try {
    const canonical = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone
    return !canonical.startsWith('+') && !canonical.startsWith('-')
  } catch {
    return false
  }
}

/** Validate the expression AND resolve the next fire time. The zone check is only here: croner's
 *  constructor validates the expression alone, and a never-firing expression answers `null` — which
 *  is a refusal, not a schedule. */
function resolveNextRun(schedule: string, timezone: string): Date {
  if (!isIanaTimezone(timezone)) {
    throw new BadSchedule('timezone must be a named IANA zone, e.g. Asia/Ho_Chi_Minh — not a fixed offset')
  }
  let job: Cron
  try {
    job = new Cron(schedule, { timezone, paused: true })
  } catch {
    throw new BadSchedule('schedule must be a cron expression with five fields, e.g. "30 6 * * *"')
  }
  let next: Date | null
  try {
    next = job.nextRun()
  } finally {
    job.stop()
  }
  if (!next) throw new BadSchedule('that schedule never fires — pick one that occurs')
  return next
}

/** The cron id one authoring call maps to. Derived rather than minted per arrival so a retried REQ
 *  is the same cron, and per-`requestId` so a fresh call is a new one. */
function authorCronId(orgId: string, agentId: string, requestId: string): string {
  const h = createHash('sha256').update(`${orgId}:${agentId}:${requestId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(12, 15)}-8${h.slice(15, 18)}-${h.slice(18, 30)}`
}

export const handleCronAuthor: Handler = async (frame, conn, deps) => {
  if (!isFrame('cron/author')(frame)) return
  try {
    await author(frame, conn, deps)
  } catch (error) {
    // A handler that REJECTS closes the socket (connection.ts 1011), so every path replies.
    if (error instanceof BadSchedule) {
      conn.sendError(frame.id, 'BAD_PAYLOAD', error.message, false)
      return
    }
    deps.log.error({ daemonId: conn.daemonId, agentId: frame.payload.agentId }, `cron/author failed: ${String(error)}`)
    conn.sendError(frame.id, 'INTERNAL', 'cron authoring failed', true)
  }
}

const author: Handler = async (frame, conn, deps) => {
  if (!isFrame('cron/author')(frame)) return
  const p = frame.payload
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  // The live seam: a daemon may author only for an agent it actually serves.
  const agent = await deps.agent.get(orgId, AgentId(p.agentId))
  if (!agent) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'unknown agent', false)
    return
  }
  const resolver = deps.placementResolver ?? PLACEMENT_ONLY
  if (!(await resolver.mayAct(agent, DaemonId(conn.daemonId)))) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
    return
  }
  // The target must ride one of THIS agent's integrations — the route's ownership check.
  const integration = p.target.integrationId
    ? await deps.integration.get(orgId, IntegrationId(p.target.integrationId))
    : null
  if (!integration || integration.agentId !== agent.id) {
    conn.sendError(frame.id, 'BAD_PAYLOAD', 'target integration is not an integration of this agent', false)
    return
  }
  if (isSessionIdentityPlatform(p.target.platform)) {
    conn.sendError(frame.id, 'BAD_PAYLOAD', 'this session has no IM conversation to fire into', false)
    return
  }
  const nextRun = resolveNextRun(p.schedule, p.timezone)
  const cronId = CronId(authorCronId(orgId, agent.id, p.requestId))

  const existing = await deps.cron.get(orgId, cronId)
  if (existing) {
    // A re-sent REQ, not a second request: answer from the STORED row, so a retry carrying a
    // different body cannot quietly rewrite what the first call authored.
    conn.replyTo(frame, 'cron/author/ok', {
      cronId: existing.id,
      schedule: existing.schedule,
      timezone: existing.timezone,
      nextRun: resolveNextRun(existing.schedule, existing.timezone).toISOString()
    })
    return
  }

  const cron = await deps.cron.upsert({
    cronId,
    orgId,
    agentId: agent.id,
    ...(p.name ? { name: p.name } : {}),
    schedule: p.schedule,
    timezone: p.timezone,
    targetPlatform: toDbPlatform(integration.platform),
    targetChannel: p.target.channel,
    targetIntegrationId: integration.id,
    trigger: p.trigger,
    enabled: true
  })
  deps.recomputeDuties?.(orgId)
  void deps.audit
    .append({
      kind: 'cron_change',
      orgId,
      agentId: agent.id,
      frameType: 'cron/author',
      message: `cron ${cron.id} authored by agent ${agent.id}`,
      details: {
        cronId: cron.id,
        schedule: cron.schedule,
        timezone: cron.timezone,
        targetChannel: cron.targetChannel,
        enabled: cron.enabled
      }
    })
    .catch(() => {})
  // The row is durable before the push, matching the route: a daemon that is offline converges
  // on its next register, so a failed push is not a failed authoring.
  const wire = cronToUpsert(cron)
  if (wire) {
    await deps.agentDelivery.cronUpsert(agent, wire, (err, target) => {
      if (err instanceof NoConnection) return
      deps.log.error({ daemonId: target, cronId: cron.id }, `cron/upsert push failed: ${String(err)}`)
    })
  }
  conn.replyTo(frame, 'cron/author/ok', {
    cronId: cron.id,
    schedule: cron.schedule,
    timezone: cron.timezone,
    nextRun: nextRun.toISOString()
  })
}
