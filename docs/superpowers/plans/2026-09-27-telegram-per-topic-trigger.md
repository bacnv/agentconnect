# A per-topic trigger for Telegram forum supergroups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Telegram forum topic carry its own trigger — `off` / `mention` / `mention_topic` / `any`, or inherit (the default) — so an operator can keep one topic loud in a quiet group and one topic quiet in a loud one.

**Architecture:** A message in a forum topic already carries the coordinate this needs: `msg.thread` IS the topic id, and `ActivationRule.scope.thread` has existed since the `mention_topic` work. So a thread-scoped positive rule is already expressible and already honoured; what is missing is the _subtractive_ half. `overriddenThreads` is a new fence on `IntegrationCoreEnvelope` meaning exactly one thing — _in this thread, nothing the enclosing channel states applies_ — and it is read inside the single scope predicate (`scopeMatches`) and the single continuity predicate (`continuityAdmits`) that every rung already passes through. The CP folds each topic row's trigger into that fence plus (for `any`, and for a gated integration) one thread-scoped rule; the daemon learns topics from the two sources Telegram actually offers and reports them on the conversation row it already reports.

**Tech Stack:** TypeScript, pnpm 11 workspaces, zod 4, Prisma 6 + Postgres, Vitest 5, Next.js 16 + React 19.

**Spec:** `docs/superpowers/specs/2026-09-27-telegram-per-topic-trigger-design.md` — read it before Task 1. This plan implements it, and was written against HEAD rather than the spec's own base, so a few of its line numbers and one call-site count differ; the Self-Review's §2 lists every difference and the task that owns it.

**Base:** branch `merged/v1.16.0-bacnv` (HEAD `788d851d`). Every line number below was read from that HEAD.

## Global Constraints

