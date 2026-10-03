import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CronAuthor, CronAuthorOk, CronCancel, CronCancelOk } from '@agentconnect.md/protocol'
import { threadContainerFor } from '../../platforms/thread-keys.js'
import { optionalString, parseArgs, requiredString, unexpectedKeys } from './args.js'
import type { SessionContext } from './context.js'

/**
 * `scheduleCron` — an agent schedules itself
 * (docs/superpowers/specs/2026-09-26-agent-authored-cron-design.md §6).
 *
 * STRICT by construction, and that is the whole authorization story: the target is the
 * conversation this call ran in, so the model must not be able to name a different one. A plain
 * `z.object` would strip a stray `channel` silently, which is why this is not one.
 */

export const SCHEDULE_CRON_ARGS = z.strictObject(
  {
    schedule: requiredString('schedule'),
    timezone: requiredString('timezone'),
    prompt: requiredString('prompt'),
    name: optionalString('name')
  },
  unexpectedKeys
)

/** The one seam this op has: it talks to the control plane, never to a platform gateway.
 *  Absent where there is no connected CP — refused at call time rather than at dispatch. */
export interface CronAuthorDeps {
  authorCron?: (req: CronAuthor) => Promise<CronAuthorOk>
  cancelCron?: (req: CronCancel) => Promise<CronCancelOk>
}

/** `cancelCron` — the agent that authored a cron retires it again, without asking the operator.
 *  A `cronId` the CP does not consider this agent's answers `removed:false`; that is a fact to
 *  report, not an exception, so it is returned rather than thrown. */
export const CANCEL_CRON_ARGS = z.strictObject({ cronId: requiredString('cronId') }, unexpectedKeys)

export async function cancelCron(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CronAuthorDeps
): Promise<unknown> {
  const parsed = parseArgs(CANCEL_CRON_ARGS, args)
  if (!deps.cancelCron) throw new Error('cancelCron is not available in this environment.')
  // The agent id is the session's own, never the model's claim — same posture as `scheduleCron`,
  // which builds its target from trusted context. The CP then re-reads the stored row.
  const ok = await deps.cancelCron({ cronId: parsed.cronId, agentId: ctx.agentId })
  return ok.removed
    ? { removed: true, cronId: parsed.cronId }
    : { removed: false, cronId: parsed.cronId, reason: 'no cron with that id belongs to you' }
}

export async function scheduleCron(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CronAuthorDeps
): Promise<unknown> {
  const parsed = parseArgs(SCHEDULE_CRON_ARGS, args)
  // No integration, no conversation: refused rather than authored headless, because a cron the
  // agent believes posts — and that never posts — is worse than a refusal.
  if (!ctx.integrationId) {
    throw new Error('scheduleCron: this session has no platform integration, so there is no conversation to fire into.')
  }
  if (!deps.authorCron) throw new Error('scheduleCron is not available in this environment.')
  // The CONTAINER the conversation sits in, when the platform has one (a Telegram forum topic).
  // Not `ctx.thread` as such: on Slack that IS the sub-thread the fire must leave behind.
  const container = threadContainerFor(ctx.platform, ctx.thread)
  const ok = await deps.authorCron({
    requestId: randomUUID(),
    agentId: ctx.agentId,
    ...(parsed.name ? { name: parsed.name } : {}),
    schedule: parsed.schedule,
    timezone: parsed.timezone,
    trigger: parsed.prompt,
    target: {
      platform: ctx.platform,
      channel: ctx.channel,
      integrationId: ctx.integrationId,
      ...(container !== undefined ? { thread: container } : {})
    }
  })
  return {
    cronId: ok.cronId,
    schedule: ok.schedule,
    timezone: ok.timezone,
    nextRun: ok.nextRun,
    channel: ctx.channel
  }
}
