# A per-topic trigger for Telegram forum supergroups

**Status:** design, awaiting review
**Base:** branch `merged/v1.16.0-bacnv` (HEAD `fd62bbc8`). Every line number below was read from HEAD,
not from a tag.
**Builds on:** `2026-09-25-telegram-topic-trigger-design.md`, which added the per-_conversation_
`mention_topic` trigger. That work is merged. This one adds the _thread_ dimension.
**Scope:** fork-only (`bacnv/agentconnect`).

## Problem

A trigger belongs to a conversation, and for Telegram a conversation is the whole supergroup. Inside
a forum supergroup every topic therefore shares one trigger, and the sharing is not a display
problem — it is a routing one:

- `any` on the group emits one channel-scoped `auto` rule (`placement.ts:298-300`), which matches
  every message in every topic. There is no way to make one topic quiet while the group is loud.
- `off` on the group mutes the channel outright (`mutedChannelIds`, `placement.ts:259`), so a single
  topic cannot be kept alive while the rest is silent.
- `mention_topic` on the group compiles to a channel-wide `affinityDenied` fence
  (`affinityDeniedChannelIds`, `placement.ts:267`), so the "answer only when addressed" promise
  covers topics the operator never meant.

The user's framing: a topic starts out following the group's trigger, and once the daemon has
detected it the console offers it for separate configuration — the group's setting stays the
default.

## Goal

One new dimension of trigger scoping, on the coordinate the ladder already has.

- A forum topic may carry its own trigger: the same four values a room takes, plus **inherit** (the
  default), which is what every topic has today and what a newly detected topic gets.
- **A topic that carries its own trigger ignores everything said about its enclosing group** — the
  group's rules and its fences both.
- Success: every existing conversation, Telegram or otherwise, behaves identically after deploying.
  Only a topic whose operator explicitly sets a trigger changes.

## Non-goals

- No change to `off`, `mention`, `mention_topic`, or `any` semantics at the **conversation** level.
- No non-forum threading. A plain supergroup's reply roots (`threadRoot` → `tg:<id>`,
  `threading.ts:75-78`) are session coordinates, not conversations, and never become configurable
  rows. Only a forum topic — `is_topic_message: true`, hence `msg.topicId` — is a topic here.
- No topic-level trigger on any platform but Telegram. No other platform has forum topics.
- No relay / shared-bot compilation. A relay-managed platform has no transcript to resolve a reply
  author and Telegram has no HTTP callback ingress, so this stays on the `placement.ts` path.
- No topic discovery beyond what Telegram reports. The Bot API has **no `getForumTopics`**; a topic
  the bot has never seen traffic in is not knowable, and that is accepted rather than worked around.
- No new `RouteVia`, `RuleMatch` kind, or `KIND_ORDER` change.

## Design

### 1. The coordinate, and the one invariant that makes this cheap

A message in a forum topic already carries the coordinate this needs: `msg.thread` is the topic id
(`threading.ts:70-73`) and `ActivationRule.scope` has carried `thread?` all along
(`index.ts:28-35`), as has the wire's `BindRuleConfig.thread` (`agent-schema.ts:24`). Positive,
thread-scoped rules are therefore **already expressible and already honoured** — nothing new is
needed to say "the `auto` rule for topic T".

What is missing is the _subtractive_ half. All three existing fences read one coordinate:

| fence                       | read at                            | compares              |
| --------------------------- | ---------------------------------- | --------------------- |
| `mutedChannels`             | `scopeMatches`, `index.ts:73`      | `ref === msg.channel` |
| `affinityDenied`            | `continuityAdmits`, `index.ts:104` | `ref === msg.channel` |
| `overriddenThreads` _(new)_ | `scopeMatches`                     | —                     |

`threadOwner`'s rung is kind-agnostic, and the kind rungs (`index.ts:239-245`) are reachable through
any matching rule — so **a group-level rule outranks a topic-level one** unless something removes it.
That is the whole reason `overriddenThreads` exists rather than the trigger set being merely
additive.

