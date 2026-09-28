import { describe, expect, it } from 'vitest'
import { IntegrationChannel, IntegrationCoreEnvelope } from './integration.js'

describe('IntegrationCoreEnvelope fences', () => {
  it('parses the bare-string fence every existing producer sends', () => {
    const core = IntegrationCoreEnvelope.parse({ mutedChannels: ['C1'], affinityDenied: ['C2'] })
    expect(core.mutedChannels).toEqual(['C1'])
    expect(core.affinityDenied).toEqual(['C2'])
    expect(core.overriddenThreads).toEqual([])
  })

  it('parses a thread-shaped fence into its own field, leaving the channel-wide list alone', () => {
    const core = IntegrationCoreEnvelope.parse({
      mutedChannels: ['C1'],
      mutedThreads: [{ channel: 'C1', thread: 'T1' }],
      overriddenThreads: [{ channel: 'C1', thread: 'T1' }]
    })
    expect(core.mutedChannels).toEqual(['C1'])
    expect(core.mutedThreads).toEqual([{ channel: 'C1', thread: 'T1' }])
    expect(core.overriddenThreads).toEqual([{ channel: 'C1', thread: 'T1' }])
    // A producer that predates the thread halves still parses — they are optional.
    expect(IntegrationCoreEnvelope.parse({ mutedChannels: ['C1'] }).mutedThreads).toBeUndefined()
  })

  it('rejects a fence ref that names no thread rather than reading it as channel-wide', () => {
    expect(IntegrationCoreEnvelope.safeParse({ overriddenThreads: [{ channel: 'C1' }] }).success).toBe(false)
    expect(IntegrationCoreEnvelope.safeParse({ overriddenThreads: [{}] }).success).toBe(false)
    expect(IntegrationCoreEnvelope.safeParse({ mutedThreads: [{ channel: 'C1' }] }).success).toBe(false)
  })

  it("emits exactly today's JSON for an integration with no topics", () => {
    // The compat contract: absent thread halves must NOT materialize as `[]` on the wire,
    // or every integration would grow two keys for no reason.
    expect(IntegrationCoreEnvelope.parse({ mode: 'direct', bindRules: [], gated: false })).toEqual({
      mode: 'direct',
      bindRules: [],
      mutedChannels: [],
      affinityDenied: [],
      overriddenThreads: [],
      gated: false
    })
  })

  it('keeps a thread-shaped fence out of the channel-wide arrays an older daemon reads', () => {
    const core = IntegrationCoreEnvelope.parse({
      mutedChannels: ['C9'],
      mutedThreads: [{ channel: 'C1', thread: 'T1' }],
      affinityDeniedThreads: [{ channel: 'C1', thread: 'T1' }]
    })
    // The two originals are read by an older daemon as `z.array(z.string())`, and
    // `tolerantReader` relaxes a strict object but NOT an element type — so an object
    // reaching either array is a rejected handshake, not a stripped field.
    expect(core.mutedChannels.every((r) => typeof r === 'string')).toBe(true)
    expect(core.affinityDenied.every((r) => typeof r === 'string')).toBe(true)
    expect(core.mutedThreads).toEqual([{ channel: 'C1', thread: 'T1' }])
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
