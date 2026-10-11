/**
 * `cron/author` (D→C REQ) — the fence, the idempotency, and the refusals.
 *
 * The three that would be silent if wrong: a daemon that does not serve the agent writes
 * nothing; a retried REQ answers the same cron; a timezone that is a fixed offset, or
 * absent, is refused rather than defaulted.
 */
import { randomUUID } from 'node:crypto'
import type { AnyFrame } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleCronAuthor } from './cron-author.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const INTEGRATION = 'e1e1e1e1-eeee-4eee-8eee-eeeeeeeeeeee'
const ORG = 'org-a'

const authorPayload = {
  requestId: '33333333-3333-4333-8333-333333333333',
  agentId: AGENT,
  schedule: '30 6 * * *',
  timezone: 'Asia/Ho_Chi_Minh',
  trigger: 'chào cả nhà',
  target: { platform: 'telegram', channel: '-100123', integrationId: INTEGRATION }
}

function fakeConn() {
  return {
    daemonId: DAEMON_ID,
    orgId: ORG,
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}

function authorFrame(payload: Record<string, unknown> = {}): AnyFrame {
  return {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'cron/author',
    orgId: ORG,
    payload: { ...authorPayload, ...payload }
  } as AnyFrame
}

function deps(over: Partial<Record<string, unknown>> = {}) {
  const rows = new Map<string, Record<string, unknown>>()
  const base = {
    rows,
    audit: { append: vi.fn(async () => ({}) as never), recent: vi.fn(async () => []) },
    cron: {
      get: vi.fn(async (_org: string, id: string) => (rows.get(id) as never) ?? null),
      upsert: vi.fn(async (input: Record<string, unknown>) => {
        const row = {
          id: input.cronId,
          orgId: ORG,
          agentId: AGENT,
          name: input.name ?? null,
          schedule: input.schedule,
          timezone: input.timezone,
          targetPlatform: input.targetPlatform,
          targetChannel: input.targetChannel,
          targetIntegrationId: input.targetIntegrationId,
          trigger: input.trigger,
          enabled: true
        }
        rows.set(input.cronId as string, row)
        return row as never
      })
    },
    agent: { get: vi.fn(async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON_ID }) as never) },
    integration: {
      get: vi.fn(async () => ({ id: INTEGRATION, orgId: ORG, agentId: AGENT, platform: 'telegram' }) as never)
    },
    placementResolver: { mayAct: vi.fn(async () => true) },
    agentDelivery: { cronUpsert: vi.fn(async () => undefined) },
    recomputeDuties: vi.fn(),
    log: { error: vi.fn() }
  }
  return { ...base, ...over }
}

const asDeps = (d: ReturnType<typeof deps>) => d as unknown as DaemonWsDeps