### 2. Two effects, one predicate

`overriddenThreads` means exactly one thing: **in this thread, nothing the enclosing channel states
applies.** Two consequences, both implemented in the single scope predicate every rung already
passes through, so no rung can be forgotten:

1. A rule scoped to `{channel: C}` with **no** thread does not match a message in an overridden
   thread of `C`. That is the group's own statement — its `auto` rule, and (for a gated integration)
   its grant rule.
2. A **channel-wide** fence ref (`'C'`) does not apply to a message in an overridden thread of `C`.
   A thread-shaped ref (`{channel: C, thread: T}`) always applies.

Effect 2 is what makes `off`-group + live-topic expressible: without it the group's mute would reach
into the very topic that was just given its own trigger. With it, `mutedChannels: ['C']` plus
`overriddenThreads: [{C, T}]` reads "silent everywhere in C except T", which is the operator's
intent stated in the vocabulary the daemon already has.

Rules that name **no** channel are never suppressed — the unscoped `mention`/`dm` defaults
(`DEFAULT_BIND_RULES`, `placement.ts:172`) keep working in an overridden thread, which is what makes
a plain `mention` topic need no positive rule at all.

Sketch of the predicate (`index.ts:73`). The whole change is one `own` flag threaded through:

```ts
/** Does a fence ref reach this message? A channel-wide ref IS the enclosing channel's own
 *  statement, so it stops at a thread that carries its own trigger; a thread-shaped ref
 *  always reaches the thread it names. */
function refCovers(ref: ScopeRef, msg: ActivationMessageFacts, own: boolean): boolean {
  if (typeof ref === 'string') return own && ref === msg.channel
  return ref.channel === msg.channel && ref.thread === msg.thread
}

/** Does the enclosing channel's own state reach here? False in a thread the operator gave its
 *  own trigger: that thread ignores everything stated about the channel. */
function channelReaches(r: ActivationRule, msg: ActivationMessageFacts): boolean {
  return !r.overriddenThreads?.some((t) => refCovers(t, msg, true))
}

function scopeMatches(r: ActivationRule, msg: ActivationMessageFacts): boolean {
  if (r.platform !== undefined && r.platform !== msg.platform) return false
  const own = channelReaches(r, msg)
  // A channel-scoped rule with no thread IS the channel's statement, so an overridden thread drops it.
  if (!own && r.scope.channel !== undefined && r.scope.thread === undefined) return false
  if (r.mutedChannels?.some((m) => refCovers(m, msg, own))) return false
  if (!channelInScope(r.scope.channel, msg)) return false
  if (r.scope.thread !== undefined && r.scope.thread !== msg.thread) return false
  return true
}
```

`continuityAdmits` (`index.ts:104`) takes the same `own` guard, so a channel-wide `affinityDenied`
also stops at an overridden thread — which is what lets a `mention` topic inside a `mention_topic`
group re-admit follow-ups.

`affinityAdmits` (`index.ts:92`) is exported for the callers that resolve a target by coordinate
outside the ladder; its signature widens from a bare `denied` list to the rule's two fence fields so
those callers get the same reading. Its one external call site is `handlers.ts:395`.

### 3. Data model

A new table, keyed on the three-part coordinate. `IntegrationChannel`'s primary key is
`(integrationId, channelId)` and it is written through raw `ON CONFLICT` SQL
(`integration.repo.ts:787-796`) and read as "the conversations a bot is in" by the console, the
session list, and the shared-bot route compiler — adding a third key part there would make topics
appear as conversations in every one of those readers. It stays as it is.

