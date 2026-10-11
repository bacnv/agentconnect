# An agent-authored cron

**Status:** design, awaiting review
**Base:** tag `v1.16.0-bacnv` (`a6cf5eda`; branch `feat/agent-cron-tool` is cut from it). Every line
number below is a `v1.16.0-bacnv` line number.
**Scope:** fork-only (`bacnv/agentconnect`). Upstream has no agent-facing cron tool; see _Upstream
divergence_.

## Problem

An agent asked to "chúc cả nhà mỗi ngày" has no AgentConnect-native way to schedule it.

The only agent-facing scheduling tool is `scheduleMessage` (`packages/daemon/src/mcp/tools.ts:749`),
and it is gated on a platform capability Telegram does not declare:

```ts
// packages/daemon/src/platforms/read-ports.ts:146
['slack',    { …, scheduledMessages: true, … }],                                    // :158
['telegram', { platform: 'telegram', label: 'Telegram', attachmentReadTool: … }],  // :165
```

So on Telegram the tool is never offered (`tools.ts:458`), and the agent reaches for the only other
scheduler in its environment: the **Claude Code harness's** `CronCreate`, which persists to
`<workspace>/.claude/scheduled_tasks.json`.

That scheduler lives _inside the CLI process_, and its lock names a session
(`createdBySessionId`, `createdByPid`). The daemon evicts the ACP host at the idle TTL
(`idle: reclaiming host … → provisioned`, 900 s on the observed host), so between evictions no CLI
process exists and nothing ticks. **A harness cron therefore only fires when an unrelated incoming
message happens to resume the session.**

Measured on `netcut-4-8` / agent `815cd04b-49cd-452e-8b71-0cde423c876d`, 2026-09-26: of six jobs, two
fired — at 07:28:58 and 08:23:33 CEST, each 2 s after an unrelated `routing:` line — and one slot had
no journal entry at all. Four never fired. The group noticed before we did: _"phải gọi thì mày mới
trả lời chứ ko tự chạy cronjob"_.

Meanwhile AgentConnect's own cron subsystem is exactly right for this: the CP owns the definition, the
daemon owns firing and last-run (`scheduler.ts`, `daemon-cp-ws-protocol.md` §5.4), the fire is
session-independent, and `missedOccurrence` replays a missed occurrence on duty handover. It has one
gap for this use case: **only an operator can create one.**

## Goal

A session tool that lets an agent schedule _itself_, with the definition owned by the CP so the
console sees, edits, and deletes it like any other cron.

Success: on a Telegram session, the agent calls one tool, the greeting lands in that same conversation
at the stated local time, it keeps landing when nobody is talking to the bot, and the console's
Crons view lists it as a first-class row.

## Non-goals

- **Not a general scheduler.** No channel argument, no cross-conversation targeting, no
  agent-to-agent fire. See §3.
- **Not the admin catalog.** Do not widen the CP's MCP entitlement to IM surfaces; §2 says why.
- **No change to `scheduleMessage`.** Slack keeps the platform-native post; this is a different
  feature (a wake, not a post) and the two coexist.
- **No change to cron firing, catch-up, duty, or the reaper.** This adds a write path to the
  existing subsystem and nothing else.
- **No local-only crons.** A tool that writes `agent.json` `crons[]` without a CP row is the cheap
  design and it is rejected in §2.

## Design

### 1. The seam, and why it is a frame rather than a REST call

The CP-side pieces already exist and are correct:

| Piece                                                                               | Where                                                                  |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `listCrons` / `getCron` / `listCronRuns` / `upsertCron` / `runCron` / `deleteCron`  | `packages/control-plane/src/http/mcp/tools.ts:489,495,501,869,904,911` |
| `PUT /crons/:id` — validation, agent-visibility fence, integration ownership, audit | `packages/control-plane/src/http/routes/crons.ts:96-232`               |
| `cron/upsert` push to the owning daemon                                             | `orchestrator/agentDelivery.ts:163`                                    |
| `cron/report` (D→C, fire telemetry)                                                 | `ws/handlers/cron-report.ts`                                           |

What is missing is a way for a **daemon** to ask the CP to create one. The daemon cannot call the REST
surface: it holds no CP REST credential, and giving it one is a new credential-distribution surface
for a feature that needs one call.

