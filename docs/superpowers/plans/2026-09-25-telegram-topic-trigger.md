# A reply-aware trigger for Telegram groups and topics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth per-conversation `ChannelTrigger`, `mention_topic`, so a Telegram group or forum topic answers only an explicit @-mention or a reply to one of that agent's own messages — instead of every message, which thread affinity currently delivers.

**Architecture:** The root cause is routing, not Telegram. `routeRules`' thread-affinity rung (`packages/activation-policy/src/index.ts:186`) is kind-agnostic and asks only "does this thread have a session", while a forum topic is one thread — so one @-mention captures the whole topic. The change adds one message fact (`replyToAuthor`, resolved from a transcript row the code already fetches) and one subtractive fence (`affinityDenied`) consulted at exactly the two rungs that express continuity: rung 2 and `participantAgents`. The CP compiles the new trigger to that fence only; it needs no positive rule, because the unscoped mention default already covers the mention half. Nothing new is added to `RouteVia`, `RuleMatch`, or `KIND_ORDER` — a reply is continuity, not an address, so it keeps `via: 'thread'`.

**Tech Stack:** TypeScript, pnpm 11 workspaces, zod 4, Prisma 6 + Postgres, Vitest 5, Next.js 16 + React 19.

**Spec:** `docs/superpowers/specs/2026-09-25-telegram-topic-trigger-design.md` — read it before Task 1. The plan implements it; where this plan and the spec disagree on a line number, this plan was written against the branch and wins.

**Base:** branch `feat/mention-topic`, cut from tag `v1.60.0` (`e8cd2bf4`). Every line number below is a `v1.60.0` line number.

## Global Constraints

- **Stored value is `mention_topic`** — snake_case, no hyphen. Prisma enum values are bare identifiers, and no enum in this schema uses `@map`. Display label is `@-mention + reply`.
- **Comments are one line.** The repo's `CLAUDE.md` is explicit: do not write multiline comment blocks; when you touch code carrying a verbose comment, condense it to one line. Every comment shown below is already condensed — keep it that way.
- **Prettier:** no semicolons, single quotes, no trailing commas, 120 columns.
- **`mention_topic` must never appear in `mutedChannels`.** Off is expressed by that fence; `mention_topic` is not a delivery fence — it admits @-mentions and agent deliveries by design. Putting it there silently converts the trigger into Off.
- **No new `RouteVia` member, no new `RuleMatch` kind, no `KIND_ORDER` change.** A reply keeps `via: 'thread'`, so no `EXPLICIT_MENTION_REMINDER` is injected and no `!stop` latch is cleared.
- **`ActivationMessageFacts.replyToAuthor` and `NormalizedMessage.replyToAuthor` are daemon-internal.** Never add them to the protocol schema; no wire frame changes.
- **Migration timestamp is `20261010000000`** — verified free. The latest existing migration is `20261009000000_agent_placement_changed_at`.
- **Do not modify `conversationAdmitsAgent`.** It is the verified-agent _delivery_ gate (sole call site `daemon.ts:7013`); its job is to reproduce Off.
- **Never run `docker compose down --volumes`.**
- **Commit identity:** this clone has no `user.*` git config. Pass it per command: `git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit …`. Never write to git config.

## Review Focus

Five input classes and failure modes the spec implies but no task's own tests would otherwise exercise. Each one's test is added to the task that owns the code.

1. **A reply to an agent that is NOT the thread's owner must deliver to nobody.** The whole point of the trigger is that a reply is an address to _one_ agent. `continuityAdmits` compares `replyToAuthor === r.agentId`; if that comparison is dropped or inverted, a reply to agent B wakes agent A. → Task 4, "routes a reply to a different agent to nobody".
2. **An unaddressed message in a dormant (TTL-closed) topic must not revive the agent.** `threadOwner` falls back to `closedSessionAgents` and revives the sole prior owner, so a fence that only covers open sessions leaks one step later. → Task 4, "does not revive a dormant owner".
3. **Two agents sharing a topic, a reply to A: A gets it, B does not.** In that case `threadOwner` returns null by design, so rung 2 delivers nothing and `participantAgents` is the _only_ delivery path. A single-agent test does not exercise it. → Task 4, "the multi-agent case routes through participants alone".
4. **A human's own message must resolve `replyToAuthor` to that human's id, not the agent's.** The transcript's `sender` column carries an agent id on the agent's rows and a platform user id on a human's. If the lookup reads the wrong column or the wrong row, a reply to a _person_ looks like a reply to the bot. → Task 3, "leaves a reply to a person as that person's id".
5. **Enabling the trigger in one conversation must not change any other conversation's behavior.** `affinityDenied` defaults to `[]` on the wire, so a CP/daemon pair that only half-understands it behaves exactly as before. → Task 5, "an integration with no mention_topic conversation is unaffected".

---

## File Structure

**Modified — policy package (pure, no I/O):**

- `packages/activation-policy/src/index.ts` — the `replyToAuthor` fact, the `affinityDenied` rule field, the `continuityAdmits` predicate, rung 2, `participantAgents`.
- `packages/activation-policy/test/policy.test.ts` — the two-trap tests.

**Modified — wire contract:**

- `packages/protocol/src/frames/integration.ts:146` — `affinityDenied` on `IntegrationCoreEnvelope`.

**Modified — control plane:**

- `packages/control-plane/prisma/schema.prisma:2478` — the enum.
- `packages/control-plane/prisma/migrations/20261010000000_channel_trigger_mention_topic/migration.sql` — new.
- `packages/control-plane/src/persistence/ports.ts:5036` — the type.
- `packages/control-plane/src/http/dto/index.ts:919,1794` — the two zod enums.
- `packages/control-plane/src/http/mcp/tools.ts:997` — the MCP tool's enum.
- `packages/control-plane/src/orchestrator/placement.ts:232,302,336` — the fence function, the `gatedBindRules` comment, both envelopes.
- `packages/control-plane/src/orchestrator/placement.test.ts` — the fixture union and the new cases.

**Modified — daemon:**

- `packages/daemon/src/messages/normalized.ts:44` — the internal fact.
- `packages/daemon/src/store/local-store.ts:4825` — widen the lookup.
- `packages/daemon/src/platforms/telegram/threading.ts` — host return type, the restructured ladder.
- `packages/daemon/src/platforms/integration-config.ts:143` — the envelope read.
- `packages/daemon/src/router/routing-rule.ts` — carry `affinityDenied` as `mutedChannels` is carried.
- `packages/daemon/src/agents/agent-schema.ts:79` — the hand-written default literal.
- `packages/daemon/test/telegram-threading.test.ts` — the reply-author cases.

**Modified — web console:**

- `packages/web/src/lib/api.ts:878`, `packages/web/src/lib/data.ts:2147`, `packages/web/src/components/console/platforms/contract.ts:562` — widen.
- `packages/web/src/components/console/IntegrationChannelList.tsx:44-62` — the fourth option, the explicit allow-list default.
- `packages/web/src/components/console/platforms/telegram/index.tsx` — declare `triggers`.
- `packages/web/src/components/console/modals/NativeIntegrationDialog.tsx:155,193-201` — the fourth option and the widened cast.

