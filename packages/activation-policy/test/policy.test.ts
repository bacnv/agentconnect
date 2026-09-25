import { describe, expect, it } from 'vitest'
import { MAX_AGENT_CALL_HOPS } from '@agentconnect.md/protocol'
import {
  conversationAdmitsAgent,
  conversationPeers,
  hopTransition,
  isUsableSourceDepth,
  participantAgents,
  routeRules,
  type ActivationMessageFacts,
  type ActivationRule
} from '../src/index.js'

// The deep ladder behavior is pinned where it always was — the daemon's
// router suites (route-rules/router/telegram-threading, consuming this
// package through the routing-table adapter) and the cross-surface parity
// suite (evals/parity). These tests cover the package's own contract: the
// composed selectors and gates the daemon call sites now delegate to.

const msg = (over: Partial<ActivationMessageFacts> = {}): ActivationMessageFacts => ({
  platform: 'slack',
  channel: 'C1',
  text: 'hello',
  isDm: false,
  mentionedBots: [],
  sender: { isBot: false },
  ...over
})

const rule = (over: Partial<ActivationRule> = {}): ActivationRule => ({
  agentId: 'a1',
  integrationId: 'i1',
  botUserId: 'U1',
  scope: {},
  match: { kind: 'mention' },
  source: 'config',
  ...over
})

describe('routeRules (ladder smoke — deep coverage lives in the daemon suites)', () => {
  it('kind precedence: mention > dm > keyword > auto', () => {
    const rules = [
      rule({ agentId: 'auto', match: { kind: 'auto' } }),
      rule({ agentId: 'kw', match: { kind: 'keyword', value: 'deploy' } }),
      rule({ agentId: 'named', match: { kind: 'mention' }, botUserId: 'U9' })
    ]
    expect(routeRules(msg({ mentionedBots: ['U9'], text: 'deploy <@U9>' }), rules, () => null)).toMatchObject({
      agentId: 'named',
      via: 'mention'
    })
    expect(routeRules(msg({ text: 'please deploy now' }), rules, () => null)).toMatchObject({
      agentId: 'kw',
      via: 'keyword'
    })
    expect(routeRules(msg(), rules, () => null)).toMatchObject({ agentId: 'auto', via: 'auto' })
  })

  it('excludes a verified agent author from every rung', () => {
    const rules = [
      rule({ agentId: 'author', match: { kind: 'auto' } }),
      rule({ agentId: 'peer', match: { kind: 'auto' } })
    ]
    const routed = routeRules(msg({ sender: { isBot: true } }), rules, () => null, undefined, 'author')
    expect(routed).toMatchObject({ agentId: 'peer' })
  })

  it('unverified bot traffic stops after the explicit-mention rung', () => {
    const rules = [rule({ agentId: 'a1', match: { kind: 'auto' } })]
    expect(routeRules(msg({ sender: { isBot: true } }), rules, () => null)).toBeNull()
  })
})

describe('conversationAdmitsAgent (the Off/gated fence predicate)', () => {
  const rules = [
    rule({ agentId: 'a1', scope: { channel: 'C1' } }),
    rule({ agentId: 'a2', mutedChannels: ['C1'] }),
    rule({ agentId: 'a3', scope: { channel: 'C2' } })
  ]
  it('admits an agent whose rule covers the channel', () => {
    expect(conversationAdmitsAgent(rules, 'a1', 'C1')).toBe(true)
  })
  it('refuses a muted channel outright', () => {
    expect(conversationAdmitsAgent(rules, 'a2', 'C1')).toBe(false)
  })
  it('refuses a channel no rule covers, and an unknown agent', () => {
    expect(conversationAdmitsAgent(rules, 'a3', 'C1')).toBe(false)
    expect(conversationAdmitsAgent(rules, 'missing', 'C1')).toBe(false)
  })
})

describe('hop gates (§4.1)', () => {
  it('isUsableSourceDepth fails closed on missing / non-integer / negative depths', () => {
    expect(isUsableSourceDepth(undefined)).toBe(false)
    expect(isUsableSourceDepth(-1)).toBe(false)
    expect(isUsableSourceDepth(0.5)).toBe(false)
    expect(isUsableSourceDepth(0)).toBe(true)
    expect(isUsableSourceDepth(MAX_AGENT_CALL_HOPS)).toBe(true) // usable; the TRANSITION refuses it
  })

  it('hopTransition charges exactly +1 and refuses at the shared cap', () => {
    expect(hopTransition(0)).toEqual({ deliveryHopCount: 1 })
    expect(hopTransition(MAX_AGENT_CALL_HOPS - 2)).toEqual({ deliveryHopCount: MAX_AGENT_CALL_HOPS - 1 })
    expect(hopTransition(MAX_AGENT_CALL_HOPS - 1)).toEqual({
      deliveryHopCount: MAX_AGENT_CALL_HOPS,
      refusal: { reason: 'hop_limit', cap: MAX_AGENT_CALL_HOPS }
    })
  })
})

