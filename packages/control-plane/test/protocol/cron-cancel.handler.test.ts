/**
 * `cron/cancel` end to end: what `cron/author` wrote, the agent takes back.
 *
 * What only this level shows: the frame survives `FRAME_SCHEMAS` in both directions, the row is
 * really gone from `cron_def`, the `cron/remove` the Scheduler disarms from reached the owning
 * daemon, and the audit row distinguishes this from an operator's delete. The authority fence is
 * covered over fakes in the unit test; nothing here repeats it.
 */
import { randomUUID } from 'node:crypto'
import { isFrame } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const BOT = 'b1b1b1b1-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INTEGRATION = 'e1e1e1e1-eeee-4eee-8eee-eeeeeeeeeeee'
const AUTH_ID = '99999999-9999-4999-8999-999999999999'
const REG_ID = '88888888-8888-4888-8888-888888888888'

async function ready(h: ReturnType<typeof buildWsHarness>) {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  await prisma.bot.create({
    data: { id: BOT, orgId: DEFAULT_ORG_ID, platform: 'telegram', name: 'greeter' }
  })
  await prisma.integration.create({
    data: {
      id: INTEGRATION,
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT,
      botId: BOT,
      platform: 'telegram',
      name: 'Greeter',
      status: 'active'
    }
  })
  const { stub } = h.connect()
  stub.inject('auth', { apiKey: await h.mintToken(DAEMON), daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
  await stub.expectFrame('auth/ok')
  stub.inject(
    'register',
    {
      host: 'host-1',
      capabilities: { platforms: ['telegram'], runtimes: ['claude'], acp: true, features: [] },
      maxAgents: 4,
      localState: {
        assignments: [],
        crons: [],
        leases: [],
        agents: [{ agentId: AGENT, origin: 'cp' as const }],
        integrations: [{ integrationId: INTEGRATION, origin: 'cp' as const, status: 'active' }],
        stagedAgents: []
      }
    },
    { id: REG_ID }
  )
  await stub.expectFrame('register/ok')
  // Both cron pushes are REQ→ack; the real daemon answers, so the harness must too or the
  // handler's `await` never settles.
  stub.respondTo('cron/upsert', () => ({ type: 'ack', payload: { ok: true } }))
  stub.respondTo('cron/remove', () => ({ type: 'ack', payload: { ok: true } }))
  return stub
}

/** Author one cron over the wire and return its id — the row a cancellation then retires. */
async function authorOne(stub: Awaited<ReturnType<typeof ready>>): Promise<string> {
  const id = stub.inject(
    'cron/author',
    {
      requestId: randomUUID(),
      agentId: AGENT,
      schedule: '30 6 * * *',
      timezone: 'Asia/Ho_Chi_Minh',
      trigger: 'chúc mọi người ăn trưa ngon miệng',
      target: {
        platform: 'telegram',
        channel: '-1001234567890',
        integrationId: INTEGRATION,
        thread: '6'
      }
    },
    { id: randomUUID(), orgId: DEFAULT_ORG_ID }
  )
  await stub.settled()
  const reply = stub.sent.find((f) => f.type === 'cron/author/ok' && f.corr === id)
  if (!reply || !isFrame('cron/author/ok')(reply)) throw new Error('expected a correlated cron/author/ok')
  return reply.payload.cronId
}

describe('cron/cancel over the real WS edge', () => {
  it('deletes the row, disarms the daemon with cron/remove, and audits the cancellation', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)
    const cronId = await authorOne(stub)
    expect(await prisma.cronDef.findUnique({ where: { id: cronId } })).not.toBeNull()

    const sentBefore = stub.sent.length
    const id = stub.inject('cron/cancel', { cronId, agentId: AGENT }, { id: randomUUID(), orgId: DEFAULT_ORG_ID })
    await stub.settled()

    const reply = stub.sent.slice(sentBefore).find((f) => f.type === 'cron/cancel/ok' && f.corr === id)
    if (!reply || !isFrame('cron/cancel/ok')(reply)) throw new Error('expected a correlated cron/cancel/ok')
    expect(reply.payload.removed).toBe(true)
    expect(reply.orgId).toBe(DEFAULT_ORG_ID)

    expect(await prisma.cronDef.findUnique({ where: { id: cronId } })).toBeNull()

    const removed = stub.sent.slice(sentBefore).find((f) => f.type === 'cron/remove')
    if (!removed || !isFrame('cron/remove')(removed)) throw new Error('expected a cron/remove push')
    expect(removed.payload.cronId).toBe(cronId)

    // Fire-and-forget: the append lands after the reply.
    await vi.waitFor(async () => {
      const audit = await prisma.auditEvent.findFirst({ where: { frameType: 'cron/cancel', agentId: AGENT } })
      expect(audit).toMatchObject({ kind: 'cron_change', orgId: DEFAULT_ORG_ID })
    })
  })

  it("leaves a human's schedule alone and keeps the row", async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)
    const cronId = await authorOne(stub)
    // The console stamps the operator; only that column separates their cron from the agent's.
    await prisma.cronDef.update({ where: { id: cronId }, data: { createdByUserId: DEFAULT_OWNER_ID } })

    const id = stub.inject('cron/cancel', { cronId, agentId: AGENT }, { orgId: DEFAULT_ORG_ID })
    await stub.settled()

    const reply = stub.sent.find((f) => f.type === 'cron/cancel/ok' && f.corr === id)
    if (!reply || !isFrame('cron/cancel/ok')(reply)) throw new Error('expected a correlated cron/cancel/ok')
    expect(reply.payload.removed).toBe(false)
    expect(await prisma.cronDef.findUnique({ where: { id: cronId } })).not.toBeNull()
  })

  it("answers removed:false for another agent's cron and touches nothing", async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)
    const cronId = await authorOne(stub)

    const id = stub.inject(
      'cron/cancel',
      { cronId, agentId: 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2' },
      { orgId: DEFAULT_ORG_ID }
    )
    await stub.settled()

    const reply = stub.sent.find((f) => f.type === 'cron/cancel/ok' && f.corr === id)
    if (!reply || !isFrame('cron/cancel/ok')(reply)) throw new Error('expected a correlated cron/cancel/ok')
    expect(reply.payload.removed).toBe(false)
    expect(await prisma.cronDef.findUnique({ where: { id: cronId } })).not.toBeNull()
  })

  it('a daemon that does not serve the agent retires nothing', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)
    const cronId = await authorOne(stub)
    // Placement moves the agent to another daemon — one this connection is not.
    await seedDaemon(prisma, OTHER_DAEMON)
    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: OTHER_DAEMON } })

    const id = stub.inject('cron/cancel', { cronId, agentId: AGENT }, { orgId: DEFAULT_ORG_ID })
    await stub.settled()

    const reply = stub.sent.find((f) => f.type === 'cron/cancel/ok' && f.corr === id)
    if (!reply || !isFrame('cron/cancel/ok')(reply)) throw new Error('expected a correlated cron/cancel/ok')
    expect(reply.payload.removed).toBe(false)
    expect(await prisma.cronDef.findUnique({ where: { id: cronId } })).not.toBeNull()
  })
})
