/**
 * `cancelCron` — the model names the cron, the session names the agent.
 *
 * The load-bearing property is that `agentId` comes from trusted context, never from the call:
 * a model that could name the agent could retire a colleague's schedule. The CP re-reads the
 * stored row for the real authority check, so the second property is that a refusal comes back
 * as a reportable answer rather than an exception.
 */
import { describe, it, expect, vi } from 'vitest'
import type { CronCancel } from '@agentconnect.md/protocol'
import { cancelCron } from '../src/mcp/ops/cron.js'
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

const CRON = '55555555-5555-4555-8555-555555555555'

function deps(removed = true) {
  const seen: CronCancel[] = []
  const cancelCronFn = vi.fn(async (req: CronCancel) => {
    seen.push(req)
    return { removed }
  })
  return { seen, cancelCron: cancelCronFn }
}

describe('cancelCron', () => {
  it('takes the agent from the session, the cron from the model', async () => {
    const d = deps()
    const result = await cancelCron(ctx, { cronId: CRON }, d)

    expect(d.seen).toEqual([{ cronId: CRON, agentId: ctx.agentId }])
    expect(result).toEqual({ removed: true, cronId: CRON })
  })

  it('refuses an agentId the model tries to supply', async () => {
    const d = deps()
    await expect(cancelCron(ctx, { cronId: CRON, agentId: 'someone-else' }, d)).rejects.toThrow(
      /unexpected argument: agentId/
    )
    expect(d.cancelCron).not.toHaveBeenCalled()
  })

  it('refuses a missing cronId before reaching the control plane', async () => {
    const d = deps()
    await expect(cancelCron(ctx, {}, d)).rejects.toThrow(/missing required string argument: cronId/)
    expect(d.cancelCron).not.toHaveBeenCalled()
  })

  it('reports a refusal as an answer, not a thrown error', async () => {
    // "not yours" and "no such cron" are the same reply from the CP, and both are things the
    // agent should say out loud — a rejection would read to the model as a broken tool.
    const d = deps(false)
    const result = await cancelCron(ctx, { cronId: CRON }, d)

    expect(result).toMatchObject({ removed: false, cronId: CRON })
    expect((result as { reason: string }).reason).toMatch(/belongs to you/)
  })

  it('refuses when the environment has no connected control plane', async () => {
    await expect(cancelCron(ctx, { cronId: CRON }, {})).rejects.toThrow(/not available in this environment/)
  })
})

describe('the cancelCron descriptor', () => {
  it('tells the model it cannot cancel a cron a person set up', () => {
    const tool = toolsForIntegrations([], { cronCancel: true }).find((t) => t.name === 'cancelCron')!
    expect(tool.description).toMatch(/only cancel crons you created/i)
    expect(tool.description).toMatch(/not.*error/i)
  })
})