- **A topic that carries its own trigger ignores its group entirely.** Its own rules _and_ its group's fences. This is the feature; a plan that only adds positive rules has built nothing.
- **`overriddenThreads` is the only new fence.** No change to `mutedChannels`' or `affinityDenied`'s meaning — they widen from `string[]` to `ScopeRef[]` in TYPE ONLY, and the emitted JSON for an integration with no topic rows is byte-identical to today's. **(Corrected after review: the widening breaks an older daemon's handshake — `tolerantReader` relaxes a strict object but not an element type, so a thread-shaped element makes it reject the whole `register/ok`. Shipped instead as the optional sibling fields `mutedThreads`/`affinityDeniedThreads`, merged back into one list by `integrationCore`. See spec §4.)**
- **A rule scoped `{channel: C}` with no thread IS the channel's own statement** and does not match a message in an overridden thread of `C`. A rule that names **no** channel is never suppressed — that is what keeps the unscoped `mention`/`dm` defaults working in an overridden topic, and what makes a plain `mention` topic need no positive rule at all.
- **`comment style: one line`.** The repo's `CLAUDE.md` is explicit: do not write multiline comment blocks; when you touch code carrying a verbose comment, condense it to one line. Every comment shown below is already condensed — keep it that way.
- **Prettier:** no semicolons, single quotes, no trailing commas, 120 columns.
- **`mention_topic` must never appear in `mutedChannels`.** It is a delivery fence, and `mention_topic` admits @-mentions and agent deliveries by design. The topic fold keeps that rule too: a `mention_topic` topic contributes to `overriddenThreads` and `affinityDenied`, never to `mutedChannels`.
- **No Telegram API call may delete, close, or modify anything at Telegram.** Every Telegram call this change adds is a READ of an update Telegram already delivered.
- **Never run `docker compose down --volumes`.**
- **Migration timestamp is `20261012000000`** — verified free. The latest existing migration is `20261011000000_cron_target_thread`.
- **The `IntegrationChannelRecord` blast radius is six fixtures.** Adding `threads` to that interface breaks six factory literals (`placement.test.ts:105`, `httpBot.test.ts:115`, and the four providers' `provider.test.ts` at `slack:144`, `telegram:90`, `feishu:153`, `discord:94`). Task 6 gives the interface the field and fixes every literal in the same task.
- **Commit identity:** this clone has no `user.*` git config. Pass it per command: `git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit …`. Never write to git config.

## Review Focus

Five input classes and failure modes the spec implies but no task's own tests would otherwise exercise. Each one's test is added to the task that owns the code.

1. **A topic set to `mention` must NOT answer every message while its group is on `any`.** This is the whole feature and the exact case that a positive-rules-only design gets silently wrong: the group's channel-scoped `auto` rule matches every message in every topic, so a topic-level `mention` is a no-op without `overriddenThreads`. → Task 4, "a group's `auto` rule does not fire in an overridden thread", and Task 7, "an overridden topic in an `any` group still gets its own mention rule".
2. **A topic set to `off`/`any` inside a group set to `off` must still work.** `off` on the group compiles to `mutedChannels: ['C']` — channel-wide, so without effect 2 it silences the very topic the operator just opened. This is the one way to express "quiet group, one live topic". → Task 4, "a channel-wide mute does not silence an overridden thread, a thread-shaped one does", and Task 7, "an `off` group with an `any` topic".
3. **Removing a topic's trigger must return it to inheriting, with no residue.** The row survives (Telegram reports no deletion), so a cleared trigger has to leave no fence entry, no positive rule and no grant — otherwise the topic keeps behaving as if configured. → Task 7, "a cleared trigger is indistinguishable from one never set", Task 9, "a re-report preserves a stored trigger", and Task 22, "picking Follow group writes null".
4. **A topic whose group has one agent but whose `overriddenThreads` ref is malformed (an object where a string was expected) must not open the whole group.** The fence is the only thing standing between "this topic is special" and "every topic is special"; a ref that silently matches nothing turns every topic into an override. → Task 4, "an unrelated thread ref leaves the channel reachable" and Task 2, "the widened envelope still rejects a bare `{}`".
5. **A reply-thread root (`threadRoot`, `tg:<id>`) must never become a configurable topic.** A plain supergroup's reply roots are session coordinates, not conversations. If the daemon reports them as topics the console grows a disclosure with one row per reply chain. → Task 15, "a `threadRoot` message reports nothing".

---

## File Structure

**Modified — policy package (pure, no I/O):**

- `packages/activation-policy/src/index.ts` — `ScopeRef`/`ThreadRef` (re-exported from protocol), `overriddenThreads` on `ActivationRule`, the two fence fields widened, `refCovers`/`channelReaches`, the `own` guard in `scopeMatches`/`continuityAdmits`, `affinityAdmits` re-signed, `conversationAdmitsAgent` widened.
- `packages/activation-policy/test/policy.test.ts` — the ladder traps.

**Modified — wire contract:**

- `packages/protocol/src/frames/integration.ts` — `ScopeRef`, `ThreadRef`, `IntegrationChannelThread`, the three envelope fields, `threads` on `IntegrationChannel`.
- `packages/protocol/src/frames/integration.test.ts` — new; the frame had no test file.

**Modified — control plane:**

- `packages/control-plane/prisma/schema.prisma` — `IntegrationChannelThread` + the `threads` back-relation.
- `packages/control-plane/prisma/migrations/20261012000000_integration_channel_thread/migration.sql` — new.
- `packages/control-plane/src/persistence/ports.ts` — `IntegrationChannelThreadRecord`, `threads` on `IntegrationChannelRecord` and `ReportedChannel`, `setThreadTrigger` on the repo port.
- `packages/control-plane/src/persistence/repositories/integration.repo.ts` — thread upsert in `replaceSnapshot`, `toChannelRecord` loads threads, `setThreadTrigger`.
- `packages/control-plane/src/orchestrator/placement.ts` — the fold into all three fences plus the positive rules, gated and ungated.
- `packages/control-plane/src/orchestrator/placement.test.ts` — the fold, per §5's table.
- `packages/control-plane/src/orchestrator/httpBot.ts` + `httpBot.test.ts` — the `threads` literal in the fixture; no behaviour change.
- `packages/control-plane/src/platforms/{slack,telegram,feishu,discord}/provider.test.ts` — the `threads` literal in each fixture.
- `packages/control-plane/src/ws/handlers/integration-channels.ts` — accept reported threads.
- `packages/control-plane/src/http/dto/index.ts` — `threads` on the channel DTO, the new patch body.
- `packages/control-plane/src/http/routes/integrations.ts` — the thread PATCH route.
- `packages/control-plane/src/http/mcp/tools.ts` — the thread trigger tool.
- `packages/control-plane/test/integration/integration-channels.test.ts` — the report + cascade suites.

**Modified — daemon:**

- `packages/message/src/telegram-message.ts` — the forum service records; `telegramForumTopicId`.
- `packages/daemon/src/telegram/connection.ts` — the `onForumTopic` dep and its two firing paths.
- `packages/daemon/src/telegram/normalize.ts` — re-export the new helper.
- `packages/daemon/src/platforms/connection-reconciler.ts` — pass `onForumTopic`; declare `observeForumTopic` on the host.
- `packages/daemon/src/platforms/observed-channels-sync.ts` — record a topic into the cached channel row and re-emit.
- `packages/daemon/src/router/routing-rule.ts` — `overriddenThreads` on `integrationRouting`; `conversationAdmitted` takes the thread.
- `packages/daemon/src/platforms/integration-config.ts` — read `overriddenThreads`.
- `packages/daemon/src/agents/agent-schema.ts` — `overriddenThreads: []` in the envelope default.
- `packages/daemon/src/commands/handlers.ts`, `packages/daemon/src/daemon.ts` — thread through the admission call sites.
- `packages/daemon/test/*` — the routing-rule, connection, sync and command suites.

**Modified — web:**

- `packages/web/src/lib/api.ts`, `packages/web/src/lib/data.ts` — the thread types, the DTO, `updateIntegrationChannelThread`.
- `packages/web/src/lib/data-context.tsx` — `setThreadTrigger`.
- `packages/web/src/components/console/platforms/contract.ts` — `threadTriggers`.
- `packages/web/src/components/console/platforms/telegram/index.tsx` — declare it.
- `packages/web/src/components/console/IntegrationChannelList.tsx` — the nested disclosure and topic rows.
- `packages/web/src/components/console/IntegrationChannelList.trigger.test.tsx` — the topic menu.

**Modified — docs:**

- `docs/product-conventions.md` — the topic paragraph in "Per-conversation trigger".

---

## Task 1: The wire types — `ScopeRef`, `ThreadRef`, `IntegrationChannelThread`

**Files:**

- Modify: `packages/protocol/src/frames/integration.ts:146-155` (envelope), `:274-295` (`IntegrationChannel`)
- Test: `packages/protocol/src/frames/integration.test.ts` (create)

**Interfaces:**

- Produces: `ScopeRef` (a `z.union` of `string` | `{channel, thread}`), `ThreadRef`, `IntegrationChannelThread`; `IntegrationCoreEnvelope.overriddenThreads: ThreadRef[]`; `IntegrationCoreEnvelope.mutedChannels` / `.affinityDenied` widened to `ScopeRef[]`; `IntegrationChannel.threads?: IntegrationChannelThread[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/frames/integration.test.ts`. The house style is a plain object fixture with `.parse()`/`.safeParse()` assertions (`frames/cron.test.ts`).

```ts
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

  it('emits exactly today's JSON for an integration with no topics', () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/protocol test -- -t "IntegrationCoreEnvelope fences"`
Expected: FAIL — `overriddenThreads` is `undefined` on the parsed result (the field does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

In `packages/protocol/src/frames/integration.ts`, above `IntegrationCoreEnvelope`:

```ts
/** A fence target: a whole conversation, or one thread of it (a Telegram forum topic).
 *  The bare string is the channel-wide form every existing producer sends — an older
 *  daemon parses it unchanged. */
export const ScopeRef = z.union([z.string(), z.object({ channel: z.string(), thread: z.string() })])
export type ScopeRef = z.infer<typeof ScopeRef>

/** A thread-shaped fence target. Its own schema because an override is only ever a thread. */
export const ThreadRef = z.object({ channel: z.string(), thread: z.string() })
export type ThreadRef = z.infer<typeof ThreadRef>
```

Replace the envelope body:

```ts
export const IntegrationCoreEnvelope = z.object({
  mode: z.enum(['direct', 'shared']).default('direct'),
  bindRules: z.array(IntegrationBindRule).default([]),
  mutedChannels: z.array(ScopeRef).default([]),
  affinityDenied: z.array(ScopeRef).default([]),
  /** Threads whose own trigger overrides everything the enclosing channel states. */
  overriddenThreads: z.array(ThreadRef).default([]),
  gated: z.boolean().default(false)
})
```

Above `IntegrationChannel`, add the thread schema and the field:

```ts
/** A thread of a conversation that can carry its own trigger (a Telegram forum topic).
 *  `name` absent = not yet resolved; nothing clears a name, so it is never null. */
export const IntegrationChannelThread = z.object({
  id: z.string(),
  name: z.string().optional()
})
export type IntegrationChannelThread = z.infer<typeof IntegrationChannelThread>
```

and inside `IntegrationChannel`, after `dmUserId`:

```ts
// The conversation's own configurable threads, where the platform has them. Absent
// everywhere else, and absent until the daemon has learned one.
threads: z.array(IntegrationChannelThread).optional()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/protocol test -- -t "IntegrationCoreEnvelope fences"`
Expected: PASS — 4 cases.

Run: `pnpm --filter @agentconnect.md/protocol test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/frames/integration.ts packages/protocol/src/frames/integration.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(protocol): a thread coordinate on the integration envelope"
```

---

## Task 2: The policy fence — `overriddenThreads` and the `own` guard

**Files:**

- Modify: `packages/activation-policy/src/index.ts:28-47` (`ActivationRule`), `:68-71` (`channelInScope`), `:73-87` (`scopeMatches`), `:92-106` (`affinityAdmits`/`continuityAdmits`), `:263-269` (`conversationAdmitsAgent`)
- Test: `packages/activation-policy/test/policy.test.ts`

**Interfaces:**

- Consumes: `ScopeRef`, `ThreadRef` from `@agentconnect.md/protocol` (Task 1).
- Produces: `ActivationRule.overriddenThreads?: ThreadRef[]`; `ActivationRule.mutedChannels?: ScopeRef[]`; `ActivationRule.affinityDenied?: ScopeRef[]`; `channelReaches(r, msg): boolean`; `affinityAdmits(rule: Pick<ActivationRule, 'affinityDenied' | 'overriddenThreads'>, agentId, msg): boolean`; `conversationAdmitsAgent(rules, agentId, channel, thread?)`.

**Two corrections to the spec, both required here:**

- The spec says `affinityAdmits`'s signature widens from a bare `denied` list to "the rule's two fence fields". It takes the rule, because `channelReaches` needs `overriddenThreads` and `refCovers` needs the `own` flag those two fields produce.
- The spec omits `conversationAdmitsAgent` (`:263-269`) entirely. It has its own `covers` helper comparing a bare string against a bare channel, so widening `mutedChannels` to `ScopeRef[]` breaks it at compile time. It gains a `thread` parameter for the same reason `scopeMatches` does.

- [ ] **Step 1: Write the failing test**

Append to `packages/activation-policy/test/policy.test.ts`. The existing `msg`/`rule` factories already spread `...over`, so the extra fields need no change.

```ts
describe('overriddenThreads (a topic that carries its own trigger)', () => {
  const tgMsg = (over: Partial<ActivationMessageFacts> = {}) =>
    msg({ platform: 'telegram', channel: '-100', thread: '7', ...over })
  const autoRule = () => rule({ agentId: 'a1', scope: { channel: '-100' }, match: { kind: 'auto' } })
  const own = [{ channel: '-100', thread: '7' }]

  it("a group's auto rule does not fire in an overridden thread", () => {
    expect(routeRules(tgMsg(), [autoRule()], () => null)).toMatchObject({ agentId: 'a1' })
    expect(routeRules(tgMsg(), [{ ...autoRule(), overriddenThreads: own }], () => null)).toBeNull()
  })

  it('an overridden thread still answers an @-mention — the unscoped default is never suppressed', () => {
    const rules = [rule({ agentId: 'a1', overriddenThreads: own }), autoRule()]
    expect(routeRules(tgMsg({ mentionedBots: ['U1'], text: '<@U1>' }), rules, () => null)).toMatchObject({
      agentId: 'a1',
      via: 'mention'
    })
  })

  it('an overridden thread reaches a thread-scoped rule of its own', () => {
    const rules = [
      rule({ agentId: 'a1', scope: { channel: '-100', thread: '7' }, match: { kind: 'auto' } }),
      autoRule()
    ]
    const withOwn = rules.map((r) => (r.agentId === 'a1' ? { ...r, overriddenThreads: own } : r))
    expect(routeRules(tgMsg(), withOwn, () => null)).toMatchObject({ agentId: 'a1', via: 'auto' })
  })

  it('a channel-wide mute does not silence an overridden thread; a thread-shaped one does', () => {
    const auto = autoRule()
    const channelWide = [{ ...auto, mutedChannels: ['-100'], overriddenThreads: own }]
    expect(routeRules(tgMsg(), channelWide, () => null)).toMatchObject({ agentId: 'a1' })
    const threadShaped = [{ ...auto, mutedChannels: own, overriddenThreads: own }]
    expect(routeRules(tgMsg(), threadShaped, () => null)).toBeNull()
  })

  it('does not revive a thread owner through the affinity rung', () => {
    const rules = [rule({ agentId: 'a1', match: { kind: 'mention' }, overriddenThreads: own }), autoRule()]
    expect(routeRules(tgMsg(), rules, () => 'a1')).toMatchObject({ agentId: 'a1', via: 'thread' })
    const silent = rules.map((r) => (r.agentId === 'a1' ? { ...r, scope: { channel: '-100' } } : r))
    expect(routeRules(tgMsg(), silent, () => 'a1')).toBeNull()
  })

  it('an unrelated thread ref leaves the channel reachable', () => {
    const rules = [{ ...autoRule(), overriddenThreads: [{ channel: '-100', thread: '999' }] }]
    expect(routeRules(tgMsg(), rules, () => null)).toMatchObject({ agentId: 'a1' })
  })

  it('a channel-wide affinityDenied does not reach an overridden thread, so a mention topic re-admits replies', () => {
    const denied = { channel: '-100' }
    const topic = rule({ agentId: 'a1', match: { kind: 'mention' }, overriddenThreads: own })
    const group = { ...autoRule(), affinityDenied: [denied] }
    expect(routeRules(tgMsg(), [topic, group], () => 'a1', undefined, 'a1')).toMatchObject({ via: 'thread' })
  })

  it('gates participants by the thread own fence', () => {
    const rules = [autoRule(), { ...rule({ agentId: 'a2' }), overriddenThreads: own }]
    expect(participantAgents(tgMsg(), rules, ['a1', 'a2'])).toEqual(['a1'])
  })
})

describe('conversationAdmitsAgent with a thread', () => {
  const rules = [
    rule({ agentId: 'a1', mutedChannels: ['C1'] }),
    rule({ agentId: 'a2', scope: { channel: 'C1' }, overriddenThreads: [{ channel: 'C1', thread: 'T1' }] })
  ]
  it('a channel-wide mute does not reach an overridden thread', () => {
    expect(conversationAdmitsAgent(rules, 'a1', 'C1')).toBe(false)
    expect(conversationAdmitsAgent(rules, 'a1', 'C1', 'T1')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/activation-policy test -- -t "overriddenThreads"`
Expected: FAIL — the group's `auto` rule still matches, so `routeRules(tgMsg(), [{...autoRule(), overriddenThreads: own}], () => null)` returns `{agentId: 'a1'}` instead of `null`.

- [ ] **Step 3: Write the minimal implementation**

At the top of `packages/activation-policy/src/index.ts`, extend the protocol import (`:15`) with `type ScopeRef, type ThreadRef`.

In `ActivationRule` (`:28-47`), widen the two fences and add the third:

```ts
  /** Fences: what the enclosing channel states, read inside the scope predicate. A bare
   *  string is channel-wide; a `{channel, thread}` ref names one thread. */
  mutedChannels?: ScopeRef[]
  affinityDenied?: ScopeRef[]
  /** Threads that carry their own trigger: in these, nothing stated about the channel applies. */
  overriddenThreads?: ThreadRef[]
```

Replace `channelInScope` with `refCovers` and add `channelReaches` (`:68-71`):

```ts
/** Does a fence ref reach this message? A channel-wide ref IS the enclosing channel's own
 *  statement, so it stops at a thread that carries its own trigger; a thread-shaped ref
 *  always reaches the thread it names. */
function refCovers(ref: ScopeRef, msg: ActivationMessageFacts, own: boolean): boolean {
  if (typeof ref === 'string') return own && ref === msg.channel
  return ref.channel === msg.channel && ref.thread === msg.thread
}

/** Does the enclosing channel's own state reach here? False in a thread the operator gave
 *  its own trigger: that thread ignores everything stated about the channel. */
function channelReaches(r: ActivationRule, msg: ActivationMessageFacts): boolean {
  return !r.overriddenThreads?.some((t) => refCovers(t, msg, true))
}
```

Replace `scopeMatches` (`:73-87`):

```ts
function scopeMatches(r: ActivationRule, msg: ActivationMessageFacts): boolean {
  if (r.platform !== undefined && r.platform !== msg.platform) return false
  const own = channelReaches(r, msg)
  // A channel-scoped rule with no thread IS the channel's statement, so an overridden thread drops it.
  if (!own && r.scope.channel !== undefined && r.scope.thread === undefined) return false
  if (r.mutedChannels?.some((m) => refCovers(m, msg, own))) return false
  if (r.scope.channel !== undefined && r.scope.channel !== msg.channel) return false
  if (r.scope.thread !== undefined && r.scope.thread !== msg.thread) return false
  return true
}
```

Replace `affinityAdmits` and `continuityAdmits` (`:92-106`):

```ts
/** Does the rule admit this message on continuity grounds? Takes the rule rather than a
 *  bare list: the answer depends on whether the channel reaches here at all. */
export function affinityAdmits(
  r: Pick<ActivationRule, 'affinityDenied' | 'overriddenThreads'>,
  agentId: string,
  msg: ActivationMessageFacts
): boolean {
  const own = channelReaches(r as ActivationRule, msg)
  if (!r.affinityDenied?.some((fenced) => refCovers(fenced, msg, own))) return true
  return msg.replyToAuthor !== undefined && msg.replyToAuthor === agentId
}

function continuityAdmits(r: ActivationRule, msg: ActivationMessageFacts): boolean {
  return affinityAdmits(r, r.agentId, msg)
}
```

Widen `conversationAdmitsAgent` (`:263-269`) — its `covers` compared a bare string, which `ScopeRef` no longer is:

```ts
export function conversationAdmitsAgent(
  rules: readonly ActivationRule[],
  agentId: string,
  channel: string,
  thread?: string
): boolean {
  const agentRules = rules.filter((rule) => rule.agentId === agentId)
  if (agentRules.length === 0) return false
  const ref = { channel, thread }
  const msg = { channel, thread } as ActivationMessageFacts
  const covers = (scopeChannel: string | undefined): boolean => scopeChannel === undefined || scopeChannel === channel
  // The same fence read as `scopeMatches` performs, against the same coordinates — a topic
  // whose own trigger is Off must gate its delivery just as its routing does.
  const fenced = agentRules.some(
    (rule) =>
      !channelReaches(rule, msg) ||
      rule.mutedChannels?.some((muted) => refCovers(muted, msg, channelReaches(rule, msg)))
  )
  if (fenced) return false
  return agentRules.some(
    (rule) =>
      covers(rule.scope.channel) &&
      (thread === undefined || rule.scope.thread === undefined || rule.scope.thread === thread)
  )
}
```

Note the two shape facts this lean `msg`/`ref` stand-in depends on: `refCovers` reads only `channel`/`thread`, and `channelReaches` reads only `overriddenThreads` off the rule and `channel`/`thread` off the message. A thread-shaped ref therefore compares equal to the same coordinates with no transcript lookup.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/activation-policy test`
Expected: PASS — the new describes plus every existing case.

Run: `pnpm --filter @agentconnect.md/activation-policy typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/activation-policy/src/index.ts packages/activation-policy/test/policy.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(activation-policy): a thread that carries its own trigger ignores its channel"
```

---

## Task 3: The daemon's own admission predicate

**Files:**

- Modify: `packages/daemon/src/router/routing-rule.ts:39-48` (`integrationRouting`), `:62-69` (`conversationAdmitted`), `:86-118` (`resolveAgentIntegration`), `:122-142` (`rulesFromAgent`), `:145-171` (`resolveCpRule`)
- Modify: `packages/daemon/src/platforms/integration-config.ts:69-80` (`IntegrationCore`), `:146-155` (`integrationCore`)
- Modify: `packages/daemon/src/agents/agent-schema.ts:79-85` (the envelope default literal)
- Test: `packages/daemon/test/routing-rule.test.ts`

**Interfaces:**

- Consumes: `ScopeRef`, `ThreadRef` (Task 1); `ActivationRule.overriddenThreads` (Task 2).
- Produces: `IntegrationCore.overriddenThreads: ThreadRef[]`; `integrationRouting(int).overriddenThreads: ThreadRef[]`; `conversationAdmitted(routing, channel, thread): boolean`, with `thread` a REQUIRED third parameter so Task 4's typecheck names every call site that forgot it. `thread` may be `undefined` — only Slack and Telegram have one — but it must be passed.

**`conversationAdmitted` is NOT `conversationAdmitsAgent`.** They are two functions in two packages with the same job (reproduce Off outside the ladder) and separate `covers` helpers. This task widens the daemon's; Task 2 widened the policy package's. Neither may call the other — `routing-rule.ts` reads the daemon's local `Integration` shape, not the policy package's rule list.

- [ ] **Step 1: Write the failing test**

In `packages/daemon/test/routing-rule.test.ts`, the existing `describe('conversationAdmitted')` builds `routing()` with a bare `mutedChannels: []`. Widen that factory to include the new field, then add the cases:

```ts
const routing = (over: Partial<Parameters<typeof conversationAdmitted>[0]> = {}) => ({
  bindRules: [],
  mutedChannels: [],
  overriddenThreads: [],
  gated: false,
  ...over
})
```

and, after the existing cases:

```ts
it('lets a topic with its own trigger through the group mute, and keeps a channel-wide mute elsewhere', () => {
  const r = routing({ mutedChannels: ['C1'], overriddenThreads: [{ channel: 'C1', thread: 'T1' }] })
  expect(conversationAdmitted(r, 'C1', 'T1')).toBe(true)
  expect(conversationAdmitted(r, 'C1', 'T2')).toBe(false)
  expect(conversationAdmitted(r, 'C1', undefined)).toBe(false)
})

// A gated integration is still fail-closed in an overridden topic: the missing grant is the Off.
it('leaves a gated integration fail-closed in an overridden thread with no grant of its own', () => {
  const r = routing({ gated: true, overriddenThreads: [{ channel: 'C1', thread: 'T1' }] })
  expect(conversationAdmitted(r, 'C1', 'T1')).toBe(false)
})
```

The four EXISTING cases in that describe also call `conversationAdmitted(r, 'C1')` with a bare string (`:286-310`). Task 3 makes the third parameter required, so they each need `, undefined` appended in the same edit — those are the compile errors Step 4's `test` run surfaces.

Add a `describe('integrationRouting overriddenThreads')` beside the existing `affinityDenied` describe:

```ts
describe('integrationRouting overriddenThreads (§6.4 core-envelope read, mirroring mutedChannels)', () => {
  it('carries the fence from the envelope onto every rule of the integration', () => {
    const a = agent({
      integrations: [
        {
          id: 'int1',
          platform: 'telegram',
          core: {
            bindRules: [{ match: { kind: 'mention' } }],
            overriddenThreads: [{ channel: '-100', thread: '7' }]
          } as Integration['core']
        }
      ]
    })
    expect(rulesFromAgent(a)[0]?.overriddenThreads).toEqual([{ channel: '-100', thread: '7' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/daemon test -- test/routing-rule.test.ts`
Expected: FAIL — `conversationAdmitted` accepts two parameters, so the new three-argument calls do not compile, and `routing()`'s `overriddenThreads` is not read.

- [ ] **Step 3: Write the minimal implementation**

`packages/daemon/src/platforms/integration-config.ts` — the `IntegrationCore` interface gains the field (the doc comment condenses to one line, per the repo's comment rule):

```ts
  /** Threads that carry their own trigger (a Telegram forum topic); normalized here so a
   *  hand-assembled integration reads as "none overridden" when the field is absent. */
  overriddenThreads: ThreadRef[]
```

and `integrationCore` (`:146-155`) reads it: `overriddenThreads: core?.overriddenThreads ?? []`. Extend the file's protocol import with `type ThreadRef`.

`packages/daemon/src/agents/agent-schema.ts:79-85` — the envelope default literal gains `overriddenThreads: []` beside `affinityDenied: []`.

`packages/daemon/src/router/routing-rule.ts` — add the local fence predicate and widen the two functions. Import `type ThreadRef` from protocol.

```ts
/** Does a fence ref reach this message? A channel-wide ref IS the channel's own statement,
 *  so it stops at a thread that carries its own trigger; a thread-shaped ref always reaches
 *  the thread it names. Mirrors the policy package's `refCovers`. */
function refCovers(ref: ScopeRef, channel: string, thread: string | undefined, own: boolean): boolean {
  if (typeof ref === 'string') return own && ref === channel
  return ref.channel === channel && ref.thread === thread
}
```

`integrationRouting` (`:39-48`) returns the new field, destructured from `integrationCore(int)` exactly as `mutedChannels` is:

```ts
export function integrationRouting(int: Integration): {
  staticBotUserId?: string
  bindRules: BindRuleConfig[]
  mutedChannels: ScopeRef[]
  affinityDenied: ScopeRef[]
  overriddenThreads: ThreadRef[]
  gated: boolean
} {
  const { bindRules, mutedChannels, affinityDenied, overriddenThreads, gated } = integrationCore(int)
  return {
    staticBotUserId: configuredBotSelfId(int),
    bindRules,
    mutedChannels,
    affinityDenied,
    overriddenThreads,
    gated
  }
}
```

`conversationAdmitted` (`:62-69`) — both effects, and the same comment shape the old body carried:

```ts
export function conversationAdmitted(
  routing: Pick<ReturnType<typeof integrationRouting>, 'bindRules' | 'mutedChannels' | 'overriddenThreads' | 'gated'>,
  channel: string,
  thread: string | undefined
): boolean {
  const own = !routing.overriddenThreads.some((t) => refCovers(t, channel, thread, true))
  if (routing.mutedChannels.some((muted) => refCovers(muted, channel, thread, own))) return false
  if (!own) return true
  return (
    !routing.gated ||
    routing.bindRules.some((rule) => rule.channel === channel && (rule.thread === undefined || rule.thread === thread))
  )
}
```

`thread` is required and only Slack and Telegram pass a real one; every other caller passes `undefined` explicitly. That is the point: a default would let a call site miss the feature silently, and this file has four of them.

`resolveAgentIntegration` (`:86-118`) and `resolveCpRule` (`:145-171`) carry the new field exactly as they carry `mutedChannels` (the conditional spread `...(r.overriddenThreads ? … : {})` pattern); `rulesFromAgent` (`:122-142`) spreads it onto every rule.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/daemon test -- -t "overriddenThreads"`
Expected: PASS.

Run: `pnpm --filter @agentconnect.md/daemon test -- test/routing-rule.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/router/routing-rule.ts packages/daemon/src/platforms/integration-config.ts packages/daemon/src/agents/agent-schema.ts packages/daemon/test/routing-rule.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(daemon): read the overridden-threads fence in conversation admission"
```

---

## Task 4: Thread the daemon's admission call sites

**Files:**

- Modify: `packages/daemon/src/commands/handlers.ts:395` (`affinityAdmits`), `:481` (`commandSenderAllowed`), `:880` (`commandSessionForLatest`), `:917-924` (`latestAdmittedSession`), `:935-946` (`admittedAgentIds`), `:949-963` (`admittedSessions`), `:966-973` (`commandSessionForLatest`), `:977-985` (`slackShortcutSession`), `:1005` (`slackThreadSessions`)
- Modify: `packages/daemon/src/daemon.ts:6993-6995` (`agentConversationAdmits`), `:8382-8384` (Slack `open-config-for-thread`), `:9908-9913` (`resolveCpAgent`)
- Test: `packages/daemon/test/daemon-commands.test.ts` (the end-to-end command case)

**Interfaces:**

- Consumes: `conversationAdmitted(routing, channel, thread)` (Task 3 — the third parameter is required, so this task's typecheck names every call site that forgot it); `affinityAdmits(rule, agentId, msg)` (Task 2).
- Produces: `admittedAgentIds(platform, channel, srcIntegrationIds, thread: string | undefined)`; nothing else new — the remaining changed functions pass the thread they already hold.

**The spec says "the five `conversationAdmitted` call sites (`handlers.ts:481,940`, `daemon.ts:8384,16480`)"** — that is four listed after a count of five. There are four. `handlers.ts:940` is inside `admittedAgentIds`, which takes only `channel` today while its sibling `admittedSessions` (`:949-963`) ALREADY has `thread?: string` and passes it to `latestSessionForTransport`. The thread is therefore already in hand one frame up at every command call site; `admittedAgentIds` is the one function that has to learn to accept it.

- [ ] **Step 1: Write the failing test**

The command path's real harness is `packages/daemon/test/daemon-commands.test.ts`, not `commands.test.ts` — the latter covers `parseCommand` alone and has no agent fixture. Add a case to its `describe('Daemon in-conversation commands')` (`:138`). Its `makeRoutable(daemon)` helper (`:97-118`) attaches a Slack integration by hand and is the pattern to copy for a Telegram one:

```ts
it('admits a command in a topic the operator gave its own trigger, and refuses it in the muted group', async () => {
  const blocked = blockingHost()
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root: scaffold(),
    hostFactory: () => blocked.host as any
  })
  await daemon.start()
  const conn = makeRoutable(daemon)
  const a = (daemon as any).agents.get('bot-a')
  a.integrations[0].core = {
    bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }],
    mutedChannels: ['-100'],
    overriddenThreads: [{ channel: '-100', thread: '7' }]
  }

  const inTopic = (thread: string) => ({
    msgId: `telegram:-100:${thread}`,
    traceId: `t-${thread}`,
    source: 'user' as const,
    platform: 'telegram' as const,
    channel: '-100',
    thread,
    sender: { id: 'U1', isBot: false },
    text: '!resume',
    mentionedBots: [] as string[],
    isDm: false,
    trigger: 'mention' as const
  })

  await (daemon as any).onInboundOutcome(inTopic('8'))
  expect(conn.postMessage).not.toHaveBeenCalled()

  await (daemon as any).onInboundOutcome(inTopic('7'))
  await daemon.stop()
})
```

Assert on whatever the topic-7 arm produces in this harness rather than inventing a call; if the loop-guard precondition makes the reply ambiguous, set up the guard exactly as the file's first case does (`:140-155`) and assert `conn.postMessage` was called for `'-100'` in thread `'7'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/daemon test -- test/daemon-commands.test.ts -t "admits a command in a topic"`
Expected: FAIL — both arms are refused, because the mute applies to the whole channel.

- [ ] **Step 3: Write the minimal implementation**

`packages/daemon/src/commands/handlers.ts`:

- `:395` — `affinityAdmits(integrationRouting(integration), agentId, msg)`. The `thread` local at `:377` already gates on `threadIdentifiesSession`; the `msg` carries `thread`, so the call itself is only a signature change.
- `:481` — `return conversationAdmitted(routing, msg.channel, msg.thread)`. The comment above it already says the check must be repeated because commands resolve outside the scope filter — a topic-level Off is the new instance of exactly that.
- `:935-946` — `admittedAgentIds(platform, channel, srcIntegrationIds, thread: string | undefined)`, passing `thread` into `conversationAdmitted(integrationRouting(integration), channel, thread)`.
- `:949-963` — `admittedSessions` passes its existing `thread` to `admittedAgentIds` at `:957`.
- `:966-973` `commandSessionForLatest` and `:977-985` `slackShortcutSession` — pass the thread they already have (`shortcut.thread` for the latter); `:1005` inherits it from `slackThreadSessions`.
- The Telegram callback path (`handleTelegramCallback`, `:873-881`) calls `commandSessionForLatest(cb.channel, …)`; add `cb.topicId` as the fourth argument — `TelegramCallback` (`telegram/connection.ts:95-101`) already carries it.

`packages/daemon/src/daemon.ts`:

- `:6993-6995` — `agentConversationAdmits` passes `msg.thread` into `conversationAdmitsAgent(rules, agentId, msg.channel, msg.thread)`.
- `:8382-8384` — `conversationAdmitted(routing, payload.channelId, payload.threadTs)`; the very next statement already uses `payload.threadTs` for the session lookup.
- `:9908-9913` — `resolveCpAgent`'s explicit return type declares `mutedChannels: string[]`; widen it to `ScopeRef[]` and add `overriddenThreads: ThreadRef[]`.
- `:16477-16481` — `gatedAdmission` passes `msg.thread`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/daemon test -- test/daemon-commands.test.ts -t "admits a command in a topic"`
Expected: PASS.

Run: `pnpm --filter @agentconnect.md/daemon typecheck`
Expected: PASS — this is the step that catches any call site the list above missed, because Task 3 made `thread` a required parameter. It must be clean before committing.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/commands/handlers.ts packages/daemon/src/daemon.ts packages/daemon/test/daemon-commands.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "fix(daemon): read admission against the message's own thread"
```

---

## Task 5: The Prisma model and its migration

**Files:**

- Modify: `packages/control-plane/prisma/schema.prisma` (after `model IntegrationChannel`, `:2503-2543`)
- Create: `packages/control-plane/prisma/migrations/20261012000000_integration_channel_thread/migration.sql`

**Interfaces:**

- Produces: the `integration_channel_thread` table keyed `(integrationId, channelId, threadId)`, with `trigger ChannelTrigger?` (NULL = inherit) and a composite FK to `integration_channel`.

- [ ] **Step 1: Write the failing check**

There is no test to write first for a schema — the failing check IS the migration applying. Write the migration, then run it.

- [ ] **Step 2: Confirm it fails**

Run: `pnpm --filter @agentconnect.md/control-plane exec prisma migrate status`
Expected: the new migration is pending (and, in a fresh clone, the generated client has no `integrationChannelThread` delegate).

- [ ] **Step 3: Write the schema and the migration**

In `packages/control-plane/prisma/schema.prisma`, after `model IntegrationChannel`:

```prisma
model IntegrationChannelThread {
  integrationId String
  channelId     String
  threadId      String
  name          String?
  // NULL = inherit the enclosing conversation's trigger, which is what every topic starts on.
  // A topic is therefore never defaulted to a value a human did not choose, so unlike
  // IntegrationChannel this table needs no `triggerChosen`.
  trigger       ChannelTrigger?
  firstSeenAt   DateTime       @default(now()) @db.Timestamptz(6)
  updatedAt     DateTime       @updatedAt @db.Timestamptz(6)

  channel IntegrationChannel @relation(fields: [integrationId, channelId], references: [integrationId, channelId], onDelete: Cascade)

  @@id([integrationId, channelId, threadId])
  @@map("integration_channel_thread")
}
```

and the back-relation on `IntegrationChannel`:

```prisma
  threads IntegrationChannelThread[]
```

Create `packages/control-plane/prisma/migrations/20261012000000_integration_channel_thread/migration.sql`. The DDL shape follows the `init` migration's `integration_channel` table (`00000000000000_init/migration.sql:780-794`) and the composite-FK naming convention (`organization_environment_assignment_agentId_orgId_fkey`, `:2116`). The header is required, not decorative — it records the one non-obvious decision (why there is no `triggerChosen`) and the fact this row is never deleted:

```sql
-- A Telegram forum topic's own trigger. NULL `trigger` = inherit the enclosing group's,
-- which is what every topic starts on and what clearing it returns the topic to — so the
-- column is nullable rather than defaulted, and no `triggerChosen` is needed: there is no
-- default a human did not choose.
--
-- The composite FK is the point: a topic must not outlive the group it belongs to, and
-- `replaceSnapshot` deletes the channel rows a bot has left. Nothing deletes a thread row
-- on its own — Telegram reports no topic deletion, so a quiet topic and a dropped one are
-- indistinguishable, and a tombstone would have to be permanent.
BEGIN;

CREATE TABLE "public"."integration_channel_thread" (
    "integrationId" UUID NOT NULL,
    "channelId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "name" TEXT,
    "trigger" "public"."ChannelTrigger",
    "firstSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_channel_thread_pkey" PRIMARY KEY ("integrationId","channelId","threadId")
);

ALTER TABLE "public"."integration_channel_thread"
  ADD CONSTRAINT "integration_channel_thread_integrationId_channelId_fkey"
  FOREIGN KEY ("integrationId", "channelId")
  REFERENCES "public"."integration_channel"("integrationId", "channelId")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
```

- [ ] **Step 4: Verify it applies**

Run: `pnpm --filter @agentconnect.md/control-plane prisma:generate`
Run: `pnpm --filter @agentconnect.md/control-plane test:int -- test/integration/integration-channels.test.ts`
Expected: PASS — Testcontainers runs `migrate deploy` over the new file, so a SQL error fails here.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/prisma/schema.prisma packages/control-plane/prisma/migrations/20261012000000_integration_channel_thread/migration.sql
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(cp): a table for a topic's own trigger"
```

---

## Task 6: The repo port and its implementation

**Files:**

- Modify: `packages/control-plane/src/persistence/ports.ts:5052-5082` (`IntegrationChannelRecord`), `:5084-5105` (`ReportedChannel`), `:5135-5151` (`IntegrationChannelRepo`)
- Modify: `packages/control-plane/src/persistence/repositories/integration.repo.ts:714-732` (`toChannelRecord`), `:752-853` (`replaceSnapshot`), after `:954-975` (`setThreadTrigger`)
- Modify: the six fixture literals: `packages/control-plane/src/orchestrator/placement.test.ts:105`, `packages/control-plane/src/orchestrator/httpBot.test.ts:115`, `packages/control-plane/src/platforms/{slack,telegram,feishu,discord}/provider.test.ts:144,90,153,94`
- Test: `packages/control-plane/test/integration/integration-channels.test.ts`

**Interfaces:**

- Consumes: the Prisma model (Task 5).
- Produces: `IntegrationChannelThreadRecord { threadId: string; name: string | null; trigger: ChannelTrigger | null }`; `IntegrationChannelRecord.threads: IntegrationChannelThreadRecord[]`; `ReportedChannel.threads?: { id: string; name?: string }[]`; `IntegrationChannelRepo.setThreadTrigger(integrationId, channelId, threadId, trigger: ChannelTrigger | null): Promise<IntegrationChannelThreadRecord | null>`.

**`toChannelRecord` is shared by `listForIntegration` and `listForBot`** (`:901-916`). Both must `include: { threads: true }` and both must map, or the console and the shared-bot compiler disagree about which topics exist.

- [ ] **Step 1: Write the failing test**

In `packages/control-plane/test/integration/integration-channels.test.ts`, add a describe beside the existing channel-report suites. The `report(...)` helper at `:210-259` already takes `channels`; the thread list rides the channel object.

```ts
describe('reported threads', () => {
  it('creates a thread row, refreshes its name, and preserves a stored trigger', async () => {
    const { integrationId } = await installTelegram()
    await report('d1', integrationId, [{ id: '-100', name: 'General', threads: [{ id: '7', name: 'Deploys' }] }])
    await PATCH(`${ORG}/integrations/${integrationId}/channels/-100/threads/7`, { trigger: 'off' })

    // A re-report that still carries the topic must not blank the operator's trigger.
    await report('d1', integrationId, [
      { id: '-100', name: 'General', threads: [{ id: '7', name: 'Deploys and releases' }] }
    ])
    const row = await db.integrationChannel.findUnique({
      where: { integrationId_channelId: { integrationId, channelId: '-100' } },
      include: { threads: true }
    })
    expect(row?.threads[0]).toMatchObject({ threadId: '7', name: 'Deploys and releases', trigger: 'off' })
  })

  it('cascades a deleted channel row onto its threads', async () => {
    const { integrationId } = await installTelegram()
    await report('d1', integrationId, [{ id: '-100', threads: [{ id: '7' }] }])
    await db.integrationChannel.delete({ where: { integrationId_channelId: { integrationId, channelId: '-100' } } })
    expect(await db.integrationChannelThread.count({ where: { integrationId } })).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/control-plane test:int -- test/integration/integration-channels.test.ts -t "reported threads"`
Expected: FAIL — `integrationChannelThread` is not a delegate on the client until the port widens, and the report does not write threads.

- [ ] **Step 3: Write the minimal implementation**

`ports.ts`:

```ts
/** A thread of a conversation that carries its own trigger (a Telegram forum topic).
 *  `trigger: null` = inherit the enclosing conversation's, which is what every topic
 *  starts on. */
export interface IntegrationChannelThreadRecord {
  threadId: string
  name: string | null
  trigger: ChannelTrigger | null
}
```

and `threads: IntegrationChannelThreadRecord[]` on `IntegrationChannelRecord`; `threads?: { id: string; name?: string }[]` on `ReportedChannel`; and on `IntegrationChannelRepo`, beside `setTrigger`:

```ts
  /** Set one thread's trigger. `null` clears the override back to inherit — the removal
   *  path, since a topic row is never deleted. `null` return = the thread row is gone. */
  setThreadTrigger(
    integrationId: IntegrationId,
    channelId: string,
    threadId: string,
    trigger: ChannelTrigger | null
  ): Promise<IntegrationChannelThreadRecord | null>
```

`integration.repo.ts`:

- `toChannelRecord` gains `threads: c.threads.map((t) => ({ threadId: t.threadId, name: t.name, trigger: t.trigger as ChannelTrigger | null }))`; the Prisma include is supplied by both list methods.
- `replaceSnapshot` (`:752-853`): inside the existing `for (const c of channels)` loop, after the raw INSERT, upsert each reported thread. Name is refreshed when the report carries one; the trigger is NEVER written here — the report is fire-and-forget and may race a console write.

```ts
for (const t of c.threads ?? []) {
  await this.db.integrationChannelThread.upsert({
    where: { integrationId_channelId_threadId: { integrationId, channelId: c.id, threadId: t.id } },
    // A report refreshes the NAME only. The trigger is the operator's, and this write
    // races a console PATCH — writing NULL here would clear an override under it.
    create: { integrationId, channelId: c.id, threadId: t.id, name: t.name ?? null },
    update: { ...(t.name !== undefined ? { name: t.name } : {}) }
  })
}
```

- `setThreadTrigger`, mirroring `setTrigger` (`:954-975`) including its missing-row reasoning:

```ts
  async setThreadTrigger(
    integrationId: IntegrationId,
    channelId: string,
    threadId: string,
    trigger: ChannelTrigger | null
  ): Promise<IntegrationChannelThreadRecord | null> {
    // updateMany → no throw on a missing row: a topic can vanish with its channel between
    // the console's read and this write, and the updateMany count IS the existence check.
    const res = await this.db.integrationChannelThread.updateMany({
      where: { integrationId, channelId, threadId },
      data: { trigger }
    })
    if (res.count === 0) return null
    const row = await this.db.integrationChannelThread.findUnique({
      where: { integrationId_channelId_threadId: { integrationId, channelId, threadId } }
    })
    return row ? { threadId: row.threadId, name: row.name, trigger: row.trigger as ChannelTrigger | null } : null
  }
```

Add `IntegrationChannelThreadRecord` (and `ScopeRef`/`ThreadRef` if not already) to the repo file's imports.

Fix the six fixture literals with `threads: []`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/control-plane test:int -- test/integration/integration-channels.test.ts -t "reported threads"`
Expected: PASS.

Run: `pnpm --filter @agentconnect.md/control-plane typecheck`
Expected: PASS — the six fixtures are the check.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/persistence/ports.ts packages/control-plane/src/persistence/repositories/integration.repo.ts packages/control-plane/src/orchestrator/placement.test.ts packages/control-plane/src/orchestrator/httpBot.test.ts packages/control-plane/src/platforms packages/control-plane/test/integration/integration-channels.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(cp): persist a topic's own trigger, name refreshed and trigger preserved"
```

---

## Task 7: The compilation fold

**Files:**

- Modify: `packages/control-plane/src/orchestrator/placement.ts:233-244` (`gatedBindRules`), `:259-269` (the two fence functions), `:288-315` (`integrationToSpec`), `:332-355` (`httpIntegrationToSpec`)
- Test: `packages/control-plane/src/orchestrator/placement.test.ts`

**Interfaces:**

- Consumes: `IntegrationChannelRecord.threads` (Task 6).
- Produces: `IntegrationSpec.core.overriddenThreads`, thread-shaped `mutedChannels`/`affinityDenied` entries and thread-scoped bind rules.

**The table this task implements** (spec §5; every topic with a non-NULL trigger is an override whatever its value):

| topic trigger      | `overriddenThreads` | `mutedChannels` | `affinityDenied` | positive rule (ungated)         | grant (gated)                      |
| ------------------ | ------------------- | --------------- | ---------------- | ------------------------------- | ---------------------------------- |
| _(NULL — inherit)_ | —                   | —               | —                | —                               | —                                  |
| `off`              | `{C,T}`             | `{C,T}`         | —                | —                               | — (fail-closed)                    |
| `mention`          | `{C,T}`             | —               | —                | — (unscoped default covers)     | `{channel: C, thread: T, mention}` |
| `mention_topic`    | `{C,T}`             | —               | `{C,T}`          | —                               | `{channel: C, thread: T, mention}` |
| `any`              | `{C,T}`             | —               | —                | `{channel: C, thread: T, auto}` | `{channel: C, thread: T, auto}`    |

- [ ] **Step 1: Write the failing test**

In `packages/control-plane/src/orchestrator/placement.test.ts`, the `channel(channelId, trigger, kind)` helper ends `dmUserId: null, triggerChosen: false, agentId: null`; add `threads: []` and a sibling helper:

```ts
const thread = (threadId: string, trigger: 'off' | 'mention' | 'mention_topic' | 'any' | null) => ({
  threadId,
  name: `Topic ${threadId}`,
  trigger
})
```

Then a describe covering each row of the table:

```ts
describe('integrationToSpec thread overrides', () => {
  it('an integration with no threads emits an empty fence — nothing else changes', async () => {
    const spec = await specOf(INTEGRATION, SECRET, [channel('C1', 'any')])
    expect(spec.core?.overriddenThreads).toEqual([])
    expect(spec.core?.mutedChannels).toEqual([])
  })

  it('a topic set to mention overrides the group without muting it and without a rule of its own', async () => {
    const c = { ...channel('C1', 'any'), threads: [thread('7', 'mention')] }
    const spec = await specOf(INTEGRATION, SECRET, [c])
    expect(spec.core?.overriddenThreads).toEqual([{ channel: 'C1', thread: '7' }])
    expect(spec.core?.mutedChannels).toEqual([])
    expect(spec.core?.bindRules).toEqual([
      { match: { kind: 'mention' } },
      { match: { kind: 'dm' } },
      { channel: 'C1', match: { kind: 'auto' } }
    ])
  })

  it('an off topic contributes a thread-shaped mute and an override', async () => {
    const c = { ...channel('C1', 'mention'), threads: [thread('7', 'off')] }
    const spec = await specOf(INTEGRATION, SECRET, [c])
    expect(spec.core?.overriddenThreads).toEqual([{ channel: 'C1', thread: '7' }])
    expect(spec.core?.mutedChannels).toEqual([{ channel: 'C1', thread: '7' }])
  })

  it('an any topic gets a thread-scoped auto rule', async () => {
    const c = { ...channel('C1', 'mention'), threads: [thread('7', 'any')] }
    const spec = await specOf(INTEGRATION, SECRET, [c])
    expect(spec.core?.bindRules).toContainEqual({ channel: 'C1', thread: '7', match: { kind: 'auto' } })
  })

  it('a mention_topic topic contributes an affinity fence, never a mute', async () => {
    const c = { ...channel('C1', 'any'), threads: [thread('7', 'mention_topic')] }
    const spec = await specOf(INTEGRATION, SECRET, [c])
    expect(spec.core?.affinityDenied).toEqual([{ channel: 'C1', thread: '7' }])
    expect(spec.core?.mutedChannels).toEqual([])
  })

  it('an off group with an any topic is expressible: the group mutes channel-wide, the topic overrides', async () => {
    const c = { ...channel('C1', 'off'), threads: [thread('7', 'any')] }
    const spec = await specOf(INTEGRATION, SECRET, [c])
    expect(spec.core?.mutedChannels).toEqual(['C1'])
    expect(spec.core?.overriddenThreads).toEqual([{ channel: 'C1', thread: '7' }])
    expect(spec.core?.bindRules).toContainEqual({ channel: 'C1', thread: '7', match: { kind: 'auto' } })
  })

  it('a cleared trigger is indistinguishable from one never set', async () => {
    const never = await specOf(INTEGRATION, SECRET, [{ ...channel('C1', 'any'), threads: [thread('7', null)] }])
    const cleared = await specOf(INTEGRATION, SECRET, [channel('C1', 'any')])
    expect(never.core).toEqual(cleared.core)
  })

  it('a gated integration gets a thread-scoped grant per enabled topic and none for an off one', async () => {
    const c = {
      ...channel('C1', 'mention'),
      threads: [thread('7', 'mention'), thread('8', 'any'), thread('9', 'off')]
    }
    const spec = await specOf(INTEGRATION, SECRET, [c], true)
    expect(spec.core?.bindRules).toEqual([
      { channel: 'C1', match: { kind: 'mention' } },
      { channel: 'C1', thread: '7', match: { kind: 'mention' } },
      { channel: 'C1', thread: '8', match: { kind: 'auto' } }
    ])
    expect(spec.core?.mutedChannels).toEqual([])
  })
})
```

The `specOf(i, secret, channels, gated)` helper already takes `gated` as its fourth argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/control-plane test:unit -- -t "thread overrides"`
Expected: FAIL — `spec.core.overriddenThreads` is `undefined`.

- [ ] **Step 3: Write the minimal implementation**

In `placement.ts`:

```ts
/** Every topic that carries a trigger, as the override fence — `off` included: a row an
 *  operator set is an override whatever value it holds, and stating it uniformly keeps one
 *  rule instead of four conditionals. An `off` topic is muted by its own ref and needs no
 *  suppression, so listing it costs nothing. */
function overriddenThreadRefs(channels: IntegrationChannelRecord[]): ThreadRef[] {
  return channels.flatMap((c) =>
    c.threads.filter((t) => t.trigger !== null).map((t) => ({ channel: c.channelId, thread: t.threadId }))
  )
}

/** The threads of any conversation, flattened to `{channel, trigger}` for the fence folds. */
function threadRows(
  channels: IntegrationChannelRecord[]
): { channel: string; thread: string; trigger: ChannelTrigger }[] {
  return channels.flatMap((c) =>
    c.threads.flatMap((t) =>
      t.trigger === null ? [] : [{ channel: c.channelId, thread: t.threadId, trigger: t.trigger }]
    )
  )
}
```

`mutedChannelIds` (`:259-262`) — topic refs are APPENDED to the same list, never replacing it. The channel-wide entries stay bare strings so an integration with no topics emits byte-identical JSON. The gated early-return stays, and for the same reason: a gated Off is expressed by the missing grant, and an overridden thread cannot pick the channel's grant up either, so an Off topic is silent without a mute:

```ts
function mutedChannelIds(channels: IntegrationChannelRecord[], gated: boolean): ScopeRef[] {
  // `mention_topic` is deliberately never here — it admits @-mentions and agent deliveries by
  // design, so muting it would silently convert the trigger into Off.
  if (gated) return []
  const topics = threadRows(channels)
    .filter((t) => t.trigger === 'off')
    .map((t) => ({ channel: t.channel, thread: t.thread }))
  return [...channels.filter((c) => c.trigger === 'off').map((c) => c.channelId), ...topics]
}
```

`affinityDeniedChannelIds` (`:267-269`) — topic refs appended, and it keeps its existing not-gated-skipped behaviour:

```ts
function affinityDeniedRefs(channels: IntegrationChannelRecord[]): ScopeRef[] {
  const topics = threadRows(channels)
    .filter((t) => t.trigger === 'mention_topic')
    .map((t) => ({ channel: t.channel, thread: t.thread }))
  return [...channels.filter((c) => c.trigger === 'mention_topic').map((c) => c.channelId), ...topics]
}
```

`gatedBindRules` (`:233-244`) — the two obligations the existing comment already names, both now exercised:

```ts
function gatedBindRules(channels: IntegrationChannelRecord[]): IntegrationBindRule[] {
  const out: IntegrationBindRule[] = []
  for (const c of channels) {
    if (c.trigger === 'off') continue
    // mention_topic is deliberately NOT branched here: it wants the mention rule below.
    // A future trigger that wants NO kind rule must branch BEFORE the fallthrough.
    if (c.kind === 'im') out.push({ channel: c.channelId, match: { kind: 'dm' } })
    else if (c.trigger === 'any') out.push({ channel: c.channelId, match: { kind: 'auto' } })
    else out.push({ channel: c.channelId, match: { kind: 'mention' } })
  }
  // A trigger that wants a THREAD branches AFTER the fallthrough: suppressing the channel's
  // own grant in an overridden thread would close a conversation the operator just opened.
  for (const t of threadRows(channels)) {
    if (t.trigger === 'off') continue
    out.push({
      channel: t.channel,
      thread: t.thread,
      match: { kind: t.trigger === 'any' ? 'auto' : 'mention' }
    })
  }
  return out
}
```

`integrationToSpec` (`:288-315`) — the ungated positive rule:

```ts
// A 1:1 DM's On state is already covered by the unscoped dm default. A group DM set to Any
// needs its own auto rule; Mention is covered by the default mention rule.
const channelRules: IntegrationBindRule[] = channels
  .filter((c) => c.trigger === 'any' && c.kind !== 'im')
  .map((c) => ({ channel: c.channelId, match: { kind: 'auto' as const } }))
// An `any` topic needs its own thread-scoped rule: the group's channel-scoped one is dropped
// in an overridden thread, and no unscoped default fires on every message.
const topicRules: IntegrationBindRule[] = threadRows(channels)
  .filter((t) => t.trigger === 'any')
  .map((t) => ({ channel: t.channel, thread: t.thread, match: { kind: 'auto' as const } }))
const bindRules = gated ? gatedBindRules(channels) : [...DEFAULT_BIND_RULES, ...channelRules, ...topicRules]
```

and the `core` literal (`:313`):

```ts
const core = {
  mode: 'direct' as const,
  bindRules,
  mutedChannels,
  affinityDenied,
  overriddenThreads: overriddenThreadRefs(channels),
  gated
}
```

`httpIntegrationToSpec` (`:347-353`) — the same three additions on `httpCore`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/control-plane test:unit -- -t "thread overrides"`
Expected: PASS.

Run: `pnpm --filter @agentconnect.md/control-plane test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/orchestrator/placement.ts packages/control-plane/src/orchestrator/placement.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(cp): compile a topic's trigger into an override fence and its own rule"
```

---

## Task 8: Accept reported threads at the WS edge

**Files:**

- Modify: `packages/control-plane/src/ws/handlers/integration-channels.ts`

**Interfaces:**

- Consumes: `ReportedChannel.threads` (Task 6).
- Produces: nothing new — the handler already hands `p.channels` to `replaceSnapshot`.

- [ ] **Step 1: Verify no change is needed**

Read the handler end to end. `replaceSnapshot` takes `p.channels` whole, and the ownership, mutation-lease, and gating logic around it is coordinate-independent (`chat: true` on the report, not on a topic). If the read confirms it, this task is a verification step with no diff — say so in the commit message body rather than manufacturing a change.

- [ ] **Step 2: Confirm the report round-trips**

Run: `pnpm --filter @agentconnect.md/control-plane test:int -- test/integration/integration-channels.test.ts -t "reported threads"`
Expected: PASS — Task 6's test already drives the real WS path.

- [ ] **Step 3: Commit nothing**

If the read found no change, do not commit. Move to Task 9.

---

## Task 9: The REST route

**Files:**

- Modify: `packages/control-plane/src/http/dto/index.ts:899-923` (`IntegrationChannelDto`), after `:1799` (the new body)
- Modify: `packages/control-plane/src/http/routes/integrations.ts` — the new route after the channel PATCH (`:895`)
- Test: `packages/control-plane/test/integration/integration-channels.test.ts`

**Interfaces:**

- Consumes: `setThreadTrigger` (Task 6).
- Produces: `PATCH /integrations/:id/channels/:channelId/threads/:threadId`, body `{ trigger: ChannelTrigger | null }`, response `IntegrationChannelThreadDto`.

- [ ] **Step 1: Write the failing test**

In `packages/control-plane/test/integration/integration-channels.test.ts`, beside the existing PATCH suites (`:1385-1829`):

```ts
describe('PATCH /integrations/:id/channels/:channelId/threads/:threadId', () => {
  it('sets a topic trigger, clears it back to inherit, and 404s an unknown topic', async () => {
    const { integrationId } = await installTelegram()
    await report('d1', integrationId, [{ id: '-100', threads: [{ id: '7', name: 'Deploys' }] }])

    const set = await PATCH(`${ORG}/integrations/${integrationId}/channels/-100/threads/7`, { trigger: 'off' })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toMatchObject({ threadId: '7', name: 'Deploys', trigger: 'off' })

    const cleared = await PATCH(`${ORG}/integrations/${integrationId}/channels/-100/threads/7`, { trigger: null })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json()).toMatchObject({ threadId: '7', trigger: null })

    const missing = await PATCH(`${ORG}/integrations/${integrationId}/channels/-100/threads/999`, { trigger: 'off' })
    expect(missing.statusCode).toBe(404)
  })

  it('rejects a viewer and an uneditable agent exactly as the channel route does', async () => {
    const { integrationId } = await installTelegram()
    await report('d1', integrationId, [{ id: '-100', threads: [{ id: '7' }] }])
    const denied = await PATCH(
      `${ORG}/integrations/${integrationId}/channels/-100/threads/7`,
      { trigger: 'off' },
      viewerToken
    )
    expect(denied.statusCode).toBe(403)
  })

  it('carries the threads on the integration DTO so the console can render them', async () => {
    const { integrationId } = await installTelegram()
    await report('d1', integrationId, [{ id: '-100', threads: [{ id: '7', name: 'Deploys' }] }])
    const read = await GET(`${ORG}/integrations/${integrationId}`)
    expect(read.json().channels[0].threads).toEqual([{ threadId: '7', name: 'Deploys', trigger: null }])
  })
})
```

Match the file's existing helpers for the viewer token (`installLinear`/`addLinearMember` show the pattern at `:120-172`); if the Telegram install here has no member harness, assert the gate through whichever install in this file does.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/control-plane test:int -- test/integration/integration-channels.test.ts -t "threads/:threadId"`
Expected: FAIL — 404 for the whole route.

- [ ] **Step 3: Write the minimal implementation**

`http/dto/index.ts` — beside `IntegrationChannelDto`:

```ts
/** One configurable thread of a conversation — a Telegram forum topic. `trigger: null` =
 *  inherit the conversation's, which is also what clearing an override returns it to. */
export const IntegrationChannelThreadDto = z.object({
  threadId: z.string(),
  name: z.string().nullable(),
  trigger: z.enum(['off', 'mention', 'mention_topic', 'any']).nullable()
})
```

and `threads: z.array(IntegrationChannelThreadDto)` inside `IntegrationChannelDto`, after `agentId`. The body, beside `UpdateIntegrationChannelBody`:

```ts
/** `PATCH /integrations/:id/channels/:channelId/threads/:threadId` — a topic's own trigger.
 *  `null` clears the override, returning the topic to its group's trigger. */
export const UpdateIntegrationChannelThreadBody = z.object({
  trigger: z.enum(['off', 'mention', 'mention_topic', 'any']).nullable()
})
```

`http/routes/integrations.ts` — the route, mirroring the channel PATCH at `:732-895` exactly: same `denyViewerWrite`, same 404-on-invisible / 403-on-uneditable agent gate, same persist-then-push sequence, same `release()` in a `finally`.

```ts
r.patch(
  '/integrations/:id/channels/:channelId/threads/:threadId',
  {
    schema: {
      tags: [Tag.Integrations],
      summary: 'Update a topic',
      description:
        "Set a Telegram forum topic's trigger, or clear it (null) to inherit the group's, then push the updated routing configuration.",
      operationId: 'updateIntegrationChannelThread',
      params: IdParam.extend({ channelId: z.string().min(1), threadId: z.string().min(1) }),
      body: UpdateIntegrationChannelThreadBody,
      response: { 200: IntegrationChannelThreadDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto }
    }
  },
  async (req, reply) => {
    if (denyViewerWrite(req, reply)) return
    const integration = await deps.repos.integration.get(orgIdOf(req), IntegrationId(req.params.id))
    if (!integration) {
      return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'integration not found' })
    }
    const agent = await deps.repos.agent.get(orgIdOf(req as never), integration.agentId)
    if (!agent || !canView(agent, ctxOf(req))) {
      return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'integration not found' })
    }
    if (!canEdit(agent, ctxOf(req))) {
      return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
    }
    const updated = await deps.repos.integrationChannel.setThreadTrigger(
      integration.id,
      req.params.channelId,
      req.params.threadId,
      req.body.trigger
    )
    if (!updated) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'topic not found' })
    // Same push as a conversation trigger: an HTTP bot hot-updates the relay's table, a
    // classic bot re-pushes its recomputed spec to the owning daemon.
    const bot = await deps.repos.bot.get(orgIdOf(req), integration.botId)
    if (bot?.transport === 'http') await deps.httpBot.syncRoutes(bot.id)
    else await replicateUpsert(integration, agent)
    return { threadId: updated.threadId, name: updated.name, trigger: updated.trigger }
  }
)
```

This route deliberately does NOT take the conversation mutation lease the channel route takes (`:817-837`): a topic write never moves a conversation's owner, so `effectiveOwner`/`selectedOwner`/`tryBeginMutation` have nothing to protect. If a reviewer disagrees, the cheap fix is to wrap the write in `tryBeginMutation([agent.id])` — but only with a test that shows a conflict it actually prevents.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/control-plane test:int -- test/integration/integration-channels.test.ts -t "threads/:threadId"`
Expected: PASS.

Run: `pnpm --filter @agentconnect.md/control-plane typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/http/dto/index.ts packages/control-plane/src/http/routes/integrations.ts packages/control-plane/test/integration/integration-channels.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(cp): a REST route for a topic's trigger, and threads on the channel DTO"
```

---

## Task 10: The MCP tool

**Files:**

- Modify: `packages/control-plane/src/http/mcp/tools.ts:985-1015` (`setChannelTrigger`)

**Interfaces:**

- Consumes: the route from Task 9.
- Produces: `setThreadTrigger` — the tool an agent uses to configure a topic.

- [ ] **Step 1: Write the failing test**

Find the MCP tool suite (`packages/control-plane/src/http/mcp/tools.test.ts`) and add a case in the shape of the existing `setChannelTrigger` test: assert the tool sends `PATCH` to the thread path with the body it was given, and that `trigger: null` survives the round trip.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/control-plane test:unit -- -t "setThreadTrigger"`
Expected: FAIL — the tool does not exist.

- [ ] **Step 3: Write the minimal implementation**

Alongside `setChannelTrigger` (`:985-1015`), matching its shape — `z.object().strict()`, a `description`, and `bodyOf(a, …)` to strip the path params from the body:

```ts
  {
    name: 'setThreadTrigger',
    description:
      'Change how an integration behaves in one thread of a conversation (a Telegram forum topic): the trigger mode (off / mention-only / any message), or null to inherit the conversation’s trigger again. A topic with its own trigger ignores its conversation’s entirely.',
    write: true,
    schema: z
      .object({
        integrationId: z.string().min(1).describe('The integration id (from listIntegrations)'),
        channelId: z.string().min(1).describe('The platform channel id (from listIntegrations channels)'),
        threadId: z.string().min(1).describe('The topic id (from listIntegrations channels[].threads)'),
        trigger: z
          .enum(['off', 'mention', 'mention_topic', 'any'])
          .nullable()
          .describe('null clears the topic’s own trigger, returning it to the conversation’s')
      })
      .strict(),
    call: (ctx, a) =>
      ctx.send(
        'PATCH',
        org(ctx, `/integrations/${seg(a.integrationId)}/channels/${seg(a.channelId)}/threads/${seg(a.threadId)}`),
        bodyOf(a, 'integrationId', 'channelId', 'threadId')
      )
  },
```

`trigger` is required here rather than optional-beside-`agentId` as in `setChannelTrigger`: this route has exactly one field, and `null` is a meaningful value rather than an omission.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/control-plane test:unit -- -t "setThreadTrigger"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/http/mcp/tools.ts packages/control-plane/src/http/mcp/tools.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(cp): an MCP tool for a topic's trigger"
```

---

## Task 11: Telegram's forum service records

**Files:**

- Modify: `packages/message/src/telegram-message.ts:62-84`
- Test: `packages/message/src/telegram-message.test.ts` (create — the package has no test file today)

**Interfaces:**

- Produces: `TelegramForumTopicCreated` / `Edited` / `Closed` / `Reopened` shapes on `TelegramMessage`; `telegramForumTopicId(message): string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `packages/message/src/telegram-message.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { telegramForumTopicId, type TelegramMessage } from './telegram-message.js'

const topicMessage = (over: Partial<TelegramMessage> = {}): TelegramMessage => ({
  message_id: 10,
  chat: { id: -100, type: 'supergroup' },
  message_thread_id: 7,
  is_topic_message: true,
  ...over
})

describe('telegramForumTopicId', () => {
  it('reads a topic id off a forum service record', () => {
    expect(telegramForumTopicId(topicMessage({ forum_topic_created: { name: 'Deploys' } }))).toBe('7')
    expect(telegramForumTopicId(topicMessage({ forum_topic_edited: { name: 'Releases' } }))).toBe('7')
  })

  it('reads a topic id off any message in a topic', () => {
    expect(telegramForumTopicId(topicMessage())).toBe('7')
  })

  it('reads nothing off a plain supergroup reply root — that is a session coordinate', () => {
    expect(
      telegramForumTopicId({ message_id: 10, chat: { id: -100, type: 'supergroup' }, message_thread_id: 10 })
    ).toBe(undefined)
  })

  it('reads nothing off a topic service record with no thread id', () => {
    expect(
      telegramForumTopicId({ message_id: 10, chat: { id: -100, type: 'supergroup' }, forum_topic_created: {} })
    ).toBe(undefined)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/message test -- -t "telegramForumTopicId"`
Expected: FAIL — the export does not exist.

- [ ] **Step 3: Write the minimal implementation**

In `packages/message/src/telegram-message.ts`, add the four service-record shapes to `TelegramMessage` (the Bot API's only way to learn a topic's name, since there is no listing call):

```ts
  /** Forum service records. The Bot API has no `getForumTopics`, so a topic's NAME is only
   *  ever learned from one of these — and a topic created while the bot was absent never
   *  produces one at all. */
  forum_topic_created?: { name?: string; icon_color?: number }
  forum_topic_edited?: { name?: string }
  forum_topic_closed?: Record<string, never>
  forum_topic_reopened?: Record<string, never>
```

and the helper, next to `telegramThread` (`:164-170`):

```ts
/** The forum topic a message belongs to, or undefined off a forum. `is_topic_message` is the
 *  discriminator: a plain supergroup's `message_thread_id` is a reply root, a session
 *  coordinate that never becomes a configurable topic. */
export function telegramForumTopicId(message: TelegramMessage): string | undefined {
  return message.is_topic_message === true ? telegramThread(message) : undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/message test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/message/src/telegram-message.ts packages/message/src/telegram-message.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(message): read Telegram's forum topic service records"
```

---

## Task 12: The daemon learns topics

**Files:**

- Modify: `packages/daemon/src/telegram/connection.ts:104-121` (`TelegramDeps`), `:300-316` (the service-message branch)
- Modify: `packages/daemon/src/telegram/normalize.ts` — re-export `telegramForumTopicId`
- Modify: `packages/daemon/src/platforms/connection-reconciler.ts:144-150` (host), `:566-580` (the Telegram construction)
- Test: `packages/daemon/test/telegram-connection.test.ts`

**Interfaces:**

- Consumes: `telegramForumTopicId` (Task 11).
- Produces: `TelegramDeps.onForumTopic?: (topic: { chatId: string; threadId: string; name?: string }) => void`; `ConnectionReconcilerHost.observeForumTopic(platform, topic, integrationIds)`.

**Two sources, one sink.** A topic the bot was present for arrives as `forum_topic_created`/`forum_topic_edited` with a name; a topic it was not present for arrives only as the `topicId` on any regular message — nameless until Telegram reports an edit.

- [ ] **Step 1: Write the failing test**

In `packages/daemon/test/telegram-connection.test.ts`, the membership-service test at `:183-214` is the template. Add:

```ts
it('reports a forum topic created by a service record, with its name', async () => {
  const topics: { chatId: string; threadId: string; name?: string }[] = []
  const { conn, bot } = makeConn({ onForumTopic: (t) => topics.push(t) })
  await conn.start()
  bot.emit({
    message_id: 10,
    chat: { id: -100, type: 'supergroup' },
    message_thread_id: 7,
    is_topic_message: true,
    forum_topic_created: { name: 'Deploys' }
  })
  expect(topics).toEqual([{ chatId: '-100', threadId: '7', name: 'Deploys' }])
})

it('reports a topic learned from traffic, with no name', async () => {
  const topics: { chatId: string; threadId: string; name?: string }[] = []
  const received: NormalizedMessage[] = []
  const { conn, bot } = makeConn({ onForumTopic: (t) => topics.push(t), onMessage: (m) => received.push(m) })
  await conn.start()
  bot.emit({
    message_id: 11,
    chat: { id: -100, type: 'supergroup' },
    message_thread_id: 7,
    is_topic_message: true,
    from: { id: 5, first_name: 'An' },
    text: 'hello'
  })
  expect(topics).toEqual([{ chatId: '-100', threadId: '7' }])
  // The topic report is a SIDE CHANNEL — the message still routes.
  expect(received).toHaveLength(1)
})

it('reports nothing for a plain supergroup reply root', async () => {
  const topics: unknown[] = []
  const { conn, bot } = makeConn({ onForumTopic: (t) => topics.push(t) })
  await conn.start()
  bot.emit({
    message_id: 12,
    chat: { id: -100, type: 'supergroup' },
    message_thread_id: 12,
    from: { id: 5, first_name: 'An' },
    text: 'reply'
  })
  expect(topics).toEqual([])
})
```

Match the file's `fakeBot`/`BotState` emit helper name from the membership test rather than inventing one.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/daemon test -- test/telegram-connection.test.ts`
Expected: FAIL — `onForumTopic` is never called.

- [ ] **Step 3: Write the minimal implementation**

`telegram/connection.ts` — the dep, beside `onBotAddedToChat` (`:114`):

```ts
  /** A forum topic learned from a service record or from a message inside it. Topics are
   *  config metadata: they never enter routing, and nothing is ever sent to Telegram. */
  onForumTopic?: (topic: { chatId: string; threadId: string; name?: string }) => void
```

In the service-message branch (`:300-316`), BEFORE the membership early-return, handle a record carrying a topic:

```ts
this.bot.onMessage((message) => {
  const topicId = telegramForumTopicId(message)
  const topicName = message.forum_topic_created?.name ?? message.forum_topic_edited?.name
  if (topicId !== undefined && topicName !== undefined) {
    this.deps.onForumTopic?.({ chatId: String(message.chat.id), threadId: topicId, name: topicName })
  }
  if (isTelegramMembershipServiceMessage(message)) {
    // ... unchanged
  }
  const msg = normalizeTelegramMessage(message, { traceId: this.deps.newTraceId() })
  if (msg.topicId !== undefined) {
    this.deps.onForumTopic?.({ chatId: msg.channel, threadId: msg.topicId })
  }
  // ... the existing debug log and onMessage
})
```

Note the two guards that matter: the service-record branch fires only when the record NAMES the topic (a topic `closed`/`reopened` record carries no name and would otherwise re-report a nameless topic on every open/close), and the traffic branch reads `msg.topicId`, which `normalizeTelegramMessage` emits only for `is_topic_message === true` (`telegram-message.ts:239`).

`telegram/normalize.ts` — add `telegramForumTopicId` to the re-export list.

`platforms/connection-reconciler.ts` — the host interface gains `observeForumTopic(platform: string, topic: ObservedChat & { threadId: string }, integrationIds: readonly string[]): Promise<void>` beside `observeTelegramChat` (`:144`), and the Telegram construction at `:576` gains `onForumTopic` beside `onBotAddedToChat`, resolving `integrationIds` from the same group.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/daemon test -- test/telegram-connection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/telegram/connection.ts packages/daemon/src/telegram/normalize.ts packages/daemon/src/platforms/connection-reconciler.ts packages/daemon/test/telegram-connection.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(daemon): learn forum topics from service records and from traffic"
```

---

## Task 13: The sync engine records a topic on its channel row

**Files:**

- Modify: `packages/daemon/src/platforms/observed-channels-sync.ts:27-38` (host), `:189-254` (`observeTelegramChat` / `observePlatformChats`)
- Modify: `packages/daemon/src/daemon.ts:1745-1750` (the delegate block)
- Test: `packages/daemon/test/observed-channels-sync.test.ts`

**Interfaces:**

- Consumes: `observeForumTopic` (Task 12).
- Produces: `ObservedChannelsSync.observeForumTopic(platform, topic, integrationIds): Promise<void>`.

**The `if (!chat.name) continue` at `:209` is why this needs its own method.** That gate exists because an unnamed chat's row would render blank — but a topic learned from traffic has no name, and its ID is the row's only identity. The topic path bypasses the name gate deliberately; the console prints `Topic <id>` for it (Task 21).

- [ ] **Step 1: Write the failing test**

In `packages/daemon/test/observed-channels-sync.test.ts`, the `harness()` factory sets `integrationConfigById: () => ({ id: INTEGRATION, platform: 'linear' })`. Add a telegram variant and:

```ts
describe('observeForumTopic — a thread on an observed conversation', () => {
  it('adds a topic to the channel row and re-emits, and is idempotent', async () => {
    const { sync, snapshots, reports } = telegramHarness()
    await sync.observePlatformChats('telegram', [{ id: '-100', name: 'General', isPrivate: false }], [INTEGRATION])
    await sync.observeForumTopic('telegram', { id: '-100', name: 'General', isPrivate: false, threadId: '7' }, [
      INTEGRATION
    ])
    expect(rows(snapshots)[0]?.threads).toEqual([{ id: '7' }])

    // A second observation of the same topic reports nothing new.
    const before = reports.length
    await sync.observeForumTopic('telegram', { id: '-100', name: 'General', isPrivate: false, threadId: '7' }, [
      INTEGRATION
    ])
    expect(reports).toHaveLength(before)
  })

  it('learns a name once and never unlearns it', async () => {
    const { sync, snapshots } = telegramHarness()
    await sync.observePlatformChats('telegram', [{ id: '-100', name: 'General', isPrivate: false }], [INTEGRATION])
    await sync.observeForumTopic(
      'telegram',
      { id: '-100', name: 'General', isPrivate: false, threadId: '7', forumName: 'Deploys' },
      [INTEGRATION]
    )
    await sync.observeForumTopic('telegram', { id: '-100', name: 'General', isPrivate: false, threadId: '7' }, [
      INTEGRATION
    ])
    expect(rows(snapshots)[0]?.threads).toEqual([{ id: '7', name: 'Deploys' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/daemon test -- test/observed-channels-sync.test.ts -t "observeForumTopic"`
Expected: FAIL — the method does not exist.

- [ ] **Step 3: Write the minimal implementation**

`observed-channels-sync.ts` — a sibling of `observeTelegramChat` (`:189`), sharing `observePlatformChats`' merge so the change-detection and the re-emit stay in ONE place:

```ts
  /** Record one forum topic on its conversation's cached row. A topic learned from traffic
   *  has no name, and is reported anyway: the id is the row's identity, and the name gate in
   *  `observePlatformChats` would drop it as a blank row. */
  async observeForumTopic(
    platform: string,
    topic: ObservedChat & { threadId: string; forumName?: string },
    integrationIds: readonly string[]
  ): Promise<void> {
    if (topic.forumName) await this.host.store().setDisplayName(topic.id, topic.forumName, Date.now())
    const snapshots = this.host.channelSnapshots()
    for (const integrationId of integrationIds) {
      const integration = this.host.integrationConfigById(integrationId)
      if (!integration || integration.platform !== platform) continue
      const channels = snapshots.get(integrationId)?.channels ?? []
      const current = channels.find((channel) => channel.id === topic.id)
      const held = current?.threads ?? []
      const known = held.find((t) => t.id === topic.threadId)
      // A name is learned once and never unlearned, like a channel's glyph: a traffic-only
      // observation carries none and must not blank one a service record supplied.
      const next = known
        ? held.map((t) => (t.id === topic.threadId ? { ...t, ...(topic.forumName ? { name: topic.forumName } : {}) } : t))
        : [...held, { id: topic.threadId, ...(topic.forumName ? { name: topic.forumName } : {}) }]
      if (known && known.name === topic.forumName) continue
      const observed: IntegrationChannel = { ...current, id: topic.id, threads: next }
      const channelsNext = current
        ? channels.map((channel) => (channel.id === topic.id ? observed : channel))
        : [...channels, observed]
      snapshots.set(integrationId, { channels: channelsNext, authoritative: false })
      this.host.cpClient()?.emitIntegrationChannels({ integrationId, channels: channelsNext, authoritative: false })
    }
  }
```

`daemon.ts:1745-1750` — add the delegate beside the three existing ones:

```ts
      observeForumTopic: (platform, topic, integrationIds) =>
        this.observedChannelsSync.observeForumTopic(platform, topic, integrationIds),
```

`platforms/connection-reconciler.ts`'s `onForumTopic` (Task 12) resolves `integrationIds` and calls `this.host.observeForumTopic('telegram', { ...topic, forumName: topic.name }, [...integrationIds])` — the `forumName` field is the topic's own name, distinct from the conversation's `name` in the same object.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/daemon test -- test/observed-channels-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/platforms/observed-channels-sync.ts packages/daemon/src/daemon.ts packages/daemon/src/platforms/connection-reconciler.ts packages/daemon/test/observed-channels-sync.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(daemon): report a forum topic on the conversation row it belongs to"
```

---

## Task 14: The console's row type and API bindings

**Files:**

- Modify: `packages/web/src/lib/api.ts:880` (`ChannelTrigger`), `:885-898` (`IntegrationChannelDto`), after `:4361` (`updateIntegrationChannelThread`)
- Modify: `packages/web/src/lib/data.ts:2122-2158` (`IntegrationChannelRow`)

**Interfaces:**

- Consumes: the CP DTO (Task 9).
- Produces: `IntegrationChannelThreadDto`; `IntegrationChannelRow.threads?: IntegrationChannelThreadRow[]`; `updateIntegrationChannelThread(integrationId, channelId, threadId, patch: { trigger: ChannelTrigger | null })`.

- [ ] **Step 1: Write the failing check**

There is no unit test for a type widening; the check is `pnpm typecheck` after the console reads the field in Task 21.

- [ ] **Step 2: Confirm the check fails**

Run: `pnpm --filter @agentconnect.md/web typecheck`
Expected: PASS today — it must still pass after the change too. This step exists to establish the baseline, not to fail.

- [ ] **Step 3: Write the minimal implementation**

`api.ts`:

```ts
/** One configurable thread of a conversation — a Telegram forum topic. `trigger: null` =
 *  inherit the conversation's, which is also what clearing an override returns it to. */
export interface IntegrationChannelThreadDto {
  threadId: string
  name: string | null
  trigger: ChannelTrigger | null
}
```

and `threads?: IntegrationChannelThreadDto[]` on `IntegrationChannelDto`.

```ts
// Per-topic trigger choice (`PATCH /integrations/:id/channels/:channelId/threads/:threadId`).
// `trigger: null` clears the override, returning the topic to its group's trigger.
export async function updateIntegrationChannelThread(
  integrationId: string,
  channelId: string,
  threadId: string,
  patch: { trigger: ChannelTrigger | null },
  orgId?: string
): Promise<IntegrationChannelThreadDto> {
  return apiPatch<IntegrationChannelThreadDto>(
    `${orgBase(orgId)}/integrations/${encodeURIComponent(integrationId)}/channels/${encodeURIComponent(
      channelId
    )}/threads/${encodeURIComponent(threadId)}`,
    patch
  )
}
```

`data.ts` — on `IntegrationChannelRow`:

```ts
  /** The conversation's own configurable threads (Telegram forum topics), where the platform
   *  reports them. Absent everywhere else, and absent until the daemon has learned one. */
  threads?: { threadId: string; name: string | null; trigger: 'off' | 'mention' | 'mention_topic' | 'any' | null }[]
```

- [ ] **Step 4: Run the check to verify it passes**

Run: `pnpm --filter @agentconnect.md/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/lib/data.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(web): carry a conversation's threads from the API"
```

---

## Task 15: `setThreadTrigger` in the data context

**Files:**

- Modify: `packages/web/src/lib/data-context.tsx:1415-1440` (beside `setChannelTrigger`)
- Test: none — Task 22's component test drives it through the mock provider.

**Interfaces:**

- Consumes: `updateIntegrationChannelThread` (Task 14).
- Produces: `setThreadTrigger(integrationId: string, channelId: string, threadId: string, trigger: ChannelTrigger | null): Promise<void>` on the console context.

- [ ] **Step 1: Write the failing test**

Deferred to Task 22 — the component test asserts the write lands, which is this function's only observable effect. Skipping a placeholder test here is deliberate: a test asserting a mock was called proves nothing the component test does not.

- [ ] **Step 2: Confirm it fails**

Run: `pnpm --filter @agentconnect.md/web test -- IntegrationChannelList.trigger`
Expected: PASS today (the topic UI does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Beside `setChannelTrigger` (`:1415-1440`), with the same bot-wide fan-out — a Telegram integration is never shareable (`multiAgentShareable: false`), but the projection is written once and must not special-case a platform:

```ts
// Set or clear one topic's trigger. `null` clears it back to inheriting the group's.
// Same projection as the conversation toggle, so a shared bot stays consistent bot-wide.
const setThreadTrigger = useCallback(
  async (integrationId: string, channelId: string, threadId: string, trigger: ChannelTrigger | null) => {
    await updateIntegrationChannelThread(integrationId, channelId, threadId, { trigger })
    settleInBackground(
      mutateIntegrations(
        (rows) => {
          const source = rows?.find((row) => row.id === integrationId)
          if (!rows || !source) return rows
          const botWide = realBots.some((bot) => bot.id === source.botId && bot.shareable)
          return rows.map((row) =>
            (botWide ? row.botId === source.botId : row.id === integrationId)
              ? {
                  ...row,
                  channels: row.channels.map((channel) =>
                    channel.channelId === channelId
                      ? {
                          ...channel,
                          threads: channel.threads?.map((t) => (t.threadId === threadId ? { ...t, trigger } : t))
                        }
                      : channel
                  )
                }
              : row
          )
        },
        { revalidate: false }
      )
    )
  },
  [mutateIntegrations, realBots]
)
```

Export it from the context value beside `setChannelTrigger`, and add `updateIntegrationChannelThread` to the api import block.

- [ ] **Step 4: Run the check to verify it passes**

Run: `pnpm --filter @agentconnect.md/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/data-context.tsx
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(web): write a topic's trigger through the console data context"
```

---

## Task 16: The list-semantics contract

**Files:**

- Modify: `packages/web/src/components/console/platforms/contract.ts:536-582` (`WebChannelListSemantics`)
- Modify: `packages/web/src/components/console/platforms/telegram/index.tsx:31-40`

**Interfaces:**

- Produces: `WebChannelListSemantics.threadTriggers?: readonly ('off' | 'mention' | 'mention_topic' | 'any')[]`.

- [ ] **Step 1: Write the failing test**

Add a case to `packages/web/src/components/console/platforms/platform-set.test.tsx` — the registry's own suite, which already iterates `platformRegistry.ids()` and imports `channelListSemantics` from `./registry` (`:16`). Assert `channelListSemantics('telegram').threadTriggers` is the four values and that every other module's is `undefined`, so a platform added later cannot silently inherit topic controls:

```ts
it('declares configurable threads only where a real sub-conversation exists', () => {
  expect(channelListSemantics('telegram').threadTriggers).toEqual(['off', 'mention', 'mention_topic', 'any'])
  for (const id of platformRegistry.ids()) {
    if (id !== 'telegram') expect(channelListSemantics(id).threadTriggers, id).toBeUndefined()
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/web test -- platform-set`
Expected: FAIL — `threadTriggers` is `undefined` on telegram.

- [ ] **Step 3: Write the minimal implementation**

`contract.ts`, beside the existing `triggers` field:

```ts
  /** Whether a conversation's rows can carry their own trigger. Only a platform with a real
   *  sub-conversation — Telegram forum topics — declares it, and one that declares nothing
   *  renders no disclosure at all. */
  threadTriggers?: readonly ('off' | 'mention' | 'mention_topic' | 'any')[]
```

`platforms/telegram/index.tsx`, beside `triggers` (`:39`):

```ts
// A forum topic may carry its own trigger, overriding its group's entirely.
threadTriggers: ['off', 'mention', 'mention_topic', 'any']
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/web test -- platform-set`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/console/platforms/contract.ts packages/web/src/components/console/platforms/telegram/index.tsx packages/web/src/components/console/platforms/platform-set.test.tsx
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(web): declare which platforms have configurable threads"
```

---

## Task 17: The nested disclosure and the topic rows

**Files:**

- Modify: `packages/web/src/components/console/IntegrationChannelList.tsx` — `TriggerToggle` (`:18-80`), `row` (`:646-713`)
- Test: `packages/web/src/components/console/IntegrationChannelList.trigger.test.tsx`

**Interfaces:**

- Consumes: `channelListSemantics(platform).threadTriggers` (Task 16); `setThreadTrigger` (Task 15).
- Produces: the topic rows, each with a `TriggerSelect` carrying a fifth `'inherit'` value.

**Two display rules the spec is explicit about:**

- `'inherit'` is a display-only sentinel; the wire value is `null`. Keeping it a string avoids widening `TriggerSelect`'s `T extends string` (`TriggerSelect.tsx:33`) for one caller.
- `Follow group` is offered whether or not the row holds an override. Picking it on an already-cleared row is the no-op `TriggerToggle` already short-circuits (`:33`) — so the one control reads the row's state instead of appearing and disappearing.
- The disclosure must stay visible under an `off` group row: `off` no longer guarantees the group is entirely silent (spec Risks).

- [ ] **Step 1: Write the failing test**

Extend `packages/web/src/components/console/IntegrationChannelList.trigger.test.tsx`. Its `menuFor(platform)` renders with one channel; add a threads-aware variant and the topic cases:

```tsx
const topicMenuFor = (threads: { threadId: string; name: string | null; trigger: ChannelTrigger | null }[]) =>
  renderList({
    platform: 'telegram',
    integrationId: 'int-1',
    gated: false,
    channels: [{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: 'mention', threads }]
  })

it('offers Follow group plus the four values on a topic', async () => {
  const menu = await topicMenuFor([{ threadId: '7', name: 'Deploys', trigger: null }])
  expect(menu('Topic Deploys')).toEqual(['Follow group', 'off', 'any message', '@-mention', '@-mention + reply'])
})

it('offers Follow group on a topic that already inherits, so clearing is reachable without setting one', async () => {
  const items = await topicMenuFor([{ threadId: '7', name: 'Deploys', trigger: null }])
  const follow = items.find((i) => i.textContent === 'Follow group')
  expect(follow?.getAttribute('aria-checked')).toBe('true')
})

it('writes null when Follow group is picked on a topic that holds an override', async () => {
  const items = await topicMenuFor([{ threadId: '7', name: 'Deploys', trigger: 'off' }])
  items.find((i) => i.textContent === 'Follow group')!.click()
  await waitFor(() => expect(setThreadTrigger).toHaveBeenCalledWith('int-1', 'C1', '7', null))
})

it('prints Topic <id> for a topic whose name Telegram never reported', async () => {
  expect(await topicMenuFor([{ threadId: '9', name: null, trigger: null }])).toContain('Topic 9')
})

it('renders no disclosure on a platform that declares no threadTriggers', async () => {
  expect(await menuFor('slack')).not.toContain('Follow group')
})
```

The existing `menuFor` returns label strings; these cases need the elements, so extend it to return them and keep the three existing assertions reading `.textContent`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentconnect.md/web test -- IntegrationChannelList.trigger`
Expected: FAIL — no topic rows render.

- [ ] **Step 3: Write the minimal implementation**

In `TriggerToggle`, add the inherit option for a thread context. The cleanest shape is a second prop rather than a second component:

```tsx
/** The topic control: the conversation one plus a display-only `inherit`. The wire value
 *  behind it is `null`, which is what clearing a topic's override writes. */
function ThreadTriggerToggle({
  channel,
  thread,
  platform,
  disabled,
  onChange
}: {
  channel: IntegrationChannelRow
  thread: NonNullable<IntegrationChannelRow['threads']>[number]
  platform?: string
  disabled: boolean
  onChange: (trigger: ChannelTrigger | null) => void
}) {
  const [saving, setSaving] = useState(false)
  const value = thread.trigger ?? 'inherit'
  const allowed = channelListSemantics(platform).threadTriggers ?? []
  const options: TriggerOption<'inherit' | ChannelTrigger>[] = [
    { value: 'inherit', label: 'Follow group', hint: `Uses the trigger set for ${rowLabel(channel)}.` },
    ...roomOptionsFor(channel, platform).filter((o) => allowed.includes(o.value))
  ]
  const pick = (next: 'inherit' | ChannelTrigger) => {
    if (disabled || saving || next === value) return
    setSaving(true)
    Promise.resolve(onChange(next === 'inherit' ? null : next)).finally(() => setSaving(false))
  }
  return (
    <TriggerSelect
      options={options}
      value={value}
      onChange={pick}
      ariaLabel={`Trigger for ${thread.name ?? `Topic ${thread.threadId}`}`}
      hint="Topic trigger — overrides the group's"
      disabled={disabled}
      busy={saving}
      className="max-desktop:w-full"
    />
  )
}
```

Extract the existing `roomOptions` array in `TriggerToggle` (`:47-60`) into a module-level `roomOptionsFor(channel, platform)` so both controls read one list — a second copy would drift.

In `row(c)` (`:646-713`), after the trigger toggle, add the disclosure and the topic rows. The disclosure is a `button` with `aria-expanded`, and its rows render inside the same parent `div` so the CSS border reads as part of the conversation:

```tsx
{
  /* A topic with its own trigger ignores the group entirely, so this stays visible
              even under an `off` row — off is no longer a guarantee the group is silent. */
}
{
  threads.length > 0 && (
    <button
      type="button"
      aria-expanded={openThreads}
      aria-label={`Topics of ${rowLabel(c)}`}
      onClick={() => setOpenThreads((v) => !v)}
      className="iconbtn h-6 w-6 flex-none"
    >
      <Icon name={openThreads ? 'chevron-down' : 'chevron-right'} size={13} color="var(--text-tertiary)" />
    </button>
  )
}
```

with `const [openThreads, setOpenThreads] = useState<Record<string, boolean>>({})` on the list component, keyed by `channelId` (a per-row `useState` inside `row` would reset on every parent render — the list re-renders on each mutation).

The nested rows render in the band map after `row(c)`, at a deeper indent so the nesting is visible:

```tsx
{
  g.rows.map((c) => (
    <Fragment key={c.channelId}>
      {row(c)}
      {openThreads[c.channelId] &&
        (c.threads ?? []).map((t) => (
          <div
            key={t.threadId}
            className="flex flex-wrap items-center gap-x-[10px] gap-y-2 border-t border-(--border-subtle) bg-(--surface-sunken)"
            style={{ padding: `8px ${padX + 18}px` }}
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-(--text-secondary)">
              {t.name ?? `Topic ${t.threadId}`}
            </span>
            <ThreadTriggerToggle
              channel={c}
              thread={t}
              platform={platform}
              disabled={!integrationId}
              onChange={(trigger) => setThreadTrigger(integrationId!, c.channelId, t.threadId, trigger)}
            />
          </div>
        ))}
    </Fragment>
  ))
}
```

Add `setThreadTrigger` to the `useConsoleData()` destructure (`:566`), and import `ChannelTrigger` from `@/lib/api`.

The `dmRows.map(row)` call at `:743` stays as it is: a DM has no threads.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentconnect.md/web test -- IntegrationChannelList.trigger`
Expected: PASS.

Run: `pnpm --filter @agentconnect.md/web test`
Expected: PASS — the three existing menu cases still assert the same labels.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/console/IntegrationChannelList.tsx packages/web/src/components/console/IntegrationChannelList.trigger.test.tsx
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "feat(web): nested topic rows with their own trigger control"
```

---

## Task 18: Product documentation

**Files:**

- Modify: `docs/product-conventions.md:548-606` ("Per-conversation trigger")

**Interfaces:**

- Produces: the topic paragraph — product behavior, so it is part of this change, not a follow-up.

- [ ] **Step 1: Write the failing check**

Read `:548-606`. The section states what a trigger means; it currently says nothing about topics. The check is that a reader can answer "what happens if I set a topic differently from its group" from this file alone. Today they cannot.

- [ ] **Step 2: Confirm the gap**

Quote the section's current topic-silence in the commit message body.

- [ ] **Step 3: Write the paragraph**

After the existing "Per-conversation trigger" consequences, before "Leaving a conversation and removing its row":

```markdown
### A topic's own trigger (Telegram forum supergroups)

A Telegram forum topic starts out following its group's trigger, and the console offers it
for separate configuration once the daemon has seen it. A topic that carries its own trigger
ignores the group's **entirely** — the group's rules and its fences both:

- `off` on a topic is that topic's own silence, not the group's. The topic stays silent even
  when the group is loud, and a topic set to anything else stays live even when the group is
  `off` — which is the one way to say "quiet group, one live topic". `off` at the group level
  is therefore no longer a guarantee that the group is entirely silent.
- `mention` on a topic is that topic's own @-mention rule. The group's "any message" does not
  reach into it.
- `mention_topic` on a topic keeps the "answer only when addressed" promise inside it, without
  extending it to topics the operator never meant.

A topic is listed on its group's row in the console, behind a disclosure. Its trigger control
carries **Follow group** (the default, and what a newly detected topic gets) plus the same four
values a conversation takes. Picking Follow group removes the topic's trigger and returns it to
inheriting, which is also the only removal here: nothing is deleted at Telegram and a topic
Telegram has dropped cannot be told apart from one nobody has mentioned lately, so the row stays
and an inert row is the remedy. A topic whose name Telegram has not reported prints `Topic <id>`.
```

- [ ] **Step 4: Verify it reads correctly**

Read the whole section top to bottom. The four-value vocabulary and the @-mention/reply semantics above it must still hold, and the new paragraph must not restate them.

- [ ] **Step 5: Commit**

```bash
git add docs/product-conventions.md
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "docs: a topic's trigger is its own, and ignoring its group is the point"
```

---

## Self-Review

**1. Spec coverage.** Every work item 1–23 maps to a task: 1→1, 2→2, 3–4→5, 5–6→6, 7→7, 8→8, 9→9, 10→9, 11→10, 12→11–12, 13→13, 14–16→3, 17→4, 18→14, 19→16, 20→17, 21→16, 22→15, 23→18. The spec's §7 console paragraph is Task 17; its §6 detection is Tasks 11–13; §8 docs is Task 18.

**2. Where this plan corrects the spec.**

- The spec's work item 7 names one helper, `threadOverrides`. This plan uses two — `overriddenThreadRefs` (the fence) and `threadRows` (the `{channel, thread, trigger}` rows every fold reads) — because three folds read the rows and only one wants the ref. An executor looking for `threadOverrides` will not find it.
- The spec's work item 17 says "five `conversationAdmitted` call sites" and lists four. There are four; Task 4 also covers `admittedAgentIds`, which the spec omits, and notes `admittedSessions` already carries `thread?`.
- The spec omits `conversationAdmitsAgent` (`activation-policy/src/index.ts:263-269`) and its explicit-signature caller `resolveCpAgent` (`daemon.ts:9908-9913`). Both widen in Tasks 2 and 4.
- The spec's §2 says `affinityAdmits` widens "to the rule's two fence fields". It takes the rule, because the answer depends on `overriddenThreads`.
- Task 8 is a verification step that may produce no diff. That is the honest outcome of the spec's own claim that the handler needs "no other change".

**2b. Corrections the first Self-Review pass found in this plan itself.**

- Task 16 cited `platforms/registry.test.ts`, which does not exist. The registry's suite is `platforms/platform-set.test.tsx`, which already imports `channelListSemantics` and iterates `platformRegistry.ids()` (`:16`, `:70`).
- Task 7's `mutedChannelIds` first draft returned `topics` under `gated`, contradicting the function's own gated early-return and Task 7's gated test. It returns `[]` when gated.
- Task 4 cited `packages/daemon/test/commands.test.ts`, which covers `parseCommand` alone and has no agent fixture. The command path's harness is `daemon-commands.test.ts` (`describe` at `:138`, `makeRoutable` at `:97`).
- `conversationAdmitted`'s third parameter is REQUIRED, not defaulted. With a default, Task 4's typecheck would pass while a call site silently missed the feature; with it required, the compiler names all four. That in turn means Task 3 must append `, undefined` to the four existing calls at `:286-310`.

**3. Type consistency.** `ScopeRef`/`ThreadRef` are defined once (Task 1) and imported everywhere after. `IntegrationChannelThreadRecord` (Task 6) has `trigger: ChannelTrigger | null`; the wire `IntegrationChannelThread` (Task 1) has no `trigger` at all — the daemon reports presence, the CP owns the value. The console's `IntegrationChannelThreadDto` (Task 14) carries all three. `setThreadTrigger` is the same name in the port (Task 6), the repo (Task 6), the context (Task 15) and the MCP tool (Task 10) — the MCP one differs only in taking `integrationId` first, matching its sibling `setChannelTrigger`.

**4. Relay safety, stated once.** The relay reads its OWN `mutedChannels` (`activation-policy/src/index.ts:609`, off `SharedBotAssignmentFacts.mutedChannels?: string[]`) and its own `RcBotAssign.mutedChannels: z.array(z.string())` (`frames/relay-cp.ts:899`), both built independently by `httpBot.compile` from channel rows. Widening the `IntegrationCoreEnvelope` fences in Task 1 therefore cannot leak an object into relay arbitration — the two share a field NAME and nothing else. Telegram is also `multiAgentShareable: false`, so the relay path never carries a Telegram bot at all.

**5. Review Focus coverage.** All five lines name a task and a test: (1) Tasks 4 and 7, (2) Tasks 4 and 7, (3) Tasks 7, 9 and 17, (4) Tasks 2 and 4, (5) Tasks 11 and 12.