describe('conversationPeers (§2.3/§6 delivery selection)', () => {
  const rules = [
    rule({ agentId: 'p1' }),
    rule({ agentId: 'p2' }),
    rule({ agentId: 'named', botUserId: 'U9' }),
    rule({ agentId: 'auto', match: { kind: 'auto' } }),
    rule({ agentId: 'author', match: { kind: 'auto' } })
  ]

  it('unions participants, explicit joins, and channel-auto — in that insertion order', () => {
    const { peers, explicitlyMentioned } = conversationPeers(
      msg({ thread: 't1', mentionedBots: ['U9'] }),
      rules,
      ['p1', 'p2'],
      {}
    )
    expect(peers).toEqual(['p1', 'p2', 'named', 'auto', 'author'])
    expect([...explicitlyMentioned]).toEqual(['named'])
  })

  it('excludes the primary everywhere', () => {
    const { peers } = conversationPeers(msg({ thread: 't1', mentionedBots: ['U9'] }), rules, ['p1', 'p2'], {
      primaryAgentId: 'p1'
    })
    expect(peers).toEqual(['p2', 'named', 'auto', 'author'])
  })

  it('a verified agent call joins the exact resolved recipients and excludes the author absolutely', () => {
    const { peers, explicitlyMentioned } = conversationPeers(msg({ thread: 't1' }), rules, ['p1', 'author'], {
      verified: { authorAgentId: 'author', recipients: ['p2', 'author'] }
    })
    // p2 joined via the verified recipient set even with no provider mention;
    // the author never appears, not even via its own recipients entry.
    expect(peers).toEqual(['p1', 'p2', 'auto'])
    expect(explicitlyMentioned.has('p2')).toBe(true)
    expect(peers).not.toContain('author')
  })

  it('an unserved participant (no rule in scope) is not revived', () => {
    const { peers } = conversationPeers(
      msg({ channel: 'C1', thread: 't1' }),
      [rule({ agentId: 'p1' })],
      ['p1', 'ghost'],
      {}
    )
    expect(peers).toEqual(['p1'])
  })
})

describe('affinityDenied (the explicit-address fence)', () => {
  // The rule shape the CP actually compiles for this trigger: the unscoped mention
  // default, carrying the fence. `match.kind` stays 'mention' — a rule with kind
  // 'auto' would join every agent through `automaticAgents` regardless of the fence,
  // which is what `any` means and is NOT what this trigger means.
  const fenced = (agentId: string, over: Partial<ActivationRule> = {}) =>
    rule({ agentId, match: { kind: 'mention' }, botUserId: `B-${agentId}`, affinityDenied: ['C1'], ...over })

  it('denies an unaddressed message to the thread owner', () => {
    // The regression this whole change exists for: today affinity delivers this.
    const rules = [fenced('a1')]
    expect(routeRules(msg({ thread: 't1' }), rules, () => 'a1')).toBeNull()
  })

  it('admits a reply to the owner', () => {
    const rules = [fenced('a1')]
    expect(routeRules(msg({ thread: 't1', replyToAuthor: 'a1' }), rules, () => 'a1')).toMatchObject({
      agentId: 'a1',
      via: 'thread'
    })
  })

  it('routes a reply to a different agent to nobody', () => {
    // A reply is an address to ONE agent; the owner must not inherit it.
    const rules = [fenced('a1')]
    expect(routeRules(msg({ thread: 't1', replyToAuthor: 'a2' }), rules, () => 'a1')).toBeNull()
  })

  it('still routes an @-mention — the fence is not Off', () => {
    // Rung 1 never consults continuityAdmits, which is exactly why this trigger is
    // not `off`.
    const rules = [fenced('a1', { botUserId: 'U1' })]
    expect(routeRules(msg({ mentionedBots: ['U1'] }), rules, () => null)).toMatchObject({
      agentId: 'a1',
      via: 'mention'
    })
  })

  it('leaves an unfenced channel alone', () => {
    const rules = [rule({ agentId: 'a1' })]
    expect(routeRules(msg({ thread: 't1' }), rules, () => 'a1')).toMatchObject({ agentId: 'a1', via: 'thread' })
  })

  it('denies participants without a reply, and admits the reply author', () => {
    const rules = [fenced('a1'), fenced('a2')]
    expect(participantAgents(msg({ thread: 't1' }), rules, ['a1', 'a2'])).toEqual([])
    expect(participantAgents(msg({ thread: 't1', replyToAuthor: 'a1' }), rules, ['a1', 'a2'])).toEqual(['a1'])
  })

  it('the multi-agent case routes through participants alone', () => {
    // `threadOwner` returns null when 2+ agents share a thread, so rung 2 delivers
    // nothing and `participantAgents` is the ONLY path — a single-agent test misses it.
    const rules = [fenced('a1'), fenced('a2')]
    const peers = conversationPeers(msg({ thread: 't1', replyToAuthor: 'a1' }), rules, ['a1', 'a2'])
    expect(peers.peers).toEqual(['a1'])
    expect(routeRules(msg({ thread: 't1', replyToAuthor: 'a1' }), rules, () => null)).toBeNull()
  })

  it('does not revive a dormant owner', () => {
    // `threadOwner` falls back to `closedSessionAgents`, so the fence has to deny what
    // it returns rather than check liveness itself.
    const rules = [fenced('a1')]
    expect(routeRules(msg({ thread: 't1' }), rules, () => 'a1')).toBeNull()
  })

  it('leaves the verified-agent delivery gate unchanged', () => {
    // conversationAdmitsAgent reproduces OFF, not this trigger: an agent delivery is
    // explicit by construction and must keep reaching a fenced conversation.
    const rules = [fenced('a1')]
    expect(conversationAdmitsAgent(rules, 'a1', 'C1')).toBe(true)
  })
})