```prisma
model IntegrationChannelThread {
  integrationId String
  channelId     String
  threadId      String // the Telegram topic id, the same coordinate msg.thread carries
  name          String? // "Deploys"; null until a service record or a rename supplies it
  // NULL = inherit the enclosing conversation's trigger, which is what every topic starts on.
  // A topic is therefore never "defaulted" to a value a human did not choose, so unlike
  // IntegrationChannel this table needs no `triggerChosen`.
  trigger       ChannelTrigger?
  firstSeenAt   DateTime       @default(now()) @db.Timestamptz(6)
  updatedAt     DateTime       @updatedAt @db.Timestamptz(6)

  channel IntegrationChannel @relation(fields: [integrationId, channelId], references: [integrationId, channelId], onDelete: Cascade)

  @@id([integrationId, channelId, threadId])
  @@map("integration_channel_thread")
}
```

The composite foreign key to `IntegrationChannel` is the point: `replaceSnapshot` deletes channel
rows the bot has left (`integration.repo.ts:762-766`), and a topic must not outlive its group. It
also means a thread row can only exist for a conversation that exists, which keeps the console's
nested rendering honest.

### 4. Wire

Two additions to `frames/integration.ts`, both backward compatible by construction.

```ts
/** A fence target: a whole conversation, or one thread of it (a Telegram forum topic).
 *  The bare string is the channel-wide form every existing producer sends — an older
 *  daemon parses it unchanged. */
export const ScopeRef = z.union([z.string(), z.object({ channel: z.string(), thread: z.string() })])
export const ThreadRef = z.object({ channel: z.string(), thread: z.string() })
```

`IntegrationCoreEnvelope` (`:146`):

- `mutedChannels: z.array(ScopeRef).default([])` — widened in place, so the emitted JSON for an
  integration with no topics is byte-identical to today's.
- `affinityDenied: z.array(ScopeRef).default([])` — the same widening.
- `overriddenThreads: z.array(ThreadRef).default([])` — new.

The report direction (`:274`) carries topics on their conversation, so a report stays atomic:

```ts
export const IntegrationChannelThread = z.object({
  id: z.string(),
  name: z.string().optional() // absent = not yet resolved; never null (nothing clears a name)
})
```

`IntegrationChannel` gains `threads: z.array(IntegrationChannelThread).optional()`.

### 5. Compilation (control plane)

`placement.ts` gains one fold, applied wherever `mutedChannelIds` / `affinityDeniedChannelIds` are
today:

| topic trigger      | `overriddenThreads` | `mutedChannels` | `affinityDenied` | positive rule                               |
| ------------------ | ------------------- | --------------- | ---------------- | ------------------------------------------- |
| _(NULL — inherit)_ | —                   | —               | —                | —                                           |
| `off`              | `{C,T}`             | `{C,T}`         | —                | —                                           |
| `mention`          | `{C,T}`             | —               | —                | — (ungated: the unscoped default covers it) |
| `mention_topic`    | `{C,T}`             | —               | `{C,T}`          | —                                           |
| `any`              | `{C,T}`             | —               | —                | `{channel: C, thread: T, match: auto}`      |

Every topic that carries a trigger is listed in `overriddenThreads`, `off` included: a row an
operator set is an override whatever value it holds, and stating it uniformly keeps one rule instead
of four conditionals. An `off` topic is muted by its own ref and needs no suppression, so listing it
costs nothing.

**Gated** integrations (`gatedBindRules`, `placement.ts:233`) need a thread-scoped grant, because
effect 1 suppresses the channel-scoped one in an overridden thread — and suppressing a gated agent's
only grant would silently close a conversation the operator just opened:

- `mention` / `mention_topic` → `{channel: C, thread: T, match: {kind: 'mention'}}`
- `any` → `{channel: C, thread: T, match: {kind: 'auto'}}`
- `off` → no rule (fail-closed, the same reading the missing channel rule already gives)

`gatedBindRules`' existing `else` fallthrough keeps its two obligations: a trigger that wants no kind
rule must branch before it, and a trigger that wants a _thread_ must branch after it. Both get stated
in the comment the file already carries for the first.

`mutedChannelIds` keeps returning `[]` for gated and channel-wide strings for ungated; topic refs are
appended to that same list rather than replacing it.

