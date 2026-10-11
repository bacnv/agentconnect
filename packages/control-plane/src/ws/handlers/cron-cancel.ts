/**
 * `cron/cancel` (D→C REQ → `cron/cancel/ok`) — an agent retires a cron it authored.
 *
 * The counterpart of `cron/author`, and the reason it exists: a tool that can only create is one
 * whose mistakes only a human can undo. That is the objection that retired the local-only cron tool
 * (`agent-authored-cron-design.md` §2), and it applies to an agent that over-scheduled itself just
 * as much — the more so because the console was the stated remedy, which makes cleanup the
 * operator's job every time.
 *
 * Authority is the STORED row, never the payload: `agentId` scopes the lookup, and the two
 * conditions that grant the cancellation are read off the row — it drives this agent, and no human
 * created it. An agent therefore retires what it authored and nothing else; a human's schedule is
 * refused even when the agent serves it, because a cron somebody set is not the agent's to delete.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, CronId, DaemonId } from '../../domain/ids.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleCronCancel: Handler = async (frame, conn, deps) => {
  if (!isFrame('cron/cancel')(frame)) return
  const p = frame.payload
  try {
    await cancel(frame, conn, deps, p.cronId, p.agentId)
  } catch (error) {
    // A handler that REJECTS closes the socket (connection.ts 1011), so every path replies.
    deps.log.error({ daemonId: conn.daemonId, cronId: p.cronId }, `cron/cancel failed: ${String(error)}`)
    conn.sendError(frame.id, 'INTERNAL', 'cron cancellation failed', true)
  }
}

/** The refusal is `removed: false`, not a wire error: "not yours" is an outcome the agent reports
 *  to the person, not a fault it must guess at. */
async function cancel(
  frame: Parameters<Handler>[0],
  conn: Parameters<Handler>[1],
  deps: Parameters<Handler>[2],
  cronId: string,
  agentId: string
): Promise<void> {
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  const cron = await deps.cron.get(orgId, CronId(cronId))
  if (!cron?.agentId || cron.agentId !== agentId) {
    conn.replyTo(frame, 'cron/cancel/ok', { removed: false })
    return
  }
  // A human's schedule outlives the agent's opinion of it. `createdByUserId` is the only record of
  // authorship, and `cron-author.ts` leaves it absent precisely so this test can exist.
  if (cron.createdByUserId !== null) {
    conn.replyTo(frame, 'cron/cancel/ok', { removed: false })
    return
  }
  // The live seam, mirroring `cron/author`: a daemon retires only for an agent it actually serves.
  const agent = await deps.agent.get(orgId, AgentId(agentId))
  if (!agent) {
    conn.replyTo(frame, 'cron/cancel/ok', { removed: false })
    return
  }
  const resolver = deps.placementResolver ?? PLACEMENT_ONLY
  if (!(await resolver.mayAct(agent, DaemonId(conn.daemonId)))) {
    conn.replyTo(frame, 'cron/cancel/ok', { removed: false })
    return
  }
  const removed = await deps.cron.remove(orgId, cron.id, agent.id)
  if (!removed) {
    // A concurrent delete or an agent move won the race — the cron is gone either way.
    conn.replyTo(frame, 'cron/cancel/ok', { removed: true })
    return
  }
  deps.recomputeDuties?.(orgId)
  void deps.audit
    .append({
      kind: 'cron_change',
      orgId,
      agentId: agent.id,
      frameType: 'cron/cancel',
      message: `cron ${cron.id} cancelled by agent ${agent.id}`,
      details: { cronId: cron.id }
    })
    .catch(() => {})
  // Best-effort, matching every other cron push: an offline daemon converges on its next register.
  await deps.agentDelivery.cronRemove(agent, cron.id, orgId, (err, target) => {
    if (err instanceof NoConnection) return
    deps.log.error({ daemonId: target, cronId: cron.id }, `cron/remove push failed: ${String(err)}`)
  })
  conn.replyTo(frame, 'cron/cancel/ok', { removed: true })
}