describe('handleCronAuthor', () => {
  it('authors the cron and answers with the id it minted and the next fire time', async () => {
    const d = deps()
    const conn = fakeConn()

    await handleCronAuthor(authorFrame(), conn, asDeps(d))

    const [frame, type, payload] = conn.replyTo.mock.calls[0]!
    expect(type).toBe('cron/author/ok')
    expect(frame.type).toBe('cron/author')
    expect(payload.cronId).toMatch(/^[0-9a-f-]{36}$/)
    // 06:30 in Ho Chi Minh is 23:30Z the day before — the zone really was applied.
    expect(new Date(payload.nextRun).getUTCHours()).toBe(23)
    expect(new Date(payload.nextRun).getUTCMinutes()).toBe(30)
    expect(d.agentDelivery.cronUpsert).toHaveBeenCalledTimes(1)
    expect(d.recomputeDuties).toHaveBeenCalledWith(ORG)
    expect(d.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cron_change', frameType: 'cron/author', agentId: AGENT })
    )
    // The creator is the agent, not a human: an absent id is what renders "—" in the console.
    const written = d.cron.upsert.mock.calls[0]![0]
    expect(written.createdByUserId).toBeUndefined()
    expect(written.lastModifiedByUserId).toBeUndefined()
    expect(written.targetPlatform).toBe('telegram')
    expect(written.enabled).toBe(true)
  })

  it('a daemon that does not serve the agent writes no row', async () => {
    const d = deps({ placementResolver: { mayAct: vi.fn(async () => false) } })
    const conn = fakeConn()

    await handleCronAuthor(authorFrame(), conn, asDeps(d))

    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
    expect(d.cron.upsert).not.toHaveBeenCalled()
    expect(d.agentDelivery.cronUpsert).not.toHaveBeenCalled()
    expect(d.audit.append).not.toHaveBeenCalled()
  })

  it('a repeated requestId answers the same cron, from the stored row, and writes nothing', async () => {
    const d = deps()
    const conn = fakeConn()
    const requestId = randomUUID()

    await handleCronAuthor(authorFrame({ requestId }), conn, asDeps(d))
    const first = conn.replyTo.mock.calls[0]![2].cronId
    // A retry that carries a DIFFERENT body must not rewrite what the first call authored.
    await handleCronAuthor(authorFrame({ requestId, schedule: '0 0 1 1 *' }), conn, asDeps(d))

    expect(conn.replyTo.mock.calls[1]![2].cronId).toBe(first)
    expect(conn.replyTo.mock.calls[1]![2].schedule).toBe('30 6 * * *')
    expect(d.cron.upsert).toHaveBeenCalledTimes(1)
    expect(d.agentDelivery.cronUpsert).toHaveBeenCalledTimes(1)
  })

  it('a different requestId is a different cron', async () => {
    const d = deps()
    const conn = fakeConn()

    await handleCronAuthor(authorFrame(), conn, asDeps(d))
    await handleCronAuthor(authorFrame({ requestId: randomUUID() }), conn, asDeps(d))

    expect(conn.replyTo.mock.calls[1]![2].cronId).not.toBe(conn.replyTo.mock.calls[0]![2].cronId)
    expect(d.cron.upsert).toHaveBeenCalledTimes(2)
  })

  it('refuses a fixed-offset timezone, a bad expression, and a schedule that never fires', async () => {
    const conn = fakeConn()
    for (const payload of [
      { timezone: '+07:00' },
      { timezone: 'Not/AZone' },
      { schedule: 'not a cron' },
      { schedule: '0 0 30 2 *' } // February 30th — croner's nextRun() answers null
    ]) {
      const d = deps()
      await handleCronAuthor(authorFrame(payload), conn, asDeps(d))
      const [corr, code, , retryable] = conn.sendError.mock.calls.at(-1)!
      expect(corr).toEqual(expect.any(String))
      expect(code).toBe('BAD_PAYLOAD')
      expect(retryable).toBe(false)
      expect(d.cron.upsert).not.toHaveBeenCalled()
    }
  })

  it('drops an org-less frame rather than guessing one', async () => {
    const d = deps()
    const conn = fakeConn()

    const frame = { ...authorFrame(), orgId: undefined } as AnyFrame
    await handleCronAuthor(frame, { ...conn, orgId: undefined } as unknown as DaemonConnection, asDeps(d))

    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', 'organization is required', false)
  })

  it('refuses an unknown agent', async () => {
    const d = deps({ agent: { get: vi.fn(async () => null) } })
    const conn = fakeConn()

    await handleCronAuthor(authorFrame(), conn, asDeps(d))

    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', 'unknown agent', false)
  })

  it('refuses a target integration that is not this agent’s', async () => {
    for (const integration of [null, { id: INTEGRATION, orgId: ORG, agentId: 'other', platform: 'slack' }]) {
      const d = deps({ integration: { get: vi.fn(async () => integration as never) } })
      const conn = fakeConn()
      await handleCronAuthor(authorFrame(), conn, asDeps(d))
      expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'BAD_PAYLOAD', expect.any(String), false)
      expect(d.cron.upsert).not.toHaveBeenCalled()
    }
  })

  it('answers INTERNAL rather than closing the socket when a repo throws', async () => {
    const d = deps({
      cron: {
        get: vi.fn(async () => null),
        upsert: vi.fn(async () => {
          throw new Error('db down')
        })
      }
    })
    const conn = fakeConn()

    await expect(handleCronAuthor(authorFrame(), conn, asDeps(d))).resolves.toBeUndefined()

    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'INTERNAL', 'cron authoring failed', true)
    expect(conn.replyTo).not.toHaveBeenCalled()
  })
})