### 6. Daemon — detection and reporting

`message/telegram-message.ts` widens `TelegramMessage` with the forum service records
(`forum_topic_created`, `forum_topic_edited`, `forum_topic_closed`, `forum_topic_reopened`) — the
Bot API's only way to learn a topic's name, since there is no listing call.

`telegram/connection.ts` gains one dep beside `onBotAddedToChat` (`:114`):

```ts
/** A forum topic learned from a service record. Membership/topic records never enter routing. */
onForumTopic?: (topic: { chatId: string; threadId: string; name?: string }) => void
```

fired from the same service-message branch that already handles `new_chat_members` (`:299-313`).

Two sources, one sink:

- `forum_topic_created` / `forum_topic_edited` → `{chatId, threadId, name}`.
- **Any** regular message with `msg.topicId` → `{chatId, threadId}` with no name. A topic the bot was
  already in when it was created never produces the service record, so its existence is learned from
  traffic and its name stays unknown until Telegram reports an edit.

The sink is `observePlatformChats`' sibling in `platforms/observed-channels-sync.ts`, which already
owns "record what the platform told us and report it" for Telegram (`observeTelegramChat`, `:189`).
It merges into the cached snapshot's channel row and re-emits over the existing
`integration/channels` frame (`cp/client.ts:803`) — no new frame.

A topic is never retracted. Telegram reports no deletion, and the report is
non-authoritative by construction (its omissions already mean nothing), so a vanished topic keeps
its row. Stated as a limitation, not a bug; see Risks.

### 7. Console

`IntegrationChannelList.tsx` renders the topic rows **nested under their room row**, behind a
disclosure. The list is already grouped by space into bands (`groupBySpace`, `:128`) and the room row
is the natural parent — a flat extra section would put a topic's trigger control somewhere other than
the group it inherits from.

The topic row's control is the existing `TriggerSelect` with a fifth value:

```ts
{ value: 'inherit', label: 'Follow group', hint: `Uses the trigger set for ${groupName}.` }
```

`'inherit'` is a **display-only sentinel**; the wire value is `null`. Keeping it a string avoids
widening `TriggerSelect`'s `T extends string` (`TriggerSelect.tsx:33`) for one caller.

Availability is opt-in and per-platform, on the existing list-semantics contract
(`contract.ts:536`):

```ts
/** Whether a conversation's rows can carry their own trigger. Only a platform with a real
 *  sub-conversation — Telegram forum topics — declares it. */
threadTriggers?: readonly ('off' | 'mention' | 'mention_topic' | 'any')[]
```

Telegram declares `threadTriggers: ['off', 'mention', 'mention_topic', 'any']` beside its existing
`triggers` (`platforms/telegram/index.tsx:39`); every other module declares nothing and renders no
disclosure, so their channel list is unchanged.

A topic row with an unresolved name prints `Topic <id>` rather than a blank, since the id is the row's
only remaining identity.

The write path is one new REST route and one new api binding:

```
PATCH /integrations/:id/channels/:channelId/threads/:threadId   body: { trigger: ChannelTrigger | null }
```

It mirrors `updateIntegrationChannel` (`integrations.ts:733-880`) exactly: same `denyViewerWrite`,
same 404-on-invisible / 403-on-uneditable agent gate, same persist-then-push-the-recomputed-spec
sequence. `null` clears the override back to inherit.

### 8. Product documentation

`docs/product-conventions.md`'s "Per-conversation trigger" (`:552`) is the section that states what a
trigger means. It gains the topic paragraph: a topic inherits its group's trigger, a topic that is
given its own ignores the group's entirely, and `off` on a topic is the topic's own silence rather
than the group's. Per the repo convention that file is product behavior and is part of this change,
not a follow-up.

## Work items

**Wire — `packages/protocol`**