**Modified — docs:** `docs/product-conventions.md:275-280,505-535`.

---

### Task 1: The `mention_topic` enum value, end to end on the CP

Widening the enum forces every declaration site to be revisited, and Prisma's generated client is the only thing that makes them fail. This task is one vertical slice: schema → migration → generated client → the four CP declarations, verified by `typecheck`.

**Files:**

- Modify: `packages/control-plane/prisma/schema.prisma:2476-2482`
- Create: `packages/control-plane/prisma/migrations/20261010000000_channel_trigger_mention_topic/migration.sql`
- Modify: `packages/control-plane/src/persistence/ports.ts:5036`
- Modify: `packages/control-plane/src/http/dto/index.ts:919`, `:1794`
- Modify: `packages/control-plane/src/http/mcp/tools.ts:997`
- Test: `packages/control-plane/test/integration/integration-channels.test.ts` (existing file, add a case)

**Interfaces:**

- Consumes: nothing.
- Produces: the Prisma enum member `ChannelTrigger.mention_topic`, and the TypeScript union `'off' | 'mention' | 'mention_topic' | 'any'` exported as `ChannelTrigger` from `persistence/ports.ts`.

- [ ] **Step 1: Write the failing test**

The CP's integration suite is the only level that proves the value survives a real Postgres round trip — the enum is enforced by the database, so a mocked test would pass on a value the DB refuses.

Add a case to `packages/control-plane/test/integration/integration-channels.test.ts`, next to the existing PATCH-trigger-flip case at `:1080`. The file already has `install(running)`, `report(daemonId, integrationId, channels)` and `SpyControl` — reuse them; this is the same shape as its neighbour, with the new value.

```ts
it('persists a mention_topic trigger and re-pushes a spec with an empty fence for the rest', async () => {
  // The value is enforced by the Postgres enum type, so this only passes once the
  // migration has run — a unit test cannot prove it.
  await seedDaemon(prisma, DAEMON)
  const spy = new SpyControl()
  running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
  const id = await install(running)
  await report(DAEMON, id, [
    { id: 'C1', name: 'deploys' },
    { id: 'C2', name: 'quiet' }
  ])
  spy.upserts.length = 0

  const res = await running.app.inject({
    method: 'PATCH',
    url: `${ORG}/integrations/${id}/channels/C2`,
    payload: { trigger: 'mention_topic' }
  })
  expect(res.statusCode).toBe(200)

  const row = (await new PgIntegrationChannelRepo(prisma).listForIntegration(IntegrationId(id))).find(
    (c) => c.channelId === 'C2'
  )
  expect(row).toMatchObject({ trigger: 'mention_topic' })

  // The re-pushed spec carries the fence, and C1 — untouched — is not in it.
  const u0 = spy.upserts[0]!.u
  if (u0.platform !== 'slack') throw new Error('expected slack integration')
  expect(u0.core!.affinityDenied).toEqual(['C2'])
  expect(u0.core!.mutedChannels).toEqual([])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentconnect.md/control-plane exec vitest run --project integration test/integration/integration-channels.test.ts`

Expected: FAIL — TypeScript refuses `'mention_topic'` against `ChannelTrigger`, because the union is still three values.

- [ ] **Step 3: Add the enum value and the migration**

In `packages/control-plane/prisma/schema.prisma`, replace lines 2476-2482:

```prisma
// How the bot activates in one conversation: not at all (conversation gating,
// resource-visibility.md §14), only when @-mentioned, on any message, or only on
// an explicit address — an @-mention or a reply to one of the agent's own
// messages (the reply half needs a transcript lookup, so it is per-platform).
enum ChannelTrigger {
  off
  mention
  mention_topic
  any
}
```

Create `packages/control-plane/prisma/migrations/20261010000000_channel_trigger_mention_topic/migration.sql`:

```sql
-- By mention + reply joins the conversation trigger; a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "ChannelTrigger" ADD VALUE IF NOT EXISTS 'mention_topic';
```

The comment is copied from upstream's structurally identical `20261014000000_channel_trigger_decision` migration, which states the constraint. The `IF NOT EXISTS` is load-bearing: `ADD VALUE` cannot run inside the transaction that uses the value, and Prisma's migrate runs each file in one.

- [ ] **Step 4: Widen the four CP declarations**

`packages/control-plane/src/persistence/ports.ts:5036`:

```ts
export type ChannelTrigger = 'off' | 'mention' | 'mention_topic' | 'any'
```

`packages/control-plane/src/http/dto/index.ts:919` and `:1794` — both become:

```ts
trigger: z.enum(['off', 'mention', 'mention_topic', 'any']),
```

(the `:1794` one keeps its trailing `.optional()`).

`packages/control-plane/src/http/mcp/tools.ts:997`:

```ts
trigger: z.enum(['off', 'mention', 'mention_topic', 'any']).optional(),
```

- [ ] **Step 5: Regenerate the Prisma client and run the test**

Run: `pnpm --filter @agentconnect.md/control-plane prisma:generate`
Then: `pnpm --filter @agentconnect.md/control-plane exec vitest run --project integration test/integration/integration-channels.test.ts`

Expected: PASS. The generated client under `src/generated/prisma` is gitignored and stale until this step runs — `typecheck` and `build` run it as a pre-step, but the test runner does not.

- [ ] **Step 6: Typecheck the CP**

Run: `pnpm --filter @agentconnect.md/control-plane typecheck`

Expected: PASS. If it reports a site this task missed, that file declares the trigger union a fifth time — widen it and re-run. Do not widen `httpBot.ts` or `linkedDm.ts`: they compare against literals, not against a named union.

- [ ] **Step 7: Commit**