The WS already carries daemon-initiated correlated requests — `gitcred/request`, `linearcred/request`,
`hook/start` — and the org fence for them is settled (`frameOrgId`, `frame-org.ts:15`; authority via
`PlacementResolver.mayAct`, `placementResolver.ts:94`). So this is one new REQ/REP pair on a wire that
already exists.

```ts
// packages/protocol/src/frame.ts — in the `── cron ──` block beside the existing four
'cron/author': CronAuthor,          // D→C REQ
'cron/author/ok': CronAuthorOk,     // C→D REP
```

Naming: `cron/upsert` already exists and is **C→D**. Reusing the name for the other direction would
be the kind of ambiguity `FRAME_SCHEMAS` is supposed to make impossible, so the D→C request is
`cron/author` — "the agent authored this" — and it is distinguishable from an operator write for
reasons §5 and §6 both need.

`INSTALL_WIDE_FRAME_TYPES` (`frame-scope.ts:7`) is **not** touched: the payload names an agentId, so
`scopedFrame` resolves the org from it (`client.ts:1420`) and an install-wide connection must name one
— which the existing gate then requires (`checkInboundFrameOrg`, `frame-scope.ts:68`).

### 2. Why not the two cheaper designs

**Why not widen the CP MCP catalog to IM sessions.** The catalog is already complete and its
`upsertCron` would work as-is. It is gated deliberately: _"The webchat surface is the entitlement…
every other launch surface — Slack, Telegram, Discord, Lark, a code host — receives nothing"_
(`webchat-preset-agentconnect-mcp.md:16`). That gate is not about transport, it is about authority:
the catalog is admin-grade, `McpToolCtx.delegatedAgentId` exists only for a webchat assertion, and
opening it to a group agent hands that agent an organization's admin surface because someone asked it
to say good morning. Rejected.

**Why not a local-only cron tool.** The daemon already supports hand-authored crons — an entry in
`agent.json` `crons[]` with no `origin` is explicitly _"never touched by the CP"_
(`agent-schema.ts:90-115`, `write-cron.ts:1-14`), survives restart, and arms the same `Scheduler`. It
would be perhaps 40 lines and no protocol change.

Rejected because the resulting cron is **invisible in the console**: `CronsView` and every cron route
read the CP's `cron_def` table, so a local entry is a schedule the operator can neither see nor
cancel, discoverable only by reading `agent.json` on the host. That is the same class of objection
that retired the model-pin proposal — AgentConnect must not create decisions the operator cannot see
or control. It also collides: `write-agent.ts:609-652` filters `origin:'cp'` entries against the
pushed set and **throws on a local id collision** (`cannot activate agent …: local cron collisions:
…`), so this path would grow a failure mode in the activation barrier.

### 3. Least privilege: the target is the current conversation, by construction

The tool takes **no channel, thread, or integration argument**. It targets `ctx.channel` /
`ctx.thread` / `ctx.integrationId` — the session the call ran in.

This follows `shareFile`'s precedent (`agent-authored-attachments.md:53`: _"No coordinates, by
construction. The daemon posts into the session's own conversation; the model names no destination,
so no new authorization question exists"_), and it is what makes this design small: there is no
"which conversations may this agent post into" question, because the answer is the one it is
already talking in. A cron that fires into a conversation the agent is _not_ in would be the
feature that needs an authorization story, and no cited demand asks for it.

Consequences worth stating:

- The stored target platform is derived from the integration, exactly as the route does today
  (`crons.ts:149`), so the Telegram case stores `telegram`.
- `ctx.integrationId` is absent on a session with no integration (a memory dream, a webchat turn).
  An absent integration means the cron cannot fire into a conversation: the tool **refuses** rather
  than creating a headless cron, because a silently headless cron is a schedule the agent believes
  posts and never does.

### 4. The CRON body, and the timezone rule

The agent states the schedule; the CP validates it exactly as the route does (`cronerSchedule`).

