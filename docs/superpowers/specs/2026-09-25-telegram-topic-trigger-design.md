# A reply-aware trigger for Telegram groups and topics

**Status:** design, awaiting review
**Base:** tag `v1.60.0` — the deployed version per the `agentconnect-v160-agents-itxom` runbook
(that runbook lives in the notes repo, not in this clone). Every line number below is a `v1.60.0`
line number.
**Scope:** fork-only (`bacnv/agentconnect`). Upstream has no topic-aware routing; see *Upstream divergence*.

## Problem

A Telegram group or forum topic cannot currently be made quiet without being made unreachable.

Routing (`packages/activation-policy/src/index.ts:186`) puts **thread affinity** second, above
every kind-based rung and below only an explicit @-mention. Affinity is kind-agnostic and asks
one question: *does this thread have an open session?* Telegram's session coordinate comes from
`canonicalizeTelegramThread` (`packages/daemon/src/platforms/telegram/threading.ts:45`), which
sets `msg.thread = topicId` for a forum topic. So the **entire topic is one thread**, and once the
agent has an open session in it — after any single @-mention — affinity routes every subsequent
message to that agent.

The operator's available choices today are both wrong for this:

- `@-mention` — the honest label ("Follow-ups in a thread it has joined don't need another
  mention"), but in a topic that thread *is* the topic, so the promise of quiet is broken.
- `off` — the agent is then unreachable: `product-conventions.md` states Off takes no @-mention,
  no follow-up, and no control command. There is no way to say "answer me when I address you".

The user's framing: *in a Telegram topic, the agent should only answer when @-mentioned or when
someone replies to one of its own messages.*

## Goal

A fourth per-conversation trigger, opt-in, that in one conversation:

- still answers an explicit @-mention;
- still answers a reply to **one of that agent's own messages**;
- **stops** answering everything else, which affinity would otherwise deliver.

Success: an existing channel keeps its exact behavior after deploying. Only a conversation whose
operator explicitly selects the new value changes.

## Non-goals

- No change to `off`, `mention`, or `any` behavior anywhere.
- No change to `!stop` semantics (see §4: a reply does **not** clear a mute).
- No shared-bot / relay implementation. Telegram has no HTTP callback ingress
  (`packages/control-plane/src/platforms/telegram/provider.ts:147`), so `placement.ts` is the only
  compiler on the path that matters.
- No change to explicit agent-to-agent delivery. A hand-off or a scheduled post still reaches a
  conversation whose trigger would silence human chatter — the same invariant Off already holds
  (`docs/product-conventions.md:505-535`).

## Naming deviation — read this first

The agreed display name is **"@-mention + reply"**. The agreed stored value was `mention-topic`,
but a hyphen is not a legal Prisma enum value, and no enum in this schema uses `@map`. Every
multi-word value here is snake_case (`tool_call`, `awaiting_permission`, `request_changes`,
`per_turn`). This spec therefore uses **`mention_topic`** as the stored value, and the display
label stays as agreed. Say so now if the hyphen matters; it would cost a `@map` on an enum value
with no precedent in the file.

## Design

### 1. The reply is already half-built

Telegram already promises exactly this behavior on the user-facing side:
`TELEGRAM_CONTINUE_HINT` (`packages/daemon/src/telegram/render.ts:71`) is appended to the last
message of every agent turn — *"↩️ To continue this topic, please reply to this message."* The
mechanism behind it is `canonicalizeTelegramThread`, which for a reply resolves the replied-to
message's session out of the transcript via `telegramThreadForMessage`
(`packages/daemon/src/store/local-store.ts:4825`).

Two facts make the reply half cheap to finish:

1. That transcript row is written for the agent's **own** posts with `ts` = the real provider
   message id and `sender` = the agent id
   (`packages/daemon/src/platforms/telegram/turn-output.ts:105-109`, asserted in
   `packages/daemon/test/telegram-threading.test.ts:745-755`).
2. The same row is already being fetched for the thread. It carries a `sender` column
   (NOT NULL, `local-store.ts:1361`) that nothing currently reads.

So resolving "who authored the message being replied to" needs no new query, no new table, no new
`getMe` call, no username normalization, and no wire change. It is one extra column on a lookup
that already happens.

### 2. A new message fact: `replyToAuthor`

`ActivationMessageFacts` (`packages/activation-policy/src/index.ts:47`) gains one optional fact:

```ts
/** The transcript author of the message this one replies to, where the platform can
 *  resolve it. An agent id when the replied-to message was one of ours, a platform
 *  user id when it was a person's, undefined when nothing resolvable. */
replyToAuthor?: string
```

It is **daemon-internal**, declared on the daemon's `NormalizedMessage` alongside `transcriptTs`
and `transportScope` (`packages/daemon/src/messages/normalized.ts`) — never on the protocol
schema, never on the wire. It is computed post-parse, so no relay or protocol frame changes.

**Producer.** `canonicalizeTelegramThread` restructures so the reply lookup happens on every reply
path, not only the non-topic one:

```ts
if (msg.platform !== 'telegram' || msg.thread !== undefined) return
if (msg.isDm) {
  // Reordered ahead of the lookup: a DM is one continuous session and its rows carry the
  // binary Off/On control, never this trigger, so the reply author is never consulted.
  msg.thread = 'dm'
  return
}
// ONE lookup answers both questions — which session the replied-to message belongs to, and
// who authored it (the row already carries `sender`). A forum topic needs only the second,
// and the non-topic reply path needs both, so the lookup sits ahead of the branch.
const reply = msg.replyTo !== undefined ? await host.threadForMessage(transcriptChannel, msg.replyTo) : undefined
if (reply?.sender !== undefined) msg.replyToAuthor = reply.sender
const topicId = msg.topicId
if (topicId !== undefined) { msg.thread = topicId; return }   // ← today nothing precedes this
const threadRoot = msg.threadRoot
if (threadRoot !== undefined) { msg.thread = `tg:${threadRoot}`; return }
if (msg.replyTo) { msg.thread = reply?.thread ?? `tg:${msg.replyTo}`; return }
msg.thread = `tg:${telegramMessageId(msg)}`
```

Note the `threadRoot` branch is *not* wasted work: a reply in a plain (non-forum) Telegram
supergroup carries `message_thread_id` and therefore takes that branch, and `mention_topic` is
offered for those rows too (§6). The DM case is the only one reordered away.

`TelegramThreadingHost.threadForMessage` widens its return to `{ thread: string; sender: string }`
and `LocalStore.telegramThreadForMessage` selects `sender` beside `thread`. Name unchanged: the
thread is still the call's primary job.

Cost: a reply now costs one lookup wherever it previously cost none — i.e. in forum topics (the
non-topic reply path already paid it, and DMs still pay nothing). Deliberate: the fact is the same
one Telegram's own hint promises, so it belongs to the message rather than to a trigger mode.
Query shape is unchanged, so no index question.

### 3. A new subtractive fence: `affinityDenied`

`off` compiles to a `mutedChannels` fence — "the integration is silenced here". `mention` compiles
to **no** positive rule, because the unscoped default mention+dm rules already cover it. The new
mode has the same shape as `off`: no positive rule is needed (the mention default covers the
mention half), and the subtraction is what has to be stated.

`ActivationRule` (`index.ts:37`) and the wire envelope (`IntegrationCoreEnvelope`,
`packages/protocol/src/frames/integration.ts:146`) gain:

```ts
/** Conversations whose trigger requires an explicit address (mention or reply): the
 *  implicit continuity rungs are denied here, so an open session alone never delivers. */
affinityDenied?: string[]        // rule carrier
affinityDenied: z.array(z.string()).default([])   // envelope
```

Carried per rule for the same reason `mutedChannels` is ("so the ladder stays pure and every rung
is fenced by the one scope filter"), and defaulted on the wire so an old CP/daemon pair is
unaffected in either direction.

**It must not live in `scopeMatches`.** That predicate is the *delivery* fence: putting it there
would kill @-mentions too, which is precisely what `off` does and this must not. It is a separate
predicate, consulted at exactly the two rungs that implement implicit continuity:

```ts
/** Is `agentId` reachable here by continuity alone — an open session, not an address? */
function continuityAdmits(r: ActivationRule, msg: ActivationMessageFacts): boolean {
  if (!r.affinityDenied?.some((denied) => channelInScope(denied, msg))) return true
  return msg.replyToAuthor !== undefined && msg.replyToAuthor === r.agentId
}
```

**Rung 2** (`index.ts:186`) applies it to the owner rule it is about to pick:

```ts
const ownerRule = scopeCandidates.find((x) => x.agentId === owner && continuityAdmits(x, msg))
if (ownerRule) return pickRule(ownerRule, 'thread')
```

**`participantAgents`** (`index.ts:119`) applies the same predicate to the servable set. This is
the second trap and it is not optional: `fanOutToThreadPeers` (`daemon.ts:7373`) dispatches to
every thread participant, filtered only by `scopeMatches`. A rung-2-only change would leave the
fan-out still delivering.

```ts
const servable = new Set(
  rules.filter((r) => scopeMatches(r, msg) && continuityAdmits(r, msg)).map((r) => r.agentId)
)
```

Because `conversationPeers` (`index.ts:282`) is a union of `participantAgents ∪
mentionedAgents ∪ automaticAgents`, one predicate covers both traps and leaves the explicit paths
intact: a mention still joins, and an `auto` rule (only produced by `any`) is unaffected.

The fan-out has two call sites, and they bracket the fence's scope exactly:

- `daemon.ts:7257` — the human path, skipped for bot senders.
- `daemon.ts:6918` — `routeAgentMessageImplicitly`, an agent-authored continuation.

Because the fence lives in the *selector* rather than in the delivery gate, it narrows both. That
is correct and matches the `mutedChannels` precedent verbatim: `participantAgents` already applies
the Off fence to both call sites ("a participant in a silenced channel is not revived by
conversation it can no longer take part in"). The hand-off invariant survives for the same reason
it survives under Off — an explicit `sendMessage{toAgent}` dispatches directly and consults no
conversation fence at all. The intended consequence, worth stating so it is not later read as a
bug: **in a fenced conversation, an agent's visible post wakes no peers implicitly.** Peers need an
explicit toAgent or an @-mention, which is the reading the trigger's own label implies.

`conversationAdmitsAgent` (`index.ts:237`) is **deliberately untouched**, for a different reason:
it is the *delivery* gate re-applied for the verified-agent ladder (its one call site,
`daemon.ts:7013`, gates that ladder's primary target — not the peers). Its job is to reproduce
`off`. `mention_topic` is not a delivery fence — it admits @-mentions and agent deliveries by
design — so adding it there would silently turn it into Off for agent traffic.

### 3a. What happens when a peer is also in the topic

Worth stating, because the code path is not the one you would expect.

Thread affinity is skipped entirely when two agents have open sessions in the same thread —
`threadOwner` returns null by design (`session-manager.ts:301-303`) — so in a topic shared by
agents A and B, rung 2 delivers nothing even for a reply to A. The delivery still happens, through
the **fan-out**: `daemon.ts:7257` calls `fanOutToThreadPeers` for every human message, with
`result?.agentId` merely as the primary to exclude. `conversationPeers` unions `participantAgents`
with the mention and auto sets, so `continuityAdmits` has already narrowed participants to A
alone, and the fan-out dispatches to A — even though the ladder returned nothing at all.

Two consequences to keep in mind while implementing and testing:

- The fence's `participantAgents` half is not merely the second trap — in the multi-agent case it
  is the *only* thing that delivers the reply. A test that only covers a single agent in the topic
  will not exercise it.
- The fan-out computes its own `via` (`daemon.ts:7428`), independently of the ladder, and derives
  it from `explicitlyMentioned` alone — so a reply is `'implicit'` there too, and inherits the §4
  decision for free (no reminder, no un-mute).

### 3b. Why the fence need not also guard rungs 3 and 4

The fence guards the two rungs that express *continuity* — an open (or dormant) session, not an
address. Rungs 3 and 4 (CP per-sessionKey override, then kind precedence) are reachable only
through a matching rule, so the question is whether anything can put an `auto` rule in reach of a
fenced conversation. Verified: nothing can on the Telegram path.

- **CP session placements.** `placeSession` (`placement.ts:747-762`) writes the `assignment` row
  and the `route/assign` frame with `bindRules: []` — the parameter defaults to empty and no
  caller passes anything else. So a placement contributes no kind rule, and `cpRulesFromAssign`
  (`routing-rule.ts:165`) yields an empty scope for its channels. Rung 3's `cpInChannel` check
  finds nothing.
- **CP global rules.** `route/update` is not issued by the CP at all: `cpRulesFromUpdate` is fed
  from a frame the control plane never sends in this deployment. Even if one arrived, its entries
  are unscoped defaults; a channel-scoped `auto` rule cannot be expressed by that frame.
- **Channel `auto` rules.** The only producer is `integrationToSpec`'s `channelRules`
  (`placement.ts:288-290`), which filters `c.trigger === 'any'`. A conversation has one trigger,
  so a `mention_topic` channel never appears there.

The invariant to preserve, and to re-check if any of the above changes: **no `auto`-kind rule may
ever be scoped to a fenced channel.** If a future change makes CP issue channel-scoped assignments
with real bind rules, the fence has to grow a rung-3/4 guard as well.

### 4. `!stop` interaction: a reply is continuity, not an address

The four mute sites compare `via === 'mention'` to decide whether to clear a `!stop`
(`daemon.ts:7042, 7098, 7304, 7435`), and `session-manager.ts:920` injects
`EXPLICIT_MENTION_REMINDER` on `msg.trigger === 'mention'`. That reminder asserts *"A platform
message in this activation explicitly @-mentioned your bound bot identity"*, and
`daemon.ts:7088` is explicit that stamping `mention` on anything that is not an address "would
assert an address that the message does not contain."

A reply is not a mention, so the rung keeps emitting **`via: 'thread'`** — which is exactly what a
reply-to-continue already produces today, in every non-fenced channel. Consequences, all
intended:

- No new `RouteVia` member, so no consumer changes (`routing-table.ts` re-exports the union to
  `commands/handlers.ts`; there are no exhaustive switches on it — verified).
- No `msg.trigger = 'mention'` stamp, so no false reminder to the model.
- A reply does **not** clear a `!stop`. The documented contract is "@mention me to resume", and a
  fenced conversation already ignores unaddressed traffic, so widening it would be a second
  behavior change with its own wording. Left alone; easy to add later if wanted.

### 5. Compilation (control plane)

`mention_topic` is compiled by `placement.ts` only.

**Gated** (`gatedBindRules`, `placement.ts:232`): falls into the existing `else` branch, producing
the same channel-scoped `{ match: { kind: 'mention' } }` rule that `mention` produces — that rule
*is* the grant that makes the conversation reachable at all for a restricted agent.

That `else` is a trap, and upstream hit it: when the fork merges upstream's `decision` handling,
the loop grows an early `continue` branch and `mention_topic` must be given its own explicit
branch too, or it silently becomes a mention rule. Upstream's comment states the hazard exactly
(*"Before the fallthrough below, which would otherwise make By decision a mention rule"*). At
`v1.60.0` there is no such branch yet, so the `else` is correct as-is — but add a comment marking
the ordering requirement, because the merge will move it.

**Ungated**: needs no positive rule, exactly like `mention`. Only the fence is new:

```ts
/** The explicit-address conversations of an integration — its `affinityDenied` fence.
 *  Unlike `mutedChannels` this is NOT skipped when gated: Off is expressed by the missing
 *  scoped rule, but affinity denial is orthogonal to the grant. */
function affinityDeniedChannelIds(channels: IntegrationChannelRecord[]): string[] {
  return channels.filter((c) => c.trigger === 'mention_topic').map((c) => c.channelId)
}
```

Both envelope assembly sites (`integrationToSpec:302`, `httpIntegrationToSpec:336`) add
`affinityDenied: affinityDeniedChannelIds(channels)`. `mutedChannelIds` is unchanged, so
`mention_topic` never appears in `mutedChannels` — the conversation stays admitted, and
`conversationAdmitted` (the control-command / pre-addressed-hand-off check) keeps working.

Nothing in the CP needs to know the platform, so no provider capability flag is required.

### 6. Console

`ChannelTrigger` widens to four values in the four places it is declared: the Prisma enum,
`packages/control-plane/src/persistence/ports.ts:5036`,
`packages/control-plane/src/http/dto/index.ts:919` (read DTO) and `:1794` (patch body),
`packages/control-plane/src/http/mcp/tools.ts:997` (`setChannelTrigger`), and on the web side
`packages/web/src/lib/api.ts:878`, `packages/web/src/lib/data.ts:2147`,
`packages/web/src/components/console/platforms/contract.ts:562`.

The dropdown (`IntegrationChannelList.tsx:45-60`) gains a fourth option, and the per-platform
allow-list flips from "absent ⇒ all" to an explicit default, because a fourth value would
otherwise leak to platforms that cannot implement it:

```ts
// Absent ⇒ the three platform-agnostic values. The fourth is opt-in per platform: the
// reply half needs a per-message author lookup only the daemon's transcript can answer.
const allowed = channelListSemantics(platform).triggers ?? ['off', 'mention', 'any']
```

Telegram's module (`platforms/telegram/index.tsx`) then declares
`triggers: ['off', 'mention', 'mention_topic', 'any']`. Value `mention_topic`, label
`@-mention + reply`; the option is offered for every non-`im` row, since a plain Telegram group
(with reply-derived continuity, no topics) benefits identically.

`NativeIntegrationDialog.tsx` (the MCP-driven native UI, reachable via `ModalProvider`) renders
its own `<select>` with a narrowed cast at `:193`; it needs the fourth `<option>` behind the same
allow-list, or a row already set to `mention_topic` renders a stale selection.

### 7. Product documentation

`docs/product-conventions.md:505-535` ("Per-conversation trigger") says channels and group DMs
expose all three settings. It becomes four, with the reply half stated as the reason: *a reply to
one of the agent's own messages is an address.* The thread-affinity note at `:275-280` gains the
one exception. Per the repo convention, this file is product behavior — it is part of the change,
not a follow-up.

## Work items

**Schema and control plane**
1. `prisma/schema.prisma:2478` — add `mention_topic` to `enum ChannelTrigger`; update the comment
   above it, which currently enumerates three meanings.
2. `prisma/migrations/20261010000000_channel_trigger_mention_topic/migration.sql` —
   `ALTER TYPE "ChannelTrigger" ADD VALUE IF NOT EXISTS 'mention_topic';` (precedent:
   `20260903000000_gitlab_hook_kind`, and upstream's `20261014000000_channel_trigger_decision`,
   which is the same change for the same enum). Timestamp sits after the current latest,
   `20261009000000_agent_placement_changed_at`.
3. `persistence/ports.ts:5036`, `http/dto/index.ts:919,1794`, `http/mcp/tools.ts:997` — widen.
4. `orchestrator/placement.ts` — `affinityDeniedChannelIds`, both envelopes, `gatedBindRules`
   comment.
5. `packages/protocol/src/frames/integration.ts:146` — `affinityDenied` on the envelope.

**Policy package**
6. `activation-policy/src/index.ts` — `replyToAuthor` on `ActivationMessageFacts`,
   `affinityDenied` on `ActivationRule`, the `continuityAdmits` predicate, the rung-2 condition,
   the `participantAgents` filter.

**Daemon**
7. `messages/normalized.ts` — `replyToAuthor?: string` (daemon-internal, beside `transcriptTs`).
8. `store/local-store.ts:4825` — return `sender` with `thread`.
9. `platforms/telegram/threading.ts` — host return type; resolve on the topic reply path.
10. `daemon.ts:6701` — the host wiring is unchanged in shape (the store call already returns the
    wider record).
11. `agents/agent-schema.ts:79` — the `IntegrationCoreEnvelope.default({...})` object holds a
    hand-written copy of the envelope shape. Add `affinityDenied: []` to it and **check at
    runtime whether it is load-bearing**: if `agent.json` is authored without `core`,
    `IntegrationCoreEnvelope.parse` may merge its own defaults afterwards and leave the literal
    redundant. Leave it in either way — a stale literal is a worse failure than a redundant
    field — but do not assume it is what defaults the value.
12. `platforms/integration-config.ts:148` — read `affinityDenied` beside `mutedChannels`.
13. `router/routing-rule.ts` — `integrationRouting` return type, and carry it in
    `rulesFromAgent`, `resolveCpRule`, `resolveAgentIntegration` exactly as `mutedChannels` is.

**Web**
14. `lib/api.ts:878`, `lib/data.ts:2147`, `console/platforms/contract.ts:562` — widen.
15. `console/IntegrationChannelList.tsx:44-62` — the fourth option, the explicit default.
16. `console/platforms/telegram/index.tsx` — declare `triggers`.
17. `console/modals/NativeIntegrationDialog.tsx:193` — the fourth `<option>` + widened cast.

**Docs**
18. `docs/product-conventions.md:275-280,505-535`.

## Testing

- `packages/activation-policy/test/policy.test.ts` — the ladder, which is where the two traps live:
  a fenced channel routes a reply to the thread owner; a fenced channel routes an unaddressed
  message to **nobody** (today it routes to the owner — this is the regression the change is for);
  a fenced channel still routes an @-mention; a fenced channel routes a reply to a *different*
  agent to nobody; `participantAgents` returns nothing in a fenced channel without a reply, and
  the reply author in a fenced channel **with** one; `conversationAdmitsAgent` is unchanged by the
  fence.
- `packages/daemon/test/router.test.ts`, `route-rules.test.ts`, `routing-rule.test.ts` — the
  daemon-side wiring of the same facts, and that `affinityDenied` survives
  `rulesFromAgent`/`resolveCpRule`/`resolveAgentIntegration` the way `mutedChannels` does.
- **The multi-agent case deserves its own test**, per §3a: two agents with sessions in one thread,
  a reply to A, and a fence in force. It is the only case where `participantAgents` is load-bearing
  rather than a backstop.
- `packages/control-plane/src/orchestrator/placement.test.ts` — `mention_topic` produces
  `affinityDenied` in both the gated and ungated envelopes, produces the scoped mention rule when
  gated, is absent from `mutedChannels` in both, and adds no `auto` rule.
- `packages/daemon/test/telegram-threading.test.ts` — a reply inside a forum topic resolves
  `replyToAuthor` to the agent id recorded for the bot's own post; a reply to a human's message
  leaves it as that person's id. The existing `out-9` case (`:743-755`) is the fixture to extend.

## Risks and limitations

- **Affinity reaches dormant threads too, which is why the fence cannot be narrower.**
  `threadOwner` (`session-manager.ts:299`) does not stop at open sessions: with none open it falls
  back to `closedSessionAgents` and revives the sole agent that previously owned the thread. So in
  a topic, an unaddressed message revives an idled agent — the same leak, one step later. The
  fence is applied to whatever `threadOwner` returns, so both cases are covered by one predicate.
  This also means the common single-agent topic behaves as users expect: you @-mention once, the
  session idles out, and a reply to one of its messages brings it back.
- **The two rungs are not the only readers of continuity.** `threadOwner` returning non-null also
  gates control commands (`commands/handlers.ts:495` routes them through the same ladder, so a
  `!stop` typed unaddressed in a fenced topic will not resolve a target). That is consistent with
  "answers only when addressed", and is the intended reading of the trigger — noted so it is not
  later mistaken for a regression.
- **The Telegram hint is not trigger-aware.** `TELEGRAM_CONTINUE_HINT` (`render.ts:71`) is appended
  to every agent turn on Telegram, including in `off` and `mention_topic` conversations where
  replying may do nothing. Pre-existing for `off`; worth a separate wording pass, out of scope
  here.
- **Shared-bot platforms degrade for API callers.** `httpBot.ts:1002` compiles only `any` and
  `mention`. A `mention_topic` row set through the MCP tool on a relay-managed platform is treated
  as `mention` — affinity still applies. The reply half is unimplementable there: the relay has no
  transcript and cannot resolve a reply author. The console does not offer the option on those
  platforms. Upgrade path: carry a deny list on `RcBotAssign` (`relay-cp.ts:899`) and apply it at
  `bot-arbitration.ts:599`, for a mention-only-with-no-continuity mode.
- **Every Telegram reply now costs one lookup, including in topics** — deliberate, see §2.

## Upstream divergence

This is a long-lived fork divergence, but it is **not** a novel mechanic. Upstream made the
structurally identical change one release later, and that change is the single best template for
this one — read it before writing anything.

- `v1.60.0` (`e8cd2bf4`, 2026-09-19) is an ancestor of both `origin/main` (198 commits ahead) and
  `upstream/main` (319 ahead of the tag, i.e. 121 past `origin/main`).
- Upstream added a fourth `ChannelTrigger` value, **`decision`**, in
  `20261014000000_channel_trigger_decision`. Its migration is exactly the one line proposed in work
  item 2, with a comment worth copying verbatim because it states the constraint:
  `-- By decision joins the conversation trigger (decisions.md §6.2); a new enum value cannot be used in the transaction that adds it.`
- `gatedBindRules` handles it by branching **before** the `else` fallthrough, with the reason
  spelled out: *"Before the fallthrough below, which would otherwise make By decision a mention
  rule."* This is the same shape `mention_topic` needs, and the same trap: a new trigger that wants
  *no* kind rule will silently inherit `mention` if the branch is added too late.
- Upstream's `heldDecisionChannels` shows the pattern for a *conditional* fence — it returns
  channels whose binding is disabled or unparseable, and `integrationToSpec` folds those into
  `mutedChannels` ("so the unscoped mention default can never answer it as Any"). `mention_topic`
  is unconditional, so it needs no analogue — but if the trigger ever gains a configurable half,
  that is the shape to follow.
- Upstream also widened `RouteVia`, `RuleMatch`, and `KIND_ORDER` for `decision`, because it needed
  a new *kind* to match on. This design deliberately does **not** — see §4. That keeps the merge
  surface to one enum line, one migration, one envelope key, and one predicate.

Because both sides add a value to the same enum, the merge conflict is guaranteed; because the two
additions are mechanically distinct, it is resolved by inspection.
