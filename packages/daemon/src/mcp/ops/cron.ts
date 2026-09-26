import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CronAuthor, CronAuthorOk } from '@agentconnect.md/protocol'
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
  const ok = await deps.authorCron({
    requestId: randomUUID(),
    agentId: ctx.agentId,
    ...(parsed.name ? { name: parsed.name } : {}),
    schedule: parsed.schedule,
    timezone: parsed.timezone,
    trigger: parsed.prompt,
    // `ctx.thread` is deliberately not sent: the fire's thread derives from the cron id, so the
    // reply lands in this conversation as a new thread rather than reviving the one that asked.
    target: { platform: ctx.platform, channel: ctx.channel, integrationId: ctx.integrationId }
  })
  return {
    cronId: ok.cronId,
    schedule: ok.schedule,
    timezone: ok.timezone,
    nextRun: ok.nextRun,
    channel: ctx.channel
  }
}