**`timezone` is required, not defaulted.** The route's own comment records why the omission default
is a bug surface (_"an omission put a schedule on a clock nobody chose, and an edit that omitted it
moved an existing schedule off the one it was authored on"_, `crons.ts:186`). An agent has a
person to ask — it is in a conversation, and in the motivating case the group had already said
"GMT+7". So the tool requires an IANA zone and the descriptor tells the agent to ask when it does not
know. No silent UTC.

```jsonc
// the agent-facing arguments
{
  "schedule": "30 6 * * *", // croner 5-field
  "timezone": "Asia/Ho_Chi_Minh", // required — never defaulted
  "prompt": "Chúc mọi người ăn trưa ngon miệng (tiếng Việt, vui vẻ).",
  "name": "greeting-lunch" // optional; console label only
}
```

`enabled` is not an argument — an authored cron is enabled. Disabling is an operator action, and the
console already owns it.

### 5. The CP handler

`ws/handlers/cron-author.ts`, registered in the `FrameRouter` table (`handlers/index.ts:77-99`, beside
`'cron/report'`), mirroring `handleHookStart`'s shape:

1. `isFrame('cron/author')` decode guard; drop silently otherwise — the house style for a report whose
   shape it does not recognise.
2. `frameOrgId(frame, conn)`; drop when null.
3. **Authority fence**: the frame's `agentId` must be an agent in that org, and
   `deps.placementResolver.mayAct(agent, conn.daemonId)` must hold. This is the same fence
   `handleCronReport` applies (`cron-report.ts:26,34`) and it is what stops a daemon authoring a cron
   for an agent it does not serve.
4. Validate `schedule` with croner; on a bad expression reply `error` with `BAD_PAYLOAD` carrying the
   croner message, so the agent can correct itself in the same turn.
5. Upsert the row through the same repository call the route uses, with **`createdBy` left absent**
   so the console reads a non-human creator (`isSyntheticEmail` → `null` → "—", `crons.ts:55-57`). The
   audit entry uses `frameType: 'cron/author'`, which is how an operator tells an agent-authored row
   from their own in the audit log.
6. `deps.recomputeDuties?.(orgId)` — an enabled cron is a duty edge, same as the route.
7. Push `cron/upsert` to the owning daemon via `agentDelivery.cronUpsert`
   (`orchestrator/agentDelivery.ts:163`), then reply `cron/author/ok` with the cron id and its
   resolved `nextRun`.

Ordering note: the row is written **before** the push and the reply, matching the route. A push that
fails is not a failed authoring — the daemon converges on its next `register`, which is the existing
`cronPushFailed` contract (`crons.ts:84-95`).

**Idempotency.** The agent mints no id; the CP mints one per call. This diverges from the route's
client-minted UUID on purpose: an agent retrying after a dropped reply would otherwise create a
second cron, so `cron/author` carries a `requestId` and the handler returns the existing row for a
repeat of the same id. That is the one piece of the handler that is not a copy of the route.

### 6. The daemon side

**Tool** — `scheduleCron` in `mcp/tools.ts`, built unconditionally (it is not a platform read port;
it works wherever the agent can be addressed). The descriptor must say what the harness tool does not:
the schedule survives the session, it fires with nobody watching, and it posts into this conversation.

**Op** — `deps.authorCron(...)` filled from the session context, following `startOrchestration`'s
split (`mcp/ops/orchestration.ts:96-114`, where `ctx.integrationId` is copied only when present at
`:107`): the trusted identity and coords come from `SessionContext`, never from tool input. Tool
input contributes only schedule / timezone / prompt / name.

**Client** — `client.ts`: one method beside `emitCronReport` (`client.ts:813`), shaped like
`requestGitCred` (`client.ts:978`) — connected-only, one send, correlated reply, `WireError` on an
unexpected `rep.type`. Not `maxTries: 1` by reflex; a create is not idempotent at the transport, so it
uses the `requestId` of §5 and the ordinary retry.

**Permission auto-allow** — `tools.ts:1285-1291` is the set the permission layer pre-approves. A new
injectable name belongs there or every call draws a prompt; the file already carries
`allPortPlatforms().flatMap(…)` / `allAttachmentReadTools()` / `allSessionToolDescriptors()` for
exactly this reason.

**Feature negotiation** — the tool is offered only when the CP advertises the capability, via
`supportsServerFeature` (`client.ts:1099`) against a new constant in `protocol/src/consts.ts`
(`AGENT_CRON_AUTHOR_FEATURE = 'agent-cron-author-v1'`). Without this, a fork daemon against an older
CP offers a tool whose frame is answered `UNKNOWN_FRAME`, and the agent reports a broken feature
instead of an absent one.

### 7. Console

No new view. The row appears in `CronsView` because it is an ordinary `cron_def` row. Two affordances:

- The creator column already renders "—" for a non-human creator (`crons.ts:55-57`); leave it.
- The audit entry's `frameType: 'cron/author'` is the distinguishing signal. If the Crons row should
  say "agent-authored" on its face, that is a one-line DTO addition and belongs in the plan, not
  this spec.

### 8. Product documentation

`docs/product-conventions.md` gains the tool in the session-tool list. The distinction that must be
written down: **`scheduleMessage` is a post the platform delivers; `scheduleCron` is a wake the daemon
delivers.** A reader who conflates them will ask why Telegram has one and not the other — the answer
is that Telegram's API has no scheduled-post primitive, while a cron needs nothing from the platform.

## Work items

1. **protocol** — `CronAuthor` / `CronAuthorOk` schemas, two `FRAME_SCHEMAS` entries, the
   `AGENT_CRON_AUTHOR_FEATURE` const. Round-trip test beside the existing `cron/*` cases.
2. **cp** — `handleCronAuthor`, registered; `requestId` idempotency; unit test for the fence
   (wrong daemon → no row), the org drop, and the bad-schedule reply.
3. **cp** — integration test through `buildApp`: author → row exists with a null creator → a
   `cron/upsert` frame reached the daemon stub → `cron/author/ok` carried the id.
4. **daemon** — `client.createCronForAgent`, the `authorCron` op, the `scheduleCron` descriptor,
   the auto-allow entry, the feature gate.
5. **daemon** — `authorCron` op test: context supplies identity/coords; a call with a `channel`
   argument is rejected by the strict schema.
6. **daemon** — e2e: `scheduleCron` on a fake platform session produces a `cron/author` frame whose
   payload targets that session's channel and carries no channel argument from the model.
7. **docs** — the product-conventions entry (§8).

## Testing

The load-bearing assertions are the two that would be silent if wrong:

- **The target is the session's, not the model's.** A tool call cannot name a channel — assert the
  schema rejects one, and assert the frame carries `ctx.channel`.
- **The fence holds.** A daemon that does not serve the agent authoring the cron gets no row.

Plus the ordinary gates: `pnpm typecheck`, `pnpm lint`, the two CP suites (`test:unit`, `test:int`),
and the daemon suite. Windows: the daemon package's unit suite runs on `windows-latest`, and nothing
here is POSIX-specific, so no `it.skipIf` should be needed.

## Risks and limitations

- **An agent can now wake itself on a schedule.** Bounded by §3 (its own conversation only) and §5
  (it must serve the agent), but an agent in a loop could author many crons. The console is the
  remedy and the audit entry names the origin; a per-agent cap is deliberately _not_ in this design —
  no cited demand, and a cap is a number that would be guessed wrong.
- **`requestId` idempotency is per-connection state.** A CP restart between the write and the reply
  loses the mapping, and the retry creates a second cron. Acceptable: it is one duplicate row an
  operator can see and delete, versus the alternative of a durable idempotency table for a feature
  that is not high-volume. Marked here so it is a decision, not an oversight.
- **The harness cron does not go away.** An agent that has learned `CronCreate` may still use it.
  This design makes the right path _available_; it does not remove the wrong one. Removing it means
  a runtime-side setting, which is out of scope.
- **`crons.ts:149` derives `targetPlatform` from the integration.** If the agent's integration is
  removed later, the stored cron targets a platform with no connection. The existing cron path
  already has this shape for operator crons; not newly introduced here.

## Upstream divergence

Upstream has the full CP-side cron subsystem and the admin MCP catalog, but no agent-facing cron tool
and no D→C authoring frame. If upstream adds one, reconcile rather than carry: this design's shape is
deliberately the narrowest thing that satisfies the use case (self-scoped target, required timezone,
one frame), and a wider upstream tool would supersede it.