```bash
git add packages/control-plane/prisma packages/control-plane/src/persistence/ports.ts \
  packages/control-plane/src/http/dto/index.ts packages/control-plane/src/http/mcp/tools.ts \
  packages/control-plane/test/integration/integration-channels.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
feat(cp): add the mention_topic channel trigger

A fourth per-conversation trigger: answer an @-mention or a reply to one of
the agent's own messages, and nothing else.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The `affinityDenied` fence on the wire, carried by the daemon

The fence has to reach the ladder, which lives in a package with no I/O and no config knowledge. So it is carried per rule exactly as `mutedChannels` is, which means the envelope → `integrationCore` → `RoutingRule` path has to be widened in one piece. Splitting it would leave a task whose code compiles but is inert.

**Files:**

- Modify: `packages/protocol/src/frames/integration.ts:146-152`
- Modify: `packages/daemon/src/platforms/integration-config.ts:68-77`, `:143-151`
- Modify: `packages/daemon/src/router/routing-rule.ts:39-47`, `:100-133`, `:135-157`
- Modify: `packages/daemon/src/agents/agent-schema.ts:79`
- Test: `packages/daemon/test/routing-rule.test.ts` (existing file, add a `describe`)

**Interfaces:**

- Consumes: nothing from Task 1 (the two are independent; the CP only starts producing the field in Task 5).
- Produces: `IntegrationCore.affinityDenied: string[]`, `IntegrationCoreEnvelope.affinityDenied: string[]` (defaulted `[]`), and `ActivationRule.affinityDenied?: string[]` carried by `rulesFromAgent`, `resolveCpRule`, and `resolveAgentIntegration` — the last one returning it as a top-level `affinityDenied: string[]` alongside `mutedChannels`.

- [ ] **Step 1: Write the failing test**

Append to `packages/daemon/test/routing-rule.test.ts`:

```ts
describe('affinityDenied (§6.4 core-envelope read, mirroring mutedChannels)', () => {
  it('carries the fence from the envelope onto every rule of the integration', () => {
    const a = agent({
      integrations: [
        {
          id: 'int1',
          platform: 'telegram',
          core: { bindRules: [{ match: { kind: 'mention' } }], affinityDenied: ['-100'] },
          config: { botToken: 'x' } as any
        }
      ]
    })
    expect(rulesFromAgent(a, {})[0]!.affinityDenied).toEqual(['-100'])
  })

  it('reads as no fence when the integration carries none', () => {
    // A hand-assembled integration bypasses the schema's default, so integrationCore
    // has to normalize it — the same reason mutedChannels is normalized there.
    const a = agent({
      integrations: [
        {
          id: 'int1',
          platform: 'telegram',
          core: { bindRules: [{ match: { kind: 'mention' } }] },
          config: { botToken: 'x' } as any
        }
      ]
    })
    expect(rulesFromAgent(a, {})[0]!.affinityDenied).toEqual([])
  })

  it('resolves it off the agent the same way mutedChannels is resolved', () => {
    const a = agent({
      integrations: [
        {
          id: 'int1',
          platform: 'telegram',
          core: { mode: 'direct', bindRules: [], mutedChannels: ['C9'], affinityDenied: ['C-T'], gated: false },
          config: { botToken: 'x', botUserId: 'BTG' } as any
        }
      ]
    })
    expect(resolveAgentIntegration(a, {})).toMatchObject({
      integrationId: 'int1',
      mutedChannels: ['C9'],
      affinityDenied: ['C-T']
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/routing-rule.test.ts`

Expected: FAIL — `core.affinityDenied` is not a known property, so the object literal is a type error, and `rulesFromAgent(...)[0].affinityDenied` is `undefined` rather than `['-100']`.

- [ ] **Step 3: Widen the wire envelope**

In `packages/protocol/src/frames/integration.ts`, replace the `IntegrationCoreEnvelope` object at line 146:

```ts
export const IntegrationCoreEnvelope = z.object({
  mode: z.enum(['direct', 'shared']).default('direct'),
  bindRules: z.array(IntegrationBindRule).default([]),
  mutedChannels: z.array(z.string()).default([]),
  // Conversations where an implicit continuation (an open session) is denied: only an
  // explicit address — an @-mention or a reply to one of the agent's own messages
  // reaches it. Orthogonal to `mutedChannels`, which silences the conversation outright.
  affinityDenied: z.array(z.string()).default([]),
  gated: z.boolean().default(false)
})
```

Defaulted so an old CP/daemon pair is unaffected in either direction.

- [ ] **Step 4: Widen the daemon's envelope read**

In `packages/daemon/src/platforms/integration-config.ts`, add to `IntegrationCore` after `mutedChannels`:

```ts
  /** Conversations that admit only an explicit address. Normalized here for the same
   *  reason `mutedChannels` is: a hand-assembled integration has no parsed default. */
  affinityDenied: string[]
```

and to the `integrationCore` return:

```ts
    affinityDenied: core?.affinityDenied ?? [],
```

- [ ] **Step 5: Carry it through the router**

In `packages/daemon/src/router/routing-rule.ts`, widen `integrationRouting`'s return type and body:

```ts
export function integrationRouting(int: Integration): {
  staticBotUserId?: string
  bindRules: BindRuleConfig[]
  mutedChannels: string[]
  affinityDenied: string[]
  gated: boolean
} {
  const { bindRules, mutedChannels, affinityDenied, gated } = integrationCore(int)
  return { staticBotUserId: configuredBotSelfId(int), bindRules, mutedChannels, affinityDenied, gated }
}
```

In `resolveAgentIntegration`, add `affinityDenied` to the return type and to the returned object, beside `mutedChannels` — read it off the same `integrationRouting` destructure:

```ts
const { staticBotUserId, mutedChannels, affinityDenied } = integrationRouting(int)
return {
  integrationId: int.id,
  botUserId: botUserIds[int.id] ?? staticBotUserId ?? '',
  platform: int.platform,
  mutedChannels,
  affinityDenied
}
```

In `rulesFromAgent`, destructure it and put it on each pushed rule beside `mutedChannels`:

```ts
const { staticBotUserId, bindRules, mutedChannels, affinityDenied } = integrationRouting(int)
const botUserId = botUserIds[int.id] ?? staticBotUserId ?? ''
for (const br of bindRules) {
  out.push({
    agentId: agent.id,
    integrationId: int.id,
    botUserId,
    scope: { ...(br.channel ? { channel: br.channel } : {}), ...(br.thread ? { thread: br.thread } : {}) },
    match: br.match,
    mutedChannels,
    affinityDenied,
    source: 'config',
    platform: int.platform
  })
}
```

In `resolveCpRule`, widen the `resolve` callback's return type to include `affinityDenied?: string[]` and carry it the way `mutedChannels` already is:

```ts
    ...(r.mutedChannels ? { mutedChannels: r.mutedChannels } : {}),
    ...(r.affinityDenied ? { affinityDenied: r.affinityDenied } : {}),
```

The docblock on `conversationAdmitted` says it reads "the two independent fences" (Off and gating). Leave that predicate alone — it takes a structural `Pick`, and adding a key to the source type does not change it.

- [ ] **Step 6: Add the field to the hand-written default literal**

In `packages/daemon/src/agents/agent-schema.ts:79`:

```ts
  core: IntegrationCoreEnvelope.default({
    mode: 'direct',
    bindRules: [],
    mutedChannels: [],
    affinityDenied: [],
    gated: false
  }),
```

This literal **is** load-bearing, and this was verified rather than assumed: `z.object({...}).default(literal)` in zod 4.6.5 returns the literal verbatim on `parse(undefined)` and does **not** re-parse it through the object's own field defaults. A probe confirmed both halves — parsing `undefined` returned the literal unchanged (missing the field), while parsing the old literal returned it with `affinityDenied: []` filled in. So omitting this line would hand `integrationCore` a `core` object with no `affinityDenied` — harmless only because `integrationCore` normalizes with `?? []`, but a stale literal is a worse failure than a redundant one, and this path is the one a hand-authored `agent.json` takes.

- [ ] **Step 7: Update the four exact-shape assertions the new key breaks**

Three existing assertions in `packages/daemon/test/routing-rule.test.ts` use `toEqual` on the widened shapes, so they fail the moment the field exists. They are the reason `typecheck` alone would not catch this — the shapes are structurally valid, only the equality changes.

At `:87` and `:153`, inside the `integrationRouting` cases (each is a `toEqual({ staticBotUserId, bindRules, mutedChannels, gated })`), add `affinityDenied: []` after `mutedChannels`. At `:95` the `integrationCore` assertion takes the same addition:

```ts
expect(integrationCore(int)).toEqual({
  mode: 'direct',
  bindRules,
  mutedChannels: ['C9'],
  affinityDenied: [],
  gated: true
})
```

At `:216` and `:223`, the two `resolveAgentIntegration` assertions, add `affinityDenied: []` after `mutedChannels: []`.

Leave `conversationAdmitted`'s own cases alone — it takes a structural `Pick` and is unaffected.

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/routing-rule.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/protocol/src/frames/integration.ts packages/daemon/src/platforms/integration-config.ts \
  packages/daemon/src/router/routing-rule.ts packages/daemon/src/agents/agent-schema.ts \
  packages/daemon/test/routing-rule.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
feat(routing): carry an affinityDenied fence on the core envelope

The fence says a conversation admits only an explicit address. It rides the
rule set the way mutedChannels does, so the pure ladder stays pure.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Resolve who authored the message being replied to

The reply half is nearly free: Telegram already appends _"↩️ To continue this topic, please reply to this message"_, and the agent's own posts are recorded with `ts` = the real platform message id and `sender` = the agent id. The same transcript row is already fetched to place the reply's thread — it carries a `sender` column that nothing reads. This task widens that one lookup.

**Files:**

- Modify: `packages/daemon/src/messages/normalized.ts:44` (beside `transcriptTs`)
- Modify: `packages/daemon/src/store/local-store.ts:4825-4830`
- Modify: `packages/daemon/src/platforms/telegram/threading.ts:14-19`, `:45-72`
- Test: `packages/daemon/test/telegram-threading.test.ts` (existing file, add cases to the `canonicalizeTelegramThread` describe)

**Interfaces:**

- Consumes: nothing (independent of Tasks 1 and 2).
- Produces: `NormalizedMessage.replyToAuthor?: string`; `TelegramThreadingHost.threadForMessage(transcriptChannel, messageId): Promise<{ thread: string; sender: string } | undefined>`; `LocalStore.telegramThreadForMessage` widened to the same record.

- [ ] **Step 1: Write the failing test**

Add to the `describe('canonicalizeTelegramThread', …)` block in `packages/daemon/test/telegram-threading.test.ts`, after the existing "continues the session a replied-to message belongs to" case (`:340`):

```ts
it('records the author of the replied-to message, not just its thread', async () => {
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
  await daemon.start()
  // The agent's own post: `ts` is the real platform id, `sender` is the agent id.
  await (daemon as any).store.appendTranscript({
    channel: '-100',
    thread: '555',
    ts: '500',
    sender: 'bot-a',
    kind: 'text',
    text: 'answer'
  })

  const m = tg(600, { topicId: '555', replyTo: '500' })
  await (daemon as any).canonicalizeTelegramThread(m)

  expect(m.thread).toBe('555')
  expect(m.replyToAuthor).toBe('bot-a')
})

it('leaves a reply to a person as that person’s id', async () => {
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
  await daemon.start()
  await (daemon as any).store.appendTranscript({
    channel: '-100',
    thread: '555',
    ts: '499',
    sender: 'U1',
    kind: 'text',
    text: 'a question'
  })

  const m = tg(600, { topicId: '555', replyTo: '499' })
  await (daemon as any).canonicalizeTelegramThread(m)

  // A reply to a human must never read as an address to the agent.
  expect(m.replyToAuthor).toBe('U1')
})

it('leaves replyToAuthor unset when the replied-to message is unknown', async () => {
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
  await daemon.start()

  const m = tg(600, { topicId: '555', replyTo: '999' })
  await (daemon as any).canonicalizeTelegramThread(m)

  expect(m.thread).toBe('555')
  expect(m.replyToAuthor).toBeUndefined()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/telegram-threading.test.ts -t 'replied-to message'`

Expected: FAIL — `m.replyToAuthor` is `undefined`.

- [ ] **Step 3: Declare the internal fact**

In `packages/daemon/src/messages/normalized.ts`, after `transcriptTs` (line 44):

```ts
  /**
   * Who authored the message this one replies to, as the transcript recorded it: an
   * agent id when the replied-to message was one of ours, a platform user id when it
   * was a person's. Undefined when nothing resolvable. Daemon-internal — never on the
   * wire, and never read by a platform adapter.
   */
  replyToAuthor?: string
```

- [ ] **Step 4: Widen the transcript lookup**

In `packages/daemon/src/store/local-store.ts`, replace `telegramThreadForMessage` (line 4825):

```ts
  async telegramThreadForMessage(
    channel: string,
    messageId: string
  ): Promise<{ thread: string; sender: string } | undefined> {
    const row = (await this.db
      .prepare(
        "SELECT thread, sender FROM transcript WHERE channel = ? AND ts = ? AND kind = 'text' ORDER BY seq DESC LIMIT 1"
      )
      .get(channel, messageId)) as { thread: string; sender: string } | undefined
    return row
  }
```

Query shape is unchanged, so no index question. Update the docblock: it currently says the method returns a thread id; it now also returns the row's author, which is what makes a reply an address rather than mere continuity.

- [ ] **Step 5: Restructure the threading ladder**

In `packages/daemon/src/platforms/telegram/threading.ts`, widen the host interface:

```ts
export interface TelegramThreadingHost {
  threadForMessage(
    transcriptChannel: string,
    messageId: string
  ): Promise<{ thread: string; sender: string } | undefined>
}
```

Then replace `canonicalizeTelegramThread` (lines 45-72):

```ts
export async function canonicalizeTelegramThread(
  host: TelegramThreadingHost,
  msg: NormalizedMessage,
  transcriptChannel: string
): Promise<void> {
  if (msg.platform !== 'telegram' || msg.thread !== undefined) return
  if (msg.isDm) {
    // Ahead of the lookup: a DM is one continuous session and its rows carry the binary
    // Off/On control, never this trigger, so the reply author is never consulted.
    msg.thread = 'dm'
    return
  }
  // ONE lookup answers both questions — the replied-to message's session and its author
  // (the row already carries `sender`). A forum topic needs only the second and the
  // non-topic reply path needs both, so the lookup sits ahead of the branch.
  const reply = msg.replyTo !== undefined ? await host.threadForMessage(transcriptChannel, msg.replyTo) : undefined
  if (reply !== undefined) msg.replyToAuthor = reply.sender
  const topicId = msg.topicId
  if (topicId !== undefined) {
    msg.thread = topicId
    return
  }
  const threadRoot = msg.threadRoot
  if (threadRoot !== undefined) {
    msg.thread = `tg:${threadRoot}`
    return
  }
  if (msg.replyTo) {
    msg.thread = reply?.thread ?? `tg:${msg.replyTo}`
    return
  }
  msg.thread = `tg:${telegramMessageId(msg)}`
}
```

The `threadRoot` branch is not wasted work: a reply in a plain (non-forum) Telegram supergroup carries `message_thread_id` and takes that branch, and `mention_topic` is offered for those rows too. The DM case is the only one reordered away.

Update the function's docblock to add one line noting that a reply also resolves its author, and that this costs one lookup in a forum topic where it previously cost none.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/telegram-threading.test.ts`

Expected: PASS — including the pre-existing `:753` assertion, which now compares an object. That assertion reads:

```ts
expect(await (daemon as any).store.telegramThreadForMessage('-100', 'out-9')).toBe('tg:100')
```

Change it to:

```ts
expect(await (daemon as any).store.telegramThreadForMessage('-100', 'out-9')).toMatchObject({
  thread: 'tg:100',
  sender: 'bot-a'
})
```

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/messages/normalized.ts packages/daemon/src/store/local-store.ts \
  packages/daemon/src/platforms/telegram/threading.ts packages/daemon/test/telegram-threading.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
feat(telegram): resolve who authored the message a reply answers

The transcript row was already being fetched to place the reply's thread, and
it already carried the author. One extra column, no new query.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The fence in the ladder — both traps

This is the change's core. Rung 2 is one trap; the participant fan-out is the other, and in the two-agent case it is the only delivery path. They share one predicate, applied in two places.

**Files:**

- Modify: `packages/activation-policy/src/index.ts:28-43`, `:47-55`, `:119-128`, `:186-198`
- Modify: `packages/daemon/test/route-rules.test.ts` (the end-to-end wiring case)
- Test: `packages/activation-policy/test/policy.test.ts`

**Interfaces:**

- Consumes: `ActivationRule.affinityDenied?: string[]` (Task 2 produces it; the policy package only declares it).
- Produces: `ActivationMessageFacts.replyToAuthor?: string`; the module-private `continuityAdmits(r, msg): boolean`. `routeRules`, `participantAgents`, and `conversationPeers` keep their existing signatures.

- [ ] **Step 1: Write the failing tests**

Append to `packages/activation-policy/test/policy.test.ts`. The file's existing `msg` (`:19`) and `rule` (`:30`) helpers are reused — but its import list at `:3-11` does **not** include `participantAgents`, so add it there first:

```ts
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
```

Then:

```ts
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
    expect(routeRules(msg(), rules, () => 'a1')).toBeNull()
  })

  it('admits a reply to the owner', () => {
    const rules = [fenced('a1')]
    expect(routeRules(msg({ replyToAuthor: 'a1' }), rules, () => 'a1')).toMatchObject({
      agentId: 'a1',
      via: 'thread'
    })
  })

  it('routes a reply to a different agent to nobody', () => {
    // A reply is an address to ONE agent; the owner must not inherit it.
    const rules = [fenced('a1')]
    expect(routeRules(msg({ replyToAuthor: 'a2' }), rules, () => 'a1')).toBeNull()
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
    expect(routeRules(msg(), rules, () => 'a1')).toMatchObject({ agentId: 'a1', via: 'thread' })
  })

  it('denies participants without a reply, and admits the reply author', () => {
    const rules = [fenced('a1'), fenced('a2')]
    expect(participantAgents(msg(), rules, ['a1', 'a2'])).toEqual([])
    expect(participantAgents(msg({ replyToAuthor: 'a1' }), rules, ['a1', 'a2'])).toEqual(['a1'])
  })

  it('the multi-agent case routes through participants alone', () => {
    // `threadOwner` returns null when 2+ agents share a thread, so rung 2 delivers
    // nothing and `participantAgents` is the ONLY path — a single-agent test misses it.
    const rules = [fenced('a1'), fenced('a2')]
    const peers = conversationPeers(msg({ replyToAuthor: 'a1' }), rules, ['a1', 'a2'])
    expect(peers.peers).toEqual(['a1'])
    expect(routeRules(msg({ replyToAuthor: 'a1' }), rules, () => null)).toBeNull()
  })

  it('does not revive a dormant owner', () => {
    // `threadOwner` falls back to `closedSessionAgents`, so the fence has to deny what
    // it returns rather than check liveness itself.
    const rules = [fenced('a1')]
    expect(routeRules(msg(), rules, () => 'a1')).toBeNull()
  })

  it('leaves the verified-agent delivery gate unchanged', () => {
    // conversationAdmitsAgent reproduces OFF, not this trigger: an agent delivery is
    // explicit by construction and must keep reaching a fenced conversation.
    const rules = [fenced('a1')]
    expect(conversationAdmitsAgent(rules, 'a1', 'C1')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @agentconnect.md/activation-policy exec vitest run test/policy.test.ts -t 'affinityDenied'`

Expected: FAIL — `affinityDenied` and `replyToAuthor` are unknown properties. The first case fails with `{ agentId: 'a1', … }` where `null` was expected, which is the current (wrong) behavior.

- [ ] **Step 3: Declare the fact and the fence**

In `packages/activation-policy/src/index.ts`, add to `ActivationRule` after `mutedChannels` (line 37):

```ts
  /** Conversations that admit only an explicit address (an @-mention or a reply to one
   *  of this agent's own messages). The implicit continuity rungs are denied here, so an
   *  open session alone never delivers — unlike `mutedChannels`, which silences outright. */
  affinityDenied?: string[]
```

Add to `ActivationMessageFacts` after `mentionedBots` (line 53):

```ts
  /** The transcript author of the message this one replies to, where the platform can
   *  resolve it — an agent id for one of ours, a platform user id for a person's. */
  replyToAuthor?: string
```

- [ ] **Step 4: Add the predicate**

Immediately after `scopeMatches` (line 80), before `kindMatches`:

```ts
/** Is this rule reachable here by continuity alone — an open session, not an address?
 *  Separate from `scopeMatches`, which is the DELIVERY fence: putting this there would
 *  kill @-mentions too, which is what `off` does and this must not. */
function continuityAdmits(r: ActivationRule, msg: ActivationMessageFacts): boolean {
  if (!r.affinityDenied?.some((denied) => channelInScope(denied, msg))) return true
  return msg.replyToAuthor !== undefined && msg.replyToAuthor === r.agentId
}
```

- [ ] **Step 5: Apply it at rung 2**

Replace lines 195-196:

```ts
const ownerRule = scopeCandidates.find((x) => x.agentId === owner && continuityAdmits(x, msg))
if (ownerRule) return pickRule(ownerRule, 'thread') // continuity, kind-agnostic
```

- [ ] **Step 6: Apply it to `participantAgents`**

Replace line 126:

```ts
const servable = new Set(rules.filter((r) => scopeMatches(r, msg) && continuityAdmits(r, msg)).map((r) => r.agentId))
```

Because `conversationPeers` unions `participantAgents ∪ mentionedAgents ∪ automaticAgents`, this one edit covers both fan-out call sites and leaves the explicit paths intact: a mention still joins, and an `auto` rule (which only `any` produces) is untouched.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @agentconnect.md/activation-policy test`
Then: `pnpm --filter @agentconnect.md/activation-policy typecheck`

Expected: PASS, including the twelve pre-existing tests.

- [ ] **Step 8: Wire the daemon end to end**

The policy package's own tests prove the predicate; this proves the fence survives the trip from `agent.json` through `rulesFromAgent` into the ladder, which is where a dropped field would go unnoticed.

Append to `packages/daemon/test/route-rules.test.ts`. Its `agent`, `msg` and `rule` helpers are at the top of the file — note `agent()` builds `core: { bindRules }` with no `affinityDenied`, so pass it through the agent's integration:

```ts
describe('affinityDenied reaches the ladder from agent.json', () => {
  it('denies an unaddressed message and admits a reply, through rulesFromAgent', () => {
    const a = agent('bot-a', [{ match: { kind: 'mention' } }])
    ;(a.integrations[0]!.core as { affinityDenied?: string[] }).affinityDenied = ['C1']
    const rules = rulesFromAgent(a, { 'bot-a-int': 'BOTA' })
    const owner = () => 'bot-a'

    // Today this routes to bot-a; with the fence in force it must not.
    expect(routeRules(msg({ text: 'anything' }), rules, owner)).toBeNull()
    expect(routeRules(msg({ text: 'a reply', replyToAuthor: 'bot-a' }), rules, owner)).toMatchObject({
      agentId: 'bot-a',
      via: 'thread'
    })
    expect(routeRules(msg({ text: '<@BOTA> hi', mentionedBots: ['BOTA'] }), rules, owner)).toMatchObject({
      agentId: 'bot-a',
      via: 'mention'
    })
  })
})
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/route-rules.test.ts test/router.test.ts test/routing-rule.test.ts`

Expected: PASS. These consume the policy package through `routing-table.ts` and are the canary for an unintended ladder change.

- [ ] **Step 10: Commit**

```bash
git add packages/activation-policy/src/index.ts packages/activation-policy/test/policy.test.ts \
  packages/daemon/test/route-rules.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
feat(policy): deny implicit continuity in an explicitly-addressed conversation

One predicate at the two rungs that express continuity: thread affinity and
the participant fan-out. A reply keeps via:'thread' — it is continuity, not an
address, so no reminder is injected and no !stop latch is cleared.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Compile the trigger in the control plane

`mention_topic` needs no positive rule — the unscoped mention default already covers the mention half. Only the fence is new, and it is orthogonal to gating.

**Files:**

- Modify: `packages/control-plane/src/orchestrator/placement.ts:232-241`, `:256-259`, `:292`, `:302`, `:336-341`
- Test: `packages/control-plane/src/orchestrator/placement.test.ts:89`, and new cases

**Interfaces:**

- Consumes: `IntegrationCoreEnvelope.affinityDenied` (Task 2).
- Produces: `affinityDenied` populated on both `integrationToSpec`'s and `httpIntegrationToSpec`'s envelope.

- [ ] **Step 1: Write the failing tests**

First widen the fixture's trigger union at `placement.test.ts:89`:

```ts
const channel = (
  channelId: string,
  trigger: 'off' | 'mention' | 'mention_topic' | 'any',
  kind: 'channel' | 'im' | 'mpim' = 'channel'
): IntegrationChannelRecord => ({
```

Then append a `describe` to the file:

```ts
describe('mention_topic → the affinityDenied fence', () => {
  it('fences the conversation and adds no rule of its own', async () => {
    const spec = await specOf(INTEGRATION, SECRET, [channel('C1', 'mention_topic')])
    // The unscoped mention default already covers the mention half.
    expect(spec.core.bindRules).toEqual([{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }])
    expect(spec.core.affinityDenied).toEqual(['C1'])
    // Not Off: the conversation stays admitted, so control commands still resolve.
    expect(spec.core.mutedChannels).toEqual([])
  })

  it('adds no auto rule, so nothing can deliver unaddressed traffic', async () => {
    const spec = await specOf(INTEGRATION, SECRET, [channel('C1', 'mention_topic'), channel('C2', 'any')])
    expect(spec.core.bindRules).toEqual([
      { match: { kind: 'mention' } },
      { match: { kind: 'dm' } },
      { channel: 'C2', match: { kind: 'auto' } }
    ])
    expect(spec.core.affinityDenied).toEqual(['C1'])
  })

  it('gated: still grants the scoped mention rule, and still fences', async () => {
    // Gating expresses Off as the MISSING scoped rule; the fence is about addressing,
    // so it applies either way.
    const spec = await specOf(INTEGRATION, SECRET, [channel('C1', 'mention_topic')], true)
    expect(spec.core.bindRules).toEqual([{ channel: 'C1', match: { kind: 'mention' } }])
    expect(spec.core.affinityDenied).toEqual(['C1'])
    expect(spec.core.mutedChannels).toEqual([])
  })

  it('leaves an integration with no mention_topic conversation unaffected', async () => {
    // The wire default is what keeps an old CP/daemon pair behaving as before.
    const spec = await specOf(INTEGRATION, SECRET, [channel('C1', 'mention'), channel('C2', 'any')])
    expect(spec.core.affinityDenied).toEqual([])
  })

  it('reaches the shared-mode envelope too', async () => {
    // `bot({ transport: 'http' })` — the shared-mode projector withholds the spec for a
    // socket bot, and `specOf` asserts non-null, so the plain `bot()` would fail here.
    const spec = await httpIntegrationToSpec(PLATFORMS, INTEGRATION, bot({ transport: 'http' }), SECRET, [
      channel('C1', 'mention_topic')
    ])
    expect(spec?.core.affinityDenied).toEqual(['C1'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @agentconnect.md/control-plane exec vitest run --project unit src/orchestrator/placement.test.ts`

Expected: FAIL — `spec.core.affinityDenied` is `undefined`.

- [ ] **Step 3: Add the fence function**

In `packages/control-plane/src/orchestrator/placement.ts`, after `mutedChannelIds` (line 259):

```ts
/** The explicit-address conversations of an integration — its `affinityDenied` fence.
 *  Unlike `mutedChannels` this is NOT skipped when gated: Off is expressed by the missing
 *  scoped rule, but affinity denial is orthogonal to the grant. */
function affinityDeniedChannelIds(channels: IntegrationChannelRecord[]): string[] {
  return channels.filter((c) => c.trigger === 'mention_topic').map((c) => c.channelId)
}
```

- [ ] **Step 4: Mark the `gatedBindRules` ordering hazard**

The `else` at line 238 is correct at `v1.60.0`. It is also the exact trap upstream hit when it added `decision` — the loop grew an early branch and the new value would have silently become a mention rule. Add the comment so the future merge has the instruction in place:

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
  return out
}
```

- [ ] **Step 5: Add the fence to both envelopes**

In `integrationToSpec`, after the `mutedChannels` line (292):

```ts
const affinityDenied = affinityDeniedChannelIds(channels)
// §6.4 final shape: envelope + opaque config. ...
const core = { mode: 'direct' as const, bindRules, mutedChannels, affinityDenied, gated }
```

In `httpIntegrationToSpec`, in the `httpCore` object (336-341):

```ts
const httpCore = {
  mode: 'shared' as const,
  bindRules: gated ? gatedBindRules(channels) : [],
  mutedChannels: mutedChannelIds(channels, gated),
  affinityDenied: affinityDeniedChannelIds(channels),
  gated
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @agentconnect.md/control-plane exec vitest run --project unit`
Then: `pnpm --filter @agentconnect.md/control-plane typecheck`

Expected: PASS. The full unit project runs because `placement.test.ts` shares fixtures with `placementResolver.test.ts` and the provider tests, and all of them construct `IntegrationChannelRecord`s.

- [ ] **Step 7: Commit**

```bash
git add packages/control-plane/src/orchestrator/placement.ts packages/control-plane/src/orchestrator/placement.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
feat(cp): compile mention_topic into an affinityDenied fence

No positive rule is needed — the unscoped mention default already covers the
mention half. Only the subtraction has to be stated.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Offer the option in the console

A fourth value would otherwise leak to platforms that cannot implement it — the reply half needs a per-message author lookup only the daemon's transcript can answer. So the allow-list flips from "absent ⇒ all" to an explicit default.

**Files:**

- Modify: `packages/web/src/lib/api.ts:878`
- Modify: `packages/web/src/lib/data.ts:2147`
- Modify: `packages/web/src/components/console/platforms/contract.ts:560-562`
- Modify: `packages/web/src/components/console/IntegrationChannelList.tsx:44-62`
- Modify: `packages/web/src/components/console/platforms/telegram/index.tsx` (the `channelList` block, line 31)
- Modify: `packages/web/src/components/console/modals/NativeIntegrationDialog.tsx:155`, `:193-201`
- Test: `packages/web/src/components/console/IntegrationChannelList.trigger.test.tsx` (new), `packages/web/src/components/console/platforms/telegram/module.test.tsx` (new), `packages/web/src/components/console/platforms/linear/module.test.tsx` (existing)

**Interfaces:**

- Consumes: the widened CP DTO (Task 1).
- Produces: the `triggers` allow-list type `readonly ('off' | 'mention' | 'mention_topic' | 'any')[]`; `telegramModule.channelList.triggers`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/src/components/console/IntegrationChannelList.test.ts`. This file currently imports `renderToStaticMarkup` only, but the options live inside an `AnchoredFlyout`, which portals its menu and renders nothing until it is opened — so these cases need a real DOM and a click. Put them in a **new** file, `IntegrationChannelList.trigger.test.tsx`, with the `happy-dom` pragma every interactive web test in this repo uses (120 files do):

```tsx
// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { IntegrationChannelList } from './IntegrationChannelList'

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    setChannelTrigger: vi.fn(),
    setChannelAgent: vi.fn(),
    forgetChannel: vi.fn(),
    leaveConversation: vi.fn(),
    bots: [],
    agents: [],
    integrations: []
  })
}))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Open the row's trigger menu and read its options, in host order. */
async function menuFor(platform: string): Promise<string[]> {
  await act(async () =>
    root.render(
      createElement(IntegrationChannelList, {
        platform,
        gated: false,
        channels: [{ channelId: 'C1', name: 'deploys', kind: 'channel', trigger: 'mention' }]
      })
    )
  )
  const trigger = [...document.querySelectorAll('button')].find((b) =>
    b.getAttribute('aria-label')?.startsWith('Trigger for')
  )!
  await act(async () => trigger.click())
  return [...document.querySelectorAll('[role="menuitemradio"]')].map((o) => o.textContent ?? '')
}

describe('the trigger menu’s platform vocabulary', () => {
  it('offers the reply option on Telegram', async () => {
    expect(await menuFor('telegram')).toEqual(['off', 'any message', '@-mention', '@-mention + reply'])
  })

  it('keeps the three agnostic values where the platform declares no allow-list', async () => {
    // Slack's module declares no `triggers`, so the host default applies — the fourth
    // value must not leak to a platform with no reply-derived continuity.
    expect(await menuFor('slack')).toEqual(['off', 'any message', '@-mention'])
  })

  it('never offers the reply option on Linear', async () => {
    expect(await menuFor('linear')).not.toContain('@-mention + reply')
  })
})
```

Create `packages/web/src/components/console/platforms/telegram/module.test.tsx`, mirroring `linear/module.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { channelListSemantics } from '../registry'

describe('telegram channel-list semantics', () => {
  it('offers the reply-aware trigger — it is the only platform with transcript continuity', () => {
    expect(channelListSemantics('telegram').triggers).toEqual(['off', 'mention', 'mention_topic', 'any'])
  })
})
```

And in `linear/module.test.tsx`, extend the existing "offers Mention and Off, never 'any message'" case with one line, since Linear's own allow-list is what proves the default did not silently widen:

```ts
expect(channelListSemantics('linear').triggers).not.toContain('mention_topic')
```

No `data-trigger-option` attribute is needed anywhere: `TriggerSelect` already renders each option with `role="menuitemradio"` and the label as its text content, which is exactly how `linear/card.test.tsx:259` reads its menu.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @agentconnect.md/web exec vitest run src/components/console/IntegrationChannelList.test.ts src/components/console/platforms/telegram/module.test.tsx`

Expected: FAIL — with the current `?? ['off', 'mention', 'any']`-less default, Telegram's list is the three values, and `channelListSemantics('telegram').triggers` is `undefined`.

- [ ] **Step 3: Widen the three web unions**

`packages/web/src/lib/api.ts:878`:

```ts
// How the bot activates in one conversation: not at all ('off' — conversation
// gating for restricted agents), only when @-mentioned, on any message, or only on
// an explicit address — an @-mention or a reply to the agent's own message.
export type ChannelTrigger = 'off' | 'mention' | 'mention_topic' | 'any'
```

`packages/web/src/lib/data.ts:2147`:

```ts
trigger: 'off' | 'mention' | 'mention_topic' | 'any'
```

`packages/web/src/components/console/platforms/contract.ts:560-562`:

```ts
  /**
   * The room row's trigger vocabulary, host order preserved. Absent ⇒ the three
   * platform-agnostic values (`off` / `any` / `mention`) — the reply-aware fourth
   * needs a per-message author lookup only the daemon's transcript can answer, so
   * it is opt-in per platform. DM rows keep their binary control.
   */
  triggers?: readonly ('off' | 'mention' | 'mention_topic' | 'any')[]
```

- [ ] **Step 4: Add the option and flip the default**

In `packages/web/src/components/console/IntegrationChannelList.tsx`, replace the block at 44-62:

```tsx
// Absent ⇒ the three platform-agnostic values. The reply-aware fourth is opt-in per
// platform: its reply half needs a per-message author lookup only the daemon's
// transcript can answer.
const allowed = channelListSemantics(platform).triggers ?? ['off', 'mention', 'any']
const roomOptions: TriggerOption<IntegrationChannelRow['trigger']>[] = [
  { value: 'off', label: 'off', hint: `The agent doesn't respond in ${here}, even when @-mentioned.` },
  { value: 'any', label: 'any message', hint: `The agent responds to every message in ${here}.` },
  {
    value: 'mention',
    label: '@-mention',
    hint: "The agent responds when @-mentioned. Follow-ups in a thread it has joined don't need another mention."
  },
  {
    value: 'mention_topic',
    label: '@-mention + reply',
    hint: `The agent responds only when @-mentioned or when someone replies to one of its own messages in ${here}.`
  }
]
```

The `mention_topic` option is appended last so the existing three keep their host order. The `roomOptions.filter((o) => allowed.includes(o.value))` line and the DM branch stay as they are.

`TriggerSelect` needs no change — the new option is data, and the component already renders every option generically.

- [ ] **Step 5: Declare Telegram's list**

In `packages/web/src/components/console/platforms/telegram/index.tsx`, in the `channelList` block:

```ts
  channelList: {
    roomNoun: 'group',
    // Telegram groups have no `#name` convention, so the row shows the bare title.
    roomGlyph: '',
    // `leaveChat` needs no extra permission, so a row can be left from the console.
    leave: 'conversation',
    // The reply arm works because the daemon records each post's platform message id
    // beside the bot's own identity, so a reply resolves to the agent that was answered.
    triggers: ['off', 'mention', 'mention_topic', 'any']
  },
```

- [ ] **Step 6: Widen the native dialog**

In `packages/web/src/components/console/modals/NativeIntegrationDialog.tsx`, replace the cast at `:193` and add the option:

```tsx
              onChange={(e) =>
                setDraft({ ...draft, [row.channelId]: e.target.value as 'off' | 'mention' | 'mention_topic' | 'any' })
              }
            >
              <option value="off">Off</option>
              {row.kind !== 'im' && (!allowed || allowed.includes('mention')) && (
                <option value="mention">When mentioned</option>
              )}
              {row.kind !== 'im' && allowed?.includes('mention_topic') && (
                <option value="mention_topic">When mentioned, or on a reply</option>
              )}
              {(row.kind === 'im' || !allowed || allowed.includes('any')) && <option value="any">Every message</option>}
```

Note the `mention_topic` guard is `allowed?.includes(...)` with no `!allowed ||` arm: the dialog's `allowed` comes from the same `channelListSemantics` lookup at `:155`, and an absent list now means the three agnostic values, not "everything".

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @agentconnect.md/web exec vitest run src/components/console/`
Then: `pnpm --filter @agentconnect.md/web typecheck`

Expected: PASS. The Linear card suite (`linear/card.test.tsx:259`) asserts its own menu is exactly `['off', '@-mention']` — that still holds, and it is the regression guard for the default flip.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/lib/data.ts \
  packages/web/src/components/console/platforms/contract.ts \
  packages/web/src/components/console/IntegrationChannelList.tsx \
  packages/web/src/components/console/IntegrationChannelList.trigger.test.tsx \
  packages/web/src/components/console/platforms/telegram/index.tsx \
  packages/web/src/components/console/platforms/telegram/module.test.tsx \
  packages/web/src/components/console/platforms/linear/module.test.tsx \
  packages/web/src/components/console/modals/NativeIntegrationDialog.tsx
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
feat(console): offer @-mention + reply on Telegram conversations

The per-platform allow-list flips from "absent means all" to an explicit
default, so the fourth value cannot leak to a platform with no transcript.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Document the behavior

Per the repo convention this file is product behavior, not a follow-up. It is the last task because it describes what Tasks 1-6 actually shipped.

**Files:**

- Modify: `docs/product-conventions.md:275-280` (thread affinity), `:505-535` (per-conversation trigger)

**Interfaces:**

- Consumes: nothing.
- Produces: nothing. Docs only.

- [ ] **Step 1: Read the two sections**

Read `docs/product-conventions.md` at both ranges before editing. The convention in this file is prose that states _why_, with no implementation vocabulary — no field names, no function names.

- [ ] **Step 2: State the thread-affinity exception**

In the thread-affinity note at `:275-280`, add one sentence naming the exception: a conversation on the reply-aware setting is the one place where joining a thread does not carry an obligation to keep answering, and an explicit address is required again each time.

- [ ] **Step 3: Widen the trigger section**

In "Per-conversation trigger" at `:505-535`, the text currently says channels and group DMs expose all three settings. It becomes four, with the reply half given as the reason — _a reply to one of the agent's own messages is an address_ — and the availability stated: offered on Telegram, and on platforms where the console does not offer it the row is simply absent. Also state the two things an operator will otherwise read as bugs:

- a reply does **not** clear a `!stop` — the documented contract stays "@mention me to resume", and the reply-aware setting already ignores unaddressed traffic;
- in a reply-aware conversation, an agent's own visible post wakes no peers implicitly — a peer needs an explicit hand-off or an @-mention, matching what the trigger's label promises.

- [ ] **Step 4: Check the wording against the shipped behavior**

Re-read both sections and confirm every claim matches what Tasks 1-6 built. Specifically: the sections must not claim the setting exists on Slack, Discord, Feishu, or Linear, and must not describe the reply as a mention.

- [ ] **Step 5: Commit**

```bash
git add docs/product-conventions.md
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
docs(product): record the reply-aware trigger and the affinity exception

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## End-to-end verification

After Task 7, run the workspace gates once, from the repo root:

```bash
pnpm typecheck
pnpm --filter @agentconnect.md/activation-policy test
pnpm --filter @agentconnect.md/daemon test
pnpm --filter @agentconnect.md/control-plane exec vitest run --project unit
pnpm --filter @agentconnect.md/web test
```

`typecheck` matters more than usual here: the trigger union is restated in a dozen files across four packages, and only the compiler sees all of them at once. Docker is required for the CP integration project only; the unit project above needs none.

**What this plan does not verify, and cannot:** a real Telegram forum topic. Nothing in the workspace suite drives a live long-poll. The behavior that motivated the change — one @-mention capturing a whole topic — is only observable against a real bot. Before calling the feature done, take a Telegram group with Topics enabled, set a conversation to `@-mention + reply`, and confirm all five: an unaddressed message is ignored; an @-mention answers; a reply to the agent's own message answers; a reply to _another person's_ message is ignored; and a topic left on plain `@-mention` still behaves exactly as it did before.