1. `frames/integration.ts` — `ScopeRef`, `ThreadRef`, `IntegrationChannelThread`; widen
   `mutedChannels` and `affinityDenied` to `ScopeRef`; add `overriddenThreads`; add `threads` to
   `IntegrationChannel`.

**Policy — `packages/activation-policy`**

2. `src/index.ts` — `ScopeRef`/`ThreadRef` exports; `overriddenThreads` on `ActivationRule`; the two
   fence fields widen to `ScopeRef[]`; `refCovers` and `channelReaches` helpers; `scopeMatches` and
   `continuityAdmits` gain the `own` guard; `affinityAdmits` takes the two fence fields.

**Control plane — `packages/control-plane`**

3. `prisma/schema.prisma` — `IntegrationChannelThread`, and the `threads` back-relation on
   `IntegrationChannel`.
4. `prisma/migrations/20261012000000_integration_channel_thread/migration.sql` — new table +
   composite FK. Latest existing migration is `20261011000000_cron_target_thread`.
5. `persistence/ports.ts` — `IntegrationChannelThreadRecord`, `threads` on
   `IntegrationChannelRecord`, and on `ReportedChannel`; repo port gains `setThreadTrigger`.
6. `persistence/repositories/integration.repo.ts` — thread upsert inside `replaceSnapshot` (name
   only, preserving the stored trigger), `toChannelRecord` loads threads, `setThreadTrigger`.
7. `orchestrator/placement.ts` — `threadOverrides`, the fold into all three fences plus the positive
   rule, in `integrationToSpec` and `httpIntegrationToSpec`, and the gated thread grant.
8. `ws/handlers/integration-channels.ts` — accept the reported threads; no other change (the
   ownership, mutation-lease, and gating logic is coordinate-independent).
9. `http/dto/index.ts` — `threads` on the channel DTO; the new patch body.
10. `http/routes/integrations.ts` — the threads PATCH route, with `tags`/`summary`/`operationId` per
    the OpenAPI requirement.
11. `http/mcp/tools.ts` — the trigger enum is shared with the thread write; extend or add alongside
    `setChannelTrigger` (`:997`).

**Daemon — `packages/daemon`**

12. `src/telegram/connection.ts` — forum service records on `TelegramMessage`; `onForumTopic` dep;
    fire it for service records and for any message carrying `topicId`.
13. `src/platforms/observed-channels-sync.ts` — record a topic into the cached channel row and
    re-emit.
14. `src/router/routing-rule.ts` — `integrationRouting` returns `overriddenThreads`;
    `conversationAdmitted` takes the thread and applies both effects; `rulesFromAgent` and
    `resolveCpRule` carry `overriddenThreads` as they carry `mutedChannels`.
15. `src/platforms/integration-config.ts` — read `overriddenThreads` beside `mutedChannels`.
16. `src/agents/agent-schema.ts` — `overriddenThreads: []` in the envelope default literal (`:79-85`).
17. `src/commands/handlers.ts`, `src/daemon.ts` — pass `msg.thread` to the five
    `conversationAdmitted` call sites (`handlers.ts:481,940`, `daemon.ts:8384,16480`) and the
    `affinityAdmits` call (`handlers.ts:395`).

**Web — `packages/web`**

18. `src/lib/api.ts` (`:880`), `src/lib/data.ts` (`:2147`) — the thread types, the DTO, and
    `updateIntegrationChannelThread`.
19. `src/components/console/platforms/contract.ts` — `threadTriggers` on `WebChannelListSemantics`.
20. `src/components/console/IntegrationChannelList.tsx` — the nested disclosure and the topic rows.
21. `src/components/console/platforms/telegram/index.tsx` — declare `threadTriggers`.
22. `src/lib/data-context.tsx` — `setThreadTrigger` beside `setChannelTrigger` (`:1415`).

**Docs**

23. `docs/product-conventions.md` — the topic paragraph in "Per-conversation trigger".

## Testing

**`packages/activation-policy/test/policy.test.ts`** — the ladder, where every trap lives:

