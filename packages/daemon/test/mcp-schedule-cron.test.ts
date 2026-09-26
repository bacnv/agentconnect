/**
 * `scheduleCron` — the two load-bearing properties.
 *
 * A cron must target the session the call ran in, and the model must not be able to name a
 * different one. Both are asserted against the frame the op builds, because the schema and
 * the context copy are separately breakable: loosening `strictObject` to `object` would
 * silently strip a `channel` argument and no other test would notice.
 */
import { describe, it, expect, vi } from 'vitest'
import type { CronAuthor } from '@agentconnect.md/protocol'
import { scheduleCron } from '../src/mcp/ops/cron.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import type { SessionContext } from '../src/mcp/ops.js'

const ctx: SessionContext = {
  agentId: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
  platform: 'telegram',
  integrationId: 'int-tg',
  isDm: false,
  channel: '-1001234567890',
  thread: '-1001234567890:42',
  tools: toolsForIntegrations([
    {
      id: 'int-tg',
      platform: 'telegram',
      core: { mode: 'direct', bindRules: [], mutedChannels: [], affinityDenied: [], gated: false },
      config: { botToken: '123456:ABC' }
    } as never
  ])
}

const args = { schedule: '30 6 * * *', timezone: 'Asia/Ho_Chi_Minh', prompt: 'chào cả nhà' }

function deps() {
  const seen: CronAuthor[] = []
  const authorCron = vi.fn(async (req: CronAuthor) => {
    seen.push(req)
    return {
      cronId: '55555555-5555-4555-8555-555555555555',
      schedule: req.schedule,
      timezone: req.timezone,
      nextRun: '2026-09-26T23:30:00.000Z'
    }
  })
  return { seen, authorCron }
}

describe('scheduleCron', () => {
  it('fills every coordinate from the session, never from the model', async () => {
    const d = deps()
    await scheduleCron(ctx, args, d)

    expect(d.seen).toHaveLength(1)
    expect(d.seen[0]).toMatchObject({
      agentId: ctx.agentId,
      schedule: args.schedule,
      timezone: args.timezone,
      trigger: args.prompt,
      target: { platform: 'telegram', channel: '-1001234567890', integrationId: 'int-tg' }
    })
    // A fresh id per call: two calls are two crons, which is what a caller asking twice means.
    expect(d.seen[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('refuses a channel argument by name', async () => {
    const d = deps()
    await expect(scheduleCron(ctx, { ...args, channel: '#other' }, d)).rejects.toThrow(/unexpected argument: channel/)
    expect(d.authorCron).not.toHaveBeenCalled()
  })

  it('refuses every other coordinate the model might reach for', async () => {
    const d = deps()
    for (const stray of ['thread', 'integrationId', 'platform', 'agentId', 'id']) {
      await expect(scheduleCron(ctx, { ...args, [stray]: 'x' }, d)).rejects.toThrow(
        new RegExp(`unexpected argument: ${stray}`)
      )
    }
    expect(d.authorCron).not.toHaveBeenCalled()
  })

  it('refuses a session with no conversation to fire into', async () => {
    const d = deps()
    const headless: SessionContext = { ...ctx, integrationId: undefined }
    await expect(scheduleCron(headless, args, d)).rejects.toThrow(/no platform integration|no conversation/)
    expect(d.authorCron).not.toHaveBeenCalled()
  })

  it('carries the CP’s refusal back to the agent verbatim', async () => {
    const d = deps()
    d.authorCron.mockImplementation(async () => {
      throw Object.assign(new Error('that schedule never fires — pick one that occurs'), { code: 'BAD_PAYLOAD' })
    })
    await expect(scheduleCron(ctx, args, d)).rejects.toThrow(/never fires/)
  })
})
