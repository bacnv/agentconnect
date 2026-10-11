/**
 * `CpClient.authorCron` — the D→C authoring call.
 *
 * What matters here is the failure surface. A CP refusal must reach the agent as its own
 * message, because the agent repairs its schedule and retries in the same turn — a swallowed
 * refusal becomes a timeout the agent cannot act on. And a disconnected client must refuse
 * locally rather than hang.
 */
import { describe, it, expect } from 'vitest'
import { buildEnvelope } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const INTEGRATION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'
const ORG = 'org-a'
const tick = () => new Promise((r) => setImmediate(r))

const payload = {
  requestId: '33333333-3333-4333-8333-333333333333',
  agentId: AGENT,
  schedule: '30 6 * * *',
  timezone: 'Asia/Ho_Chi_Minh',
  trigger: 'chào cả nhà',
  target: { platform: 'telegram' as const, channel: '-100123', integrationId: INTEGRATION }
}

async function ready() {
  const t = new FakeTransport()
  const clock = new FakeClock()
  const deps = {
    url: 'wss://cp.example.test/daemon/ws',
    token: 't',
    daemonId: DAEMON_ID,
    agentVersion: '0.0.0',
    host: 'h',
    heartbeatDefaultMs: 15_000,
    maxAgents: 4,
    capabilities: () => ({ platforms: [], runtimes: [], acp: true, features: [] }),
    runtimeProfiles: () => [],
    localState: () => ({ assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }),
    loadSnapshot: () => ({ cpu: 0, mem: 0, agents: 0 }),
    activeSessions: () => 0,
    orgForAgent: (agentId: string) => (agentId === AGENT ? ORG : undefined),
    orgForCron: () => undefined,
    configApply: {
      applyConfigPush() {},
      applyReconcileSnapshot() {},
      applyDutyGrant() {},
      applyDutyRevoke() {},
      upsertCron() {},
      removeCron() {},
      runCron: () => ({ ok: true }),
      applyRouteAssign() {},
      applyRouteUpdate() {}
    },
    clock,
    connect: async () => t,
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    jitter: () => 0
  } as unknown as CpClientDeps
  const client = new CpClient(deps)
  client.start()
  await tick()
  const auth = t.lastSent()
  t.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'auth/ok',
        {
          daemonId: DAEMON_ID,
          sessionEpoch: 1,
          heartbeatSec: 15,
          dutyLeaseMs: 120_000,
          serverTime: '2026-08-14T00:00:00.000Z',
          organizationMode: 'connection'
        },
        { corr: auth.id }
      )
    )
  )
  await tick()
  const reg = t.lastSent()
  t.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'register/ok',
        {
          routingEpoch: 1,
          serverFeatures: ['agent-cron-author-v1'],
          assignments: [],
          crons: [],
          leases: [],
          drop: { assignments: [], crons: [] }
        },
        { corr: reg.id }
      )
    )
  )
  await tick()
  return { client, t }
}

const sent = (t: FakeTransport) => t.sent.map((raw) => JSON.parse(raw))

describe('CpClient.authorCron', () => {
  it('sends the frame scoped to the agent org and resolves the reply', async () => {
    const { client, t } = await ready()
    const call = client.authorCron(payload)
    await tick()

    const req = sent(t).find((f) => f.type === 'cron/author')!
    expect(req.orgId).toBe(ORG)
    expect(req.payload.target.channel).toBe('-100123')
    expect(req.payload.requestId).toBe(payload.requestId)

    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'cron/author/ok',
          {
            cronId: '55555555-5555-4555-8555-555555555555',
            schedule: '30 6 * * *',
            timezone: 'Asia/Ho_Chi_Minh',
            nextRun: '2026-09-26T23:30:00.000Z'
          },
          { corr: req.id }
        )
      )
    )
    await expect(call).resolves.toMatchObject({ cronId: '55555555-5555-4555-8555-555555555555' })
    await expect(call).resolves.toMatchObject({ nextRun: '2026-09-26T23:30:00.000Z' })
  })

  it('surfaces a CP refusal as its own error, not as a timeout', async () => {
    const { client, t } = await ready()
    const call = client.authorCron(payload)
    await tick()
    const req = sent(t).find((f) => f.type === 'cron/author')!

    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'error',
          { code: 'BAD_PAYLOAD', message: 'that schedule never fires — pick one that occurs', retryable: false },
          { corr: req.id }
        )
      )
    )
    await expect(call).rejects.toMatchObject({ code: 'BAD_PAYLOAD', message: expect.stringContaining('never fires') })
  })

  it('refuses locally when the control plane is not connected', async () => {
    const { client } = await ready()
    client.stop()
    await expect(client.authorCron(payload)).rejects.toThrow(/unreachable|cron\/author/)
  })

  it('refuses a reply of the wrong type', async () => {
    const { client, t } = await ready()
    const call = client.authorCron(payload)
    await tick()
    const req = sent(t).find((f) => f.type === 'cron/author')!

    t.pushInbound(JSON.stringify(buildEnvelope('ack', { ok: true }, { corr: req.id })))
    await expect(call).rejects.toMatchObject({ message: expect.stringContaining('expected cron/author/ok') })
  })
})