- A group `auto` rule does **not** fire in an overridden thread. This is the case that proves
  `overriddenThreads` is load-bearing rather than decorative; without it a topic set to `mention`
  still answers every message.
- An overridden thread still answers an `@-mention` (effect 1 must not suppress unscoped rules, or a
  `mention` topic becomes unreachable).
- A channel-wide `mutedChannels` entry does **not** silence an overridden thread, and a thread-shaped
  one does (effect 2, both arms).
- A channel-wide `affinityDenied` does not reach an overridden thread, so a `mention` topic inside a
  `mention_topic` group re-admits follow-ups.
- `participantAgents`: in an overridden thread, participants are gated by the thread's own fence, and
  the multi-agent case (two agents, one topic, reply to A) still delivers to A alone — the same
  load-bearing path the conversation-level spec's §3a documents.
- Suppression applies to `r.scope.channel` rules with **no** thread and to nothing else: a
  thread-scoped rule, an unscoped rule, and a `scope: {}` CP rule are all unaffected.

**`packages/control-plane/src/orchestrator/placement.test.ts`** — the fold, per row of §5's table,
plus: an integration with no thread rows emits `overriddenThreads: []` and byte-identical fences; a
**gated** integration emits a thread-scoped grant for each enabled topic and none for an `off` one.

**`packages/control-plane/test/integration/integration-channels.test.ts`** — a report carrying
threads creates them; a re-report refreshes names while **preserving** a stored trigger; deleting the
channel row cascades its threads away.

**`packages/daemon/test/routing-rule.test.ts`** — `overriddenThreads` survives
`integrationRouting` / `rulesFromAgent` / `resolveCpRule` the way `mutedChannels` does.

**`packages/daemon/test/telegram-connection.test.ts`** — a `forum_topic_created` record reports a
topic with its name; a message carrying `topicId` reports one without; a non-forum reply root
(`threadRoot`) reports **nothing**, because it is a session coordinate and not a topic.

**`packages/web/src/components/console/IntegrationChannelList.trigger.test.tsx`** — the topic menu
offers `Follow group` plus the four values on Telegram and no disclosure elsewhere; picking
`Follow group` writes `null`.

## Risks and limitations

- **A topic's name is often unknown.** The Bot API has no listing call, so only a topic created or
  edited while the bot is present yields a name; the rest render as `Topic <id>`. Accepted: an
  unnamed row still carries the trigger control, which is the feature. Upgrade path: a console rename
  (the row would need a `name` write the report path already owns), or a Telegram-side lookup if the
  API gains one.
- **A topic is never retired.** Telegram reports no topic deletion, and the report is
  non-authoritative so omissions mean nothing. A deleted topic keeps its row until its group is
  deleted. Upgrade path: the console's `deleteChannel` has a thread analogue
  (`deleteThread`) it was not given here, deliberately — retiring rows is a separate decision from
  configuring them.
- **The console cannot show a topic the bot has never seen traffic in.** That is the same fact as the
  missing listing call, and it is the accepted boundary: a topic with no traffic has no routing
  behaviour to configure either.
- **A group switched `off` keeps its topics configurable, and a topic left on `any` keeps answering.**
  This falls out of effect 2 and is intended — it is the one way to express "quiet group, one live
  topic". It does mean `off` at the group level is no longer a guarantee that the group is entirely
  silent, so the console's topic disclosure must remain visible under an `off` row rather than
  collapsing with it.
- **Every overridden topic costs one rule or fence per fence list.** A forum with fifty configured
  topics carries fifty entries in `overriddenThreads`. Bounded by what an operator configures, not by
  what the platform holds, since only rows with a non-NULL trigger are folded.
- **The Telegram continue hint is not topic-aware.** `TELEGRAM_CONTINUE_HINT` (`render.ts:71`) still
  promises "reply to this message to continue" in a topic whose trigger is `off`. Pre-existing for
  the conversation-level trigger; unchanged here.
