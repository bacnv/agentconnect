/**
 * `cron/author` end to end: a daemon handshake, then an authored cron.
 *
 * What only this level can show: the frame survives `FRAME_SCHEMAS` in both directions, the row
 * is a real `cron_def` with no human creator, the def reached the owning daemon as the
 * `cron/upsert` its Scheduler arms from, and the audit row tells this apart from an operator
 * write. The fence and the idempotency are covered by the unit test over fakes; nothing here
 * repeats them.
 */
import { randomUUID } from 'node:crypto'
import { isFrame } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
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
  // The live CRUD push is a REQ→ack; the real daemon answers, so the harness must too or the
  // handler's `await` never settles.
  stub.respondTo('cron/upsert', () => ({ type: 'ack', payload: { ok: true } }))
  return stub
}

function authorPayload(over: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    agentId: AGENT,
    name: 'greeting-lunch',
    schedule: '30 6 * * *',
    timezone: 'Asia/Ho_Chi_Minh',
    trigger: 'chúc mọi người ăn trưa ngon miệng',
    target: { platform: 'telegram', channel: '-1001234567890', integrationId: INTEGRATION },
    ...over
  }
}

describe('cron/author over the real WS edge', () => {
  it('writes a cron_def with no human creator, pushes cron/upsert down, and audits the author', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)
    const sentBefore = stub.sent.length

    const id = stub.inject('cron/author', authorPayload(), { id: randomUUID(), orgId: DEFAULT_ORG_ID })
    await stub.settled()

    const reply = stub.sent.slice(sentBefore).find((f) => f.type === 'cron/author/ok' && f.corr === id)
    if (!reply || !isFrame('cron/author/ok')(reply)) throw new Error('expected a correlated cron/author/ok')
    // 06:30 in Ho Chi Minh is 23:30Z the day before — the zone really was applied.
    expect(reply.payload.schedule).toBe('30 6 * * *')
    expect(reply.payload.timezone).toBe('Asia/Ho_Chi_Minh')
    expect(new Date(reply.payload.nextRun).getUTCHours()).toBe(23)
    expect(reply.orgId).toBe(DEFAULT_ORG_ID)

    const row = await prisma.cronDef.findUniqueOrThrow({ where: { id: reply.payload.cronId } })
    expect(row).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT,
      name: 'greeting-lunch',
      schedule: '30 6 * * *',
      timezone: 'Asia/Ho_Chi_Minh',
      targetPlatform: 'telegram',
      targetChannel: '-1001234567890',
      targetIntegrationId: INTEGRATION,
      enabled: true,
      createdByUserId: null,
      lastModifiedByUserId: null
    })

    // The def reached the daemon as the frame its Scheduler arms from.
    const pushed = stub.sent.slice(sentBefore).find((f) => f.type === 'cron/upsert')
    if (!pushed || !isFrame('cron/upsert')(pushed)) throw new Error('expected a cron/upsert push')
    expect(pushed.payload).toMatchObject({
      cronId: row.id,
      agentId: AGENT,
      schedule: '30 6 * * *',
      timezone: 'Asia/Ho_Chi_Minh',
      trigger: 'chúc mọi người ăn trưa ngon miệng',
      enabled: true,
      target: { platform: 'telegram', channel: '-1001234567890', integrationId: INTEGRATION }
    })

    // Fire-and-forget: the append lands after the reply.
    await vi.waitFor(async () => {
      const audit = await prisma.auditEvent.findFirst({ where: { frameType: 'cron/author', agentId: AGENT } })
      expect(audit).toMatchObject({ kind: 'cron_change', orgId: DEFAULT_ORG_ID })
    })
  })

  it('refuses a schedule that never fires, and writes no row', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)
    const before = await prisma.cronDef.count()

    const id = stub.inject('cron/author', authorPayload({ schedule: '0 0 30 2 *' }), { orgId: DEFAULT_ORG_ID })
    await stub.settled()

    const err = stub.sent.find((f) => f.type === 'error' && f.corr === id)
    if (!err || !isFrame('error')(err)) throw new Error('expected a correlated error')
    expect(err.payload).toMatchObject({ code: 'BAD_PAYLOAD', retryable: false })
    expect(err.payload.message).toMatch(/never fires/)
    expect(await prisma.cronDef.count()).toBe(before)
  })

  it('refuses a fixed-offset timezone', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)

    const id = stub.inject('cron/author', authorPayload({ timezone: '+07:00' }), { orgId: DEFAULT_ORG_ID })
    await stub.settled()

    const err = stub.sent.find((f) => f.type === 'error' && f.corr === id)
    if (!err || !isFrame('error')(err)) throw new Error('expected a correlated error')
    expect(err.payload.message).toMatch(/named IANA zone/)
  })

  it('a daemon that does not serve the agent writes no row', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)
    // Placement moves the agent to another daemon — one this connection is not.
    await seedDaemon(prisma, OTHER_DAEMON)
    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: OTHER_DAEMON } })
    const before = await prisma.cronDef.count()

    const id = stub.inject('cron/author', authorPayload(), { orgId: DEFAULT_ORG_ID })
    await stub.settled()

    const err = stub.sent.find((f) => f.type === 'error' && f.corr === id)
    if (!err || !isFrame('error')(err)) throw new Error('expected a correlated error')
    expect(err.payload).toMatchObject({ code: 'SCOPE_DENIED' })
    expect(await prisma.cronDef.count()).toBe(before)
  })

  it('a second requestId is a second cron', async () => {
    const h = buildWsHarness(prisma)
    const stub = await ready(h)

    stub.inject('cron/author', authorPayload(), { orgId: DEFAULT_ORG_ID })
    await stub.settled()
    stub.inject('cron/author', authorPayload({ schedule: '0 21 * * *' }), { orgId: DEFAULT_ORG_ID })
    await stub.settled()

    const rows = await prisma.cronDef.findMany({ where: { agentId: AGENT }, orderBy: { schedule: 'asc' } })
    expect(rows.map((r) => r.schedule)).toEqual(['0 21 * * *', '30 6 * * *'])
  })
})
