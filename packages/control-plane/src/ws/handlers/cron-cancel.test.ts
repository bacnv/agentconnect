/**
 * `cron/cancel` (D→C REQ) — who may retire a cron, and what happens to a human's.
 *
 * The load-bearing assertion is the one that would be silent if wrong: an agent retires what it
 * authored and NEVER a schedule a human owns. The rest is the live seam, which mirrors
 * `cron/author` so a daemon cannot retire for an agent it does not serve.
 */
import { randomUUID } from 'node:crypto'
import type { AnyFrame } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleCronCancel } from './cron-cancel.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const OTHER_AGENT = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2'
const ORG = 'org-a'
const CRON = 'c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5'

function fakeConn() {
  return {
    daemonId: DAEMON_ID,
    orgId: ORG,
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}

function cancelFrame(payload: Record<string, unknown> = {}): AnyFrame {
  return {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'cron/cancel',
    orgId: ORG,
    payload: { cronId: CRON, agentId: AGENT, ...payload }
  } as AnyFrame
}

/** A stored row; `createdByUserId` absent is the agent-authored case (see `cron-author.ts`). */
const authoredRow = { id: CRON, orgId: ORG, agentId: AGENT, createdByUserId: null }

function deps(row: Record<string, unknown> | null = authoredRow, over: Partial<Record<string, unknown>> = {}) {
  const base = {
    cron: {
      get: vi.fn(async () => row as never),
      remove: vi.fn(async () => true)
    },
    agent: { get: vi.fn(async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON_ID }) as never) },
    placementResolver: { mayAct: vi.fn(async () => true) },
    agentDelivery: { cronRemove: vi.fn(async () => undefined) },
    audit: { append: vi.fn(async () => ({}) as never), recent: vi.fn(async () => []) },
    recomputeDuties: vi.fn(),
    log: { error: vi.fn() }
  }
  return { ...base, ...over }
}

const asDeps = (d: ReturnType<typeof deps>) => d as unknown as DaemonWsDeps

describe('handleCronCancel', () => {
  it('retires an agent-authored cron: removes the row, pushes cron/remove, audits under cron/cancel', async () => {
    const d = deps()
    const conn = fakeConn()

    await handleCronCancel(cancelFrame(), conn, asDeps(d))

    expect(conn.replyTo).toHaveBeenCalledWith(expect.objectContaining({ type: 'cron/cancel' }), 'cron/cancel/ok', {
      removed: true
    })
    expect(d.cron.remove).toHaveBeenCalledWith(ORG, CRON, AGENT)
    expect(d.agentDelivery.cronRemove).toHaveBeenCalledTimes(1)
    expect(d.recomputeDuties).toHaveBeenCalledWith(ORG)
    expect(d.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cron_change', frameType: 'cron/cancel', agentId: AGENT })
    )
  })

  it("refuses a HUMAN's schedule, and touches nothing", async () => {
    const d = deps({ ...authoredRow, createdByUserId: 'u1' })
    const conn = fakeConn()

    await handleCronCancel(cancelFrame(), conn, asDeps(d))

    expect(conn.replyTo.mock.calls[0]![2]).toEqual({ removed: false })
    expect(d.cron.remove).not.toHaveBeenCalled()
    expect(d.agentDelivery.cronRemove).not.toHaveBeenCalled()
    expect(d.audit.append).not.toHaveBeenCalled()
  })

  it("refuses another agent's cron", async () => {
    const d = deps({ ...authoredRow, agentId: OTHER_AGENT })
    const conn = fakeConn()

    await handleCronCancel(cancelFrame(), conn, asDeps(d))

    expect(conn.replyTo.mock.calls[0]![2]).toEqual({ removed: false })
    expect(d.cron.remove).not.toHaveBeenCalled()
  })

  it('answers removed:false for an unknown cron rather than an error', async () => {
    const d = deps(null)
    const conn = fakeConn()

    await handleCronCancel(cancelFrame(), conn, asDeps(d))

    expect(conn.replyTo.mock.calls[0]![2]).toEqual({ removed: false })
    expect(conn.sendError).not.toHaveBeenCalled()
  })

  it('a daemon that does not serve the agent retires nothing', async () => {
    const d = deps(authoredRow, { placementResolver: { mayAct: vi.fn(async () => false) } })
    const conn = fakeConn()

    await handleCronCancel(cancelFrame(), conn, asDeps(d))

    expect(conn.replyTo.mock.calls[0]![2]).toEqual({ removed: false })
    expect(d.cron.remove).not.toHaveBeenCalled()
  })

  it('a lost race answers removed:true — the cron is gone either way', async () => {
    const d = deps(authoredRow, {
      cron: { get: vi.fn(async () => authoredRow as never), remove: vi.fn(async () => false) }
    })
    const conn = fakeConn()

    await handleCronCancel(cancelFrame(), conn, asDeps(d))

    expect(conn.replyTo.mock.calls[0]![2]).toEqual({ removed: true })
    expect(d.agentDelivery.cronRemove).not.toHaveBeenCalled()
  })

  it('drops an org-less frame rather than guessing one', async () => {
    const d = deps()
    const conn = fakeConn()
    const frame = { ...cancelFrame(), orgId: undefined } as AnyFrame
    const unscoped = { ...conn, orgId: undefined } as unknown as DaemonConnection

    await handleCronCancel(frame, unscoped, asDeps(d))

    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
    expect(d.cron.remove).not.toHaveBeenCalled()
  })
})
