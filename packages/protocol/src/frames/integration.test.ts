import { describe, expect, it } from 'vitest'
import { IntegrationChannel, IntegrationCoreEnvelope } from './integration.js'

describe('IntegrationCoreEnvelope fences', () => {
  it('parses the bare-string fence every existing producer sends', () => {
    const core = IntegrationCoreEnvelope.parse({ mutedChannels: ['C1'], affinityDenied: ['C2'] })
    expect(core.mutedChannels).toEqual(['C1'])
    expect(core.affinityDenied).toEqual(['C2'])
    expect(core.overriddenThreads).toEqual([])
  })

  it('parses a thread-shaped fence and keeps both parts', () => {
    const core = IntegrationCoreEnvelope.parse({
      mutedChannels: [{ channel: 'C1', thread: 'T1' }],
      overriddenThreads: [{ channel: 'C1', thread: 'T1' }]
    })
    expect(core.mutedChannels).toEqual([{ channel: 'C1', thread: 'T1' }])
    expect(core.overriddenThreads).toEqual([{ channel: 'C1', thread: 'T1' }])
  })

  it('rejects a fence ref that names no thread rather than reading it as channel-wide', () => {
    expect(IntegrationCoreEnvelope.safeParse({ overriddenThreads: [{ channel: 'C1' }] }).success).toBe(false)
    expect(IntegrationCoreEnvelope.safeParse({ overriddenThreads: [{}] }).success).toBe(false)
  })

  it("emits exactly today's JSON for an integration with no topics", () => {
    expect(IntegrationCoreEnvelope.parse({ mode: 'direct', bindRules: [], gated: false })).toEqual({
      mode: 'direct',
      bindRules: [],
      mutedChannels: [],
      affinityDenied: [],
      overriddenThreads: [],
      gated: false
    })
  })
})

describe('IntegrationChannel.threads', () => {
  it('carries a named topic and a nameless one', () => {
    const channel = IntegrationChannel.parse({
      id: '-100',
      threads: [{ id: '7', name: 'Deploys' }, { id: '9' }]
    })
    expect(channel.threads).toEqual([{ id: '7', name: 'Deploys' }, { id: '9' }])
  })

  it('leaves threads absent on a conversation that reports none', () => {
    expect(IntegrationChannel.parse({ id: '-100' }).threads).toBeUndefined()
  })
})
