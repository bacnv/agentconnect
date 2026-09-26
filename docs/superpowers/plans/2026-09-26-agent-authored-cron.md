# An agent-authored cron — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an agent a `scheduleCron` tool that creates a real AgentConnect cron — owned by the CP, fired by the daemon, visible and cancellable in the console — targeting the conversation the tool was called in and nothing else.

**Architecture:** One new correlated REQ/REP pair on the existing daemon↔CP WebSocket, `cron/author` → `cron/author/ok`, deliberately not named `cron/upsert` (that frame is C→D, and one name for two directions is the ambiguity `FRAME_SCHEMAS` exists to prevent). The CP handler restates the `PUT /crons/:id` write path — validate, fence, upsert, recompute duties, audit, push `cron/upsert` back down — and adds exactly one thing the route does not need: an idempotency key, because an agent that retries a dropped reply must not author two crons. The daemon side is a tool whose only input is schedule/timezone/prompt/name: every coordinate comes from `SessionContext`, so there is no "which conversations may this agent post into" question to answer. The tool is offered only when the CP advertises `agent-cron-author-v1` on `register/ok`, so a fork daemon against an older CP reports an absent feature rather than a broken one.

**Tech Stack:** TypeScript, pnpm 11 workspaces, zod 4, croner 10, Prisma 6 + Postgres, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-26-agent-authored-cron-design.md` — read it before Task 1. This plan implements it; where the two disagree on a line number, this plan was written against the branch and wins.

**Base:** branch `feat/agent-cron-tool`, cut from tag `v1.16.0-bacnv` (`a6cf5eda`). Every line number below is a `v1.16.0-bacnv` line number.

## Global Constraints

- **The tool takes no coordinates.** No `channel`, no `thread`, no `integrationId`, no `platform` argument — ever. The target is `ctx.channel` / `ctx.thread` / `ctx.integrationId` from the trusted `SessionContext`. This is the whole authorization story: the model cannot name a destination, so no new "may this agent post there" question exists. A stray key is refused by name, not ignored.
- **`timezone` is required and never defaulted.** The route's own comment records why (`crons.ts:184-186`): an omission put a schedule on a clock nobody chose. The agent has a person to ask.
- **`scheduleCron` is not `scheduleMessage`.** `scheduleMessage` hands the platform a message to post later; `scheduleCron` makes the daemon wake the agent, which can then decide what to say. The descriptors and the docs must keep those two sentences apart.
- **`createdBy` stays absent.** The CP writes no `createdByUserId`/`lastModifiedByUserId` for an authored cron, so the console renders "—" (`isSyntheticEmail` → null, `crons.ts:55-57`). The distinguishing signal is the audit row's `frameType: 'cron/author'`.
- **One croner instance per validation, always `paused: true`, always stopped.** A paused instance schedules no timer (verified: 50 paused instances leave 0 active `Timeout` handles). Call `.nextRun()` BEFORE `.stop()` — after `stop()` it returns `null` for every expression.
- **The constructor validates the EXPRESSION; only `nextRun()` validates the ZONE.** `new Cron('30 6 * * *', { timezone: 'Not/AZone', paused: true })` does not throw. Both checks are needed, and `nextRun()` is also where the reply's value comes from.
- **`nextRun()` returning `null` is a refusal, not a reply.** `0 0 30 2 *` never fires; a cron that never fires is a bug the agent should hear about in the same turn.
- **Comments are one line.** The repo's `CLAUDE.md` is explicit: do not write multiline comment blocks; when you touch code carrying a verbose comment, condense it to one line. Every comment shown below is already condensed — keep it that way.
- **Prettier:** no semicolons, single quotes, no trailing commas, 120 columns.
- **`FRAME_SCHEMAS` payloads are plain `z.object`, so the CP STRIPS an unknown key rather than rejecting it.** Verified against zod 4.6.5: `z.object({ a: z.string() }).safeParse({ a: 'x', b: 1 })` succeeds with `{ a: 'x' }`. The daemon-side guarantee therefore rests on the tool's own `z.strictObject` argument schema — that is where "the model cannot name a channel" is enforced, and that is what Task 5 tests.
- **Never run `docker compose down --volumes`.**
- **Commit identity:** this clone has no `user.*` git config. Pass it per command: `git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit …`. Never write to git config.

## Review Focus

Five input classes and failure modes the spec implies but no task's own tests would otherwise exercise. Each one's test is added to the task that owns the code.

1. **A cron must never be authored into a conversation the model chose.** The tool has no channel argument at all, and the frame's `target` comes from `SessionContext`. If the strict schema is loosened to `z.object`, an extra `channel` key is silently stripped and the guarantee becomes invisible rather than enforced. → Task 5, "refuses a channel argument by name" and "fills every coordinate from the session, never from the model".
2. **A daemon that does not serve the agent must write nothing.** `mayAct` is the same fence `handleCronReport` applies; without it any registered daemon could author a cron for any agent in the org, and an enabled cron is a duty edge. → Task 2, "a daemon that does not serve the agent writes no row".
3. **A retried REQ must be the same cron, not a second one.** The correlator re-sends the same bytes on timeout, so any dropped reply produces a retry. If the CP mints a fresh id per arrival, one call makes two crons; if it ignores `requestId`, an agent that legitimately wants two crons at different hours cannot get them. → Task 2, "a repeated requestId answers the same cron and writes nothing the second time".
4. **The timezone must be a named zone, and it must be the agent's.** `Intl` accepts `+07:00` as a time zone; a fixed offset is not a zone and must be refused. And an omitted or empty `timezone` must fail rather than fall back to UTC. → Task 2, "refuses a fixed-offset timezone" and "requires a timezone".
5. **The feature gate is what keeps a fork daemon from calling an old CP.** `cron/author` is frame-fatal to a CP that does not know it, so the tool must not be advertised before `register/ok` names `agent-cron-author-v1`. → Task 6, "advertises scheduleCron only when the CP serves it".

---

## File Structure

**Modified — wire contract:**

- `packages/protocol/src/frames/cron.ts` — `CronAuthor`, `CronAuthorOk`.
- `packages/protocol/src/frames/cron.test.ts` — the round-trip and required-field cases.
- `packages/protocol/src/frame.ts:32,284-288,593-596` — the import, the `── cron ──` block, the discriminated union.
- `packages/protocol/src/consts.ts` — `AGENT_CRON_AUTHOR_FEATURE`.

**Modified / created — control plane:**

- `packages/control-plane/src/ws/deps.ts` — `audit`, `agentDelivery`, `recomputeDuties`.
- `packages/control-plane/src/ws/handlers/cron-author.ts` — new: the handler, the derived id, the schedule validator.
- `packages/control-plane/src/ws/handlers/cron-author.test.ts` — new: the fence, the idempotency, the refusals.
- `packages/control-plane/src/ws/handlers/index.ts` — the import, the table entry, the re-export.
- `packages/control-plane/src/ws/handlers/register.ts:82-145` — advertise the feature.
- `packages/control-plane/src/container.ts:2191-2274` — wire the three new deps.
- `packages/control-plane/test/fakes/build-ws.ts:172-195,356-403` — `audit` + a hoisted `agentDelivery`.
- `packages/control-plane/test/protocol/cron-author.handler.test.ts` — new: end to end over a real connection.

**Modified / created — daemon:**

- `packages/daemon/src/cp/client.ts` — `authorCron`.
- `packages/daemon/test/cp/client-cron-author.test.ts` — new.
- `packages/daemon/src/mcp/ops/cron.ts` — new: `SCHEDULE_CRON_ARGS`, `CronAuthorDeps`, `scheduleCron`.
- `packages/daemon/src/mcp/ops/args.ts` — export the strict-key error map.
- `packages/daemon/src/mcp/ops/memory.ts:116-125` — import it instead of declaring its own.
- `packages/daemon/src/mcp/ops.ts` — `OpsDeps`, `HANDLERS`, `TOOL_ARG_SCHEMAS`.
- `packages/daemon/src/mcp/tools.ts` — `buildScheduleCronTool`, the `cronAuthor` option, `ALL_TOOL_NAMES`.
- `packages/daemon/src/daemon.ts:3011,3333-3336` — the `authorCron` dep and the feature gate.
- `packages/daemon/test/mcp-schedule-cron.test.ts` — new.
- `packages/daemon/test/mcp-tool-args.test.ts:36-45` — advertise the new tool.

**Modified — docs:** `docs/product-conventions.md`.

---

### Task 1: The `cron/author` frame pair on the wire

The two frames and the feature constant are one vertical slice: a frame with no consumer is inert, but a consumer with no frame does not compile, and the constant is what the daemon's gate reads. They land together with their round-trip test because the pair's shape — `requestId` in, `cronId` + `nextRun` out — is the contract Tasks 2, 4, 5 all quote.

**Files:**

- Modify: `packages/protocol/src/frames/cron.ts` (append after line 88)
- Modify: `packages/protocol/src/frames/cron.test.ts` (append)
- Modify: `packages/protocol/src/frame.ts:32`, `:284-288`, `:593-596`
- Modify: `packages/protocol/src/consts.ts` (append after line 406)

**Interfaces:**

- Consumes: nothing.
- Produces: the zod schemas and inferred types `CronAuthor` / `CronAuthorOk`, the `FRAME_SCHEMAS` entries `'cron/author'` / `'cron/author/ok'`, and the string constant `AGENT_CRON_AUTHOR_FEATURE = 'agent-cron-author-v1'`.

- [ ] **Step 1: Write the failing test**

Append to `packages/protocol/src/frames/cron.test.ts`. The existing file imports only `CronUpsert`; widen that import and add a second `describe`:

```ts
import { CronAuthor, CronAuthorOk, CronUpsert } from './cron.js'

const wireAuthor = {
  requestId: '33333333-3333-4333-8333-333333333333',
  agentId: '22222222-2222-4222-8222-222222222222',
  schedule: '30 6 * * *',
  timezone: 'Asia/Ho_Chi_Minh',
  trigger: 'chúc cả nhà buổi sáng',
  target: { platform: 'telegram', channel: '-1001234567890', integrationId: '44444444-4444-4444-8444-444444444444' }
}

describe('CronAuthor', () => {
  it('carries the target the daemon resolved, and requires one', () => {
    expect(CronAuthor.parse(wireAuthor).target.channel).toBe('-1001234567890')

    const { target: _, ...headless } = wireAuthor
    // Absent (not merely empty) is the refusal: an authored cron always posts somewhere.
    expect(CronAuthor.safeParse(headless).success).toBe(false)
  })

  it('requires a timezone rather than defaulting one', () => {
    const { timezone: _, ...missingTimezone } = wireAuthor
    expect(CronAuthor.safeParse(missingTimezone).success).toBe(false)
    expect(CronAuthor.parse(wireAuthor).timezone).toBe('Asia/Ho_Chi_Minh')
  })
})

describe('CronAuthorOk', () => {
  it('answers with the id the CP minted and the resolved next fire time', () => {
    const ok = {
      cronId: '55555555-5555-4555-8555-555555555555',
      schedule: '30 6 * * *',
      timezone: 'Asia/Ho_Chi_Minh',
      nextRun: '2026-09-27T23:30:00.000Z'
    }
    expect(CronAuthorOk.parse(ok)).toEqual(ok)
    expect(CronAuthorOk.safeParse({ ...ok, nextRun: null }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentconnect.md/protocol test`

Expected: FAIL — `CronAuthor` and `CronAuthorOk` are not exported from `./cron.js`, so the import does not resolve.

- [ ] **Step 3: Define the frames**

Append to `packages/protocol/src/frames/cron.ts`:

```ts
/**
 * `cron/author` (D→C REQ → `cron/author/ok`) — an agent schedules ITSELF, through the
 * conversation it is answering (docs/superpowers/specs/2026-09-26-agent-authored-cron-design.md).
 * Named apart from `cron/upsert` on purpose: that frame is C→D, and one name for two
 * directions is exactly the ambiguity `FRAME_SCHEMAS` exists to prevent.
 *
 * `target` is REQUIRED and is filled by the daemon from the trusted session context — never
 * from tool input. `timezone` is required and never defaulted: an omission would put a
 * schedule on a clock nobody chose (see `http/routes/crons.ts`).
 */
export const CronAuthor = z.object({
  // Idempotency: the CP derives the cron id from (orgId, agentId, requestId), so a REQ the
  // correlator re-sent after a dropped reply answers the SAME cron instead of minting a second.
  requestId: z.string().uuid(),
  agentId: z.string().uuid(), // the authoring agent — routes the def to its daemon and fences the write
  name: z.string().min(1).max(120).optional(), // console label only; never on the fire path
  schedule: z.string().min(1), // croner expression interpreted in `timezone`
  timezone: z.string().min(1), // resolved IANA zone — a fixed offset is refused by the CP
  trigger: z.string().min(1), // the synthetic prompt the fire injects
  target: CronTarget // always present: an authored cron posts into the conversation it was authored in
})
export type CronAuthor = z.infer<typeof CronAuthor>

/** `nextRun` is the value the CP resolved while validating — the agent can tell the person when it will fire. */
export const CronAuthorOk = z.object({
  cronId: z.string().uuid(),
  schedule: z.string(),
  timezone: z.string(),
  nextRun: z.string().datetime()
})
export type CronAuthorOk = z.infer<typeof CronAuthorOk>
```

- [ ] **Step 4: Register the frames**

In `packages/protocol/src/frame.ts`, widen the import at line 32:

```ts
import { CronUpsert, CronRemove, CronReport, CronRunNow, CronAuthor, CronAuthorOk } from './frames/cron.js'
```

In the `── cron ──` block at lines 284-288, add the pair after `'cron/run'`:

```ts
  'cron/author': CronAuthor,
  'cron/author/ok': CronAuthorOk,
```

In the `AnyFrame` discriminated union at lines 593-596, add after the `cron/run` entry:

```ts
  frame('cron/author', FRAME_SCHEMAS['cron/author']),
  frame('cron/author/ok', FRAME_SCHEMAS['cron/author/ok']),
```

- [ ] **Step 5: Add the feature constant**

Append to `packages/protocol/src/consts.ts`:

```ts
/** CP decodes a daemon-authored `cron/author` REQ and pushes the resulting def back down as
 *  `cron/upsert`. A daemon must not send that REQ before seeing this: a new request type is
 *  frame-fatal to an older CP. */
export const AGENT_CRON_AUTHOR_FEATURE = 'agent-cron-author-v1'
```

- [ ] **Step 6: Run the test and typecheck the protocol package**

Run: `pnpm --filter @agentconnect.md/protocol test`

Expected: PASS.

Run: `pnpm --filter @agentconnect.md/protocol typecheck`

Expected: PASS. If `AnyFrame` reports a non-exhaustive union anywhere, a `switch` on `frame.type` has grown a default-less case — the protocol package has none, so a failure here means the union entry was added to the wrong block.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/frames/cron.ts packages/protocol/src/frames/cron.test.ts \
  packages/protocol/src/frame.ts packages/protocol/src/consts.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
feat(protocol): add the cron/author frame pair

One D→C REQ/REP for an agent that schedules itself: the daemon supplies the
target from the session it is answering, and the CP answers with the cron id
it minted and the schedule's resolved next fire time.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The CP handler, its three new deps, and the feature advertisement

The handler is a restatement of `PUT /crons/:id` plus idempotency, so it needs the three deps the route holds and the WS edge does not: the audit repo, the delivery fan-out, and the duty recompute kick. All three are required-or-optional exactly as the route treats them, and the handler is unreachable until `register/ok` names the feature.

The unit test comes first and is the whole review surface for Review Focus #2, #3 and #4.

**Files:**

- Modify: `packages/control-plane/src/ws/deps.ts` (imports at `:14-31`, `:45`; fields after `:141`)
- Create: `packages/control-plane/src/ws/handlers/cron-author.ts`
- Create: `packages/control-plane/src/ws/handlers/cron-author.test.ts`
- Modify: `packages/control-plane/src/ws/handlers/index.ts:37,93,152`
- Modify: `packages/control-plane/src/ws/handlers/register.ts:82-145`
- Modify: `packages/control-plane/src/container.ts:2191-2274`

**Interfaces:**

- Consumes: `CronAuthor` / `CronAuthorOk` and `AGENT_CRON_AUTHOR_FEATURE` from Task 1; the existing `CronRepo` (`get`, `upsert`), `AgentRepo`, `IntegrationRepo`, `PlacementResolver.mayAct`, `AuditRepo.append`, `AgentDelivery.cronUpsert`, `cronToUpsert`, `toDbPlatform`.
- Produces: `handleCronAuthor: Handler`, registered for `'cron/author'`; `DaemonWsDeps.audit`, `.agentDelivery` (required) and `.recomputeDuties` (optional).

- [ ] **Step 1: Write the failing test**

Create `packages/control-plane/src/ws/handlers/cron-author.test.ts`. This mirrors `hook-start.test.ts` — a fake connection, a partial deps object cast, no database — because the unit suite runs without Docker and the fence is pure logic over fakes.

```ts
/**
 * `cron/author` (D→C REQ) — the fence, the idempotency, and the refusals.
 *
 * The three that would be silent if wrong: a daemon that does not serve the agent writes
 * nothing; a retried REQ answers the same cron; a timezone that is a fixed offset, or
 * absent, is refused rather than defaulted.
 */
import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { handleCronAuthor } from './cron-author.js'
import { CronId } from '../../domain/ids.js'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const INTEGRATION = 'e1e1e1e1-eeee-4eee-8eee-eeeeeeeeeeee'
const ORG = 'org-a'

function fakeConn() {
  return {
    daemonId: DAEMON_ID,
    orgId: ORG,
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}

function authorFrame(payload: Record<string, unknown> = {}): AnyFrame {
  return {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'cron/author',
    orgId: ORG,
    payload: {
      requestId: randomUUID(),
      agentId: AGENT,
      schedule: '30 6 * * *',
      timezone: 'Asia/Ho_Chi_Minh',
      trigger: 'chào cả nhà',
      target: { platform: 'telegram', channel: '-100123', integrationId: INTEGRATION },
      ...payload
    }
  } as AnyFrame
}

function deps(over: Partial<Record<string, unknown>> = {}) {
  const rows = new Map<string, unknown>()
  return {
    rows,
    audit: { append: vi.fn(async () => ({}) as never), recent: vi.fn(async () => []) },
    cron: {
      get: vi.fn(async (_org: string, id: string) => (rows.get(id) as never) ?? null),
      upsert: vi.fn(async (input: { cronId: string }) => {
        const row = {
          id: input.cronId,
          orgId: ORG,
          agentId: AGENT,
          name: null,
          schedule: '30 6 * * *',
          timezone: 'Asia/Ho_Chi_Minh',
          targetPlatform: 'telegram',
          targetChannel: '-100123',
          targetIntegrationId: INTEGRATION,
          trigger: 'chào cả nhà',
          enabled: true
        }
        rows.set(input.cronId, row)
        return row as never
      })
    },
    agent: { get: vi.fn(async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON_ID }) as never) },
    integration: {
      get: vi.fn(async () => ({ id: INTEGRATION, orgId: ORG, agentId: AGENT, platform: 'telegram' }) as never)
    },
    placementResolver: { mayAct: vi.fn(async () => true) },
    agentDelivery: { cronUpsert: vi.fn(async () => undefined) },
    recomputeDuties: vi.fn(),
    log: { error: vi.fn() },
    ...over
  }
}

const asDeps = (d: ReturnType<typeof deps>) => d as unknown as DaemonWsDeps
```

Then the cases:

```ts
describe('handleCronAuthor', () => {
  it('authors the cron and answers with the id it minted and the next fire time', async () => {
    const d = deps()
    const conn = fakeConn()
    const frame = authorFrame()

    await handleCronAuthor(frame, conn, asDeps(d))

    const [type, payload] = conn.replyTo.mock.calls[0]!
    expect(type).toBe('cron/author/ok')
    expect(payload.cronId).toMatch(/^[0-9a-f-]{36}$/)
    // 06:30 in Ho Chi Minh is 23:30Z the day before.
    expect(payload.nextRun).toBe('2026-09-26T23:30:00.000Z')
    expect(d.agentDelivery.cronUpsert).toHaveBeenCalledTimes(1)
    expect(d.recomputeDuties).toHaveBeenCalledWith(ORG)
    expect(d.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cron_change', frameType: 'cron/author', agentId: AGENT })
    )
    // The creator is the agent, not a human: an absent id is what renders "—" in the console.
    const written = d.cron.upsert.mock.calls[0]![0]
    expect(written.createdByUserId).toBeUndefined()
    expect(written.lastModifiedByUserId).toBeUndefined()
  })

  it('a daemon that does not serve the agent writes no row', async () => {
    const d = deps({ placementResolver: { mayAct: vi.fn(async () => false) } })
    const conn = fakeConn()

    await handleCronAuthor(authorFrame(), conn, asDeps(d))

    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
    expect(d.cron.upsert).not.toHaveBeenCalled()
    expect(d.agentDelivery.cronUpsert).not.toHaveBeenCalled()
  })

  it('a repeated requestId answers the same cron and writes nothing the second time', async () => {
    const d = deps()
    const conn = fakeConn()
    const requestId = randomUUID()

    await handleCronAuthor(authorFrame({ requestId }), conn, asDeps(d))
    const first = conn.replyTo.mock.calls[0]![1].cronId
    await handleCronAuthor(authorFrame({ requestId }), conn, asDeps(d))

    expect(conn.replyTo.mock.calls[1]![1].cronId).toBe(first)
    expect(d.cron.upsert).toHaveBeenCalledTimes(1)
    expect(d.agentDelivery.cronUpsert).toHaveBeenCalledTimes(1)
  })

  it('refuses a fixed-offset timezone, a bad expression, and a schedule that never fires', async () => {
    const conn = fakeConn()
    for (const payload of [
      { timezone: '+07:00' },
      { schedule: 'not a cron' },
      { schedule: '0 0 30 2 *' } // February 30th — croner's nextRun() answers null
    ]) {
      const d = deps()
      await handleCronAuthor(authorFrame(payload), conn, asDeps(d))
      const [corr, code] = conn.sendError.mock.calls.at(-1)!
      expect(corr).toEqual(expect.any(String))
      expect(code).toBe('BAD_PAYLOAD')
      expect(d.cron.upsert).not.toHaveBeenCalled()
    }
  })

  it('drops an org-less frame rather than guessing one', async () => {
    const d = deps()
    const conn = fakeConn()
    const frame = { ...authorFrame(), orgId: undefined } as AnyFrame

    await handleCronAuthor(frame, { ...conn, orgId: undefined } as unknown as DaemonConnection, asDeps(d))

    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', 'organization is required', false)
  })

  it('refuses a target integration that is not this agent’s', async () => {
    const d = deps({
      integration: { get: vi.fn(async () => ({ id: INTEGRATION, orgId: ORG, agentId: 'other', platform: 'slack' })) }
    })
    const conn = fakeConn()

    await handleCronAuthor(authorFrame(), conn, asDeps(d))

    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'BAD_PAYLOAD', expect.any(String), false)
    expect(d.cron.upsert).not.toHaveBeenCalled()
  })
})
```

Note the two `expect.any(String)` positions: `replyTo` is called as `(frame, type, payload)` and `sendError` as `(corr, code, message, retryable)`, matching `hook-start.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentconnect.md/control-plane exec vitest run --project unit src/ws/handlers/cron-author.test.ts`

Expected: FAIL — `./cron-author.js` does not exist.

- [ ] **Step 3: Add the three deps**

In `packages/control-plane/src/ws/deps.ts`, widen the type import from `../persistence/ports.js` (lines 14-31) with `AuditRepo`, and add beside the other orchestrator imports (near line 45):

```ts
import type { AgentDelivery } from '../orchestrator/agentDelivery.js'
```

Add the three fields after the `cron: CronRepo` block at line 141:

```ts
  /** The operator-visible trail an agent-authored write leaves: the same `cron_change` row
   *  the PUT route appends, told apart by `frameType: 'cron/author'`. */
  audit: AuditRepo
  /** Pushes an authored def back down as `cron/upsert`, over placement ∪ live duty holders.
   *  The same fan-out every other replicate site uses. */
  agentDelivery: AgentDelivery
  /** An enabled cron is a duty edge (design §4.7), so authoring one changes the group's
   *  claimability — the route kicks the same sweep. */
  recomputeDuties?: (orgId: string) => void
```

- [ ] **Step 4: Write the handler**

Create `packages/control-plane/src/ws/handlers/cron-author.ts`:

```ts
/**
 * `cron/author` (D→C REQ → `cron/author/ok`) — an agent schedules itself.
 *
 * The same write path as `PUT /crons/:id`: validate, fence, upsert, recompute duties,
 * audit, push `cron/upsert` down. Two things differ. The cron id is DERIVED from the
 * frame's `requestId`, because the correlator re-sends a REQ whose reply was dropped and
 * a retried authoring must answer the same cron instead of minting a second. And no
 * creator is stamped — an agent-authored row has no human behind it, which the console
 * already renders as "—".
 */
import { createHash } from 'node:crypto'
import { Cron } from 'croner'
import { isFrame, isSessionIdentityPlatform } from '@agentconnect.md/protocol'
import { AgentId, CronId, DaemonId, IntegrationId } from '../../domain/ids.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { cronToUpsert } from '../../orchestrator/placement.js'
import { toDbPlatform } from '../../persistence/platform.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

/** A schedule the agent can repair in the same turn: the reply carries the reason. */
class BadSchedule extends Error {}

/** ECMA-402 also accepts fixed-offset ids such as "+07:00", which are not zones. */
function isIanaTimezone(timezone: string): boolean {
  try {
    const canonical = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone
    return !canonical.startsWith('+') && !canonical.startsWith('-')
  } catch {
    return false
  }
}

/** Validate the expression AND resolve the next fire time. The zone check is only here:
 *  croner's constructor validates the expression alone, and a never-firing expression
 *  answers `null` — which is a refusal, not a schedule. */
function resolveNextRun(schedule: string, timezone: string): Date {
  if (!isIanaTimezone(timezone)) {
    throw new BadSchedule('timezone must be a named IANA zone, e.g. Asia/Ho_Chi_Minh — not a fixed offset')
  }
  let job: Cron
  try {
    job = new Cron(schedule, { timezone, paused: true })
  } catch {
    throw new BadSchedule('schedule must be a cron expression with five fields, e.g. "30 6 * * *"')
  }
  let next: Date | null
  try {
    next = job.nextRun()
  } finally {
    job.stop()
  }
  if (!next) throw new BadSchedule('that schedule never fires — pick one that occurs')
  return next
}

/** The cron id one authoring call maps to. Derived rather than minted per arrival so a
 *  retried REQ is the same cron, and per-`requestId` so a fresh call is a new one. */
function authorCronId(orgId: string, agentId: string, requestId: string): string {
  const h = createHash('sha256').update(`${orgId}:${agentId}:${requestId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(12, 15)}-8${h.slice(15, 18)}-${h.slice(18, 30)}`
}

export const handleCronAuthor: Handler = async (frame, conn, deps) => {
  if (!isFrame('cron/author')(frame)) return
  try {
    await author(frame, conn, deps)
  } catch (error) {
    if (error instanceof BadSchedule) {
      conn.sendError(frame.id, 'BAD_PAYLOAD', error.message, false)
      return
    }
    deps.log.error({ daemonId: conn.daemonId, agentId: frame.payload.agentId }, `cron/author failed: ${String(error)}`)
    conn.sendError(frame.id, 'INTERNAL', 'cron authoring failed', true)
  }
}

const author: Handler = async (frame, conn, deps) => {
  if (!isFrame('cron/author')(frame)) return
  const p = frame.payload
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  // The live seam: a daemon may author only for an agent it actually serves.
  const agent = await deps.agent.get(orgId, AgentId(p.agentId))
  if (!agent) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'unknown agent', false)
    return
  }
  const resolver = deps.placementResolver ?? PLACEMENT_ONLY
  if (!(await resolver.mayAct(agent, DaemonId(conn.daemonId)))) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
    return
  }
  // The target must ride one of THIS agent's integrations — the route's ownership check.
  const integration = p.target.integrationId
    ? await deps.integration.get(orgId, IntegrationId(p.target.integrationId))
    : null
  if (!integration || integration.agentId !== agent.id) {
    conn.sendError(frame.id, 'BAD_PAYLOAD', 'target integration is not an integration of this agent', false)
    return
  }
  if (isSessionIdentityPlatform(p.target.platform)) {
    conn.sendError(frame.id, 'BAD_PAYLOAD', 'this session has no IM conversation to fire into', false)
    return
  }
  const nextRun = resolveNextRun(p.schedule, p.timezone)
  const cronId = CronId(authorCronId(orgId, agent.id, p.requestId))

  const existing = await deps.cron.get(orgId, cronId)
  if (existing) {
    // A re-sent REQ, not a second request: answer from the STORED row, so a retry that
    // carries a different body cannot quietly rewrite what the first call authored.
    conn.replyTo(frame, 'cron/author/ok', {
      cronId: existing.id,
      schedule: existing.schedule,
      timezone: existing.timezone,
      nextRun: resolveNextRun(existing.schedule, existing.timezone).toISOString()
    })
    return
  }

  const cron = await deps.cron.upsert({
    cronId,
    orgId,
    agentId: agent.id,
    ...(p.name ? { name: p.name } : {}),
    schedule: p.schedule,
    timezone: p.timezone,
    targetPlatform: toDbPlatform(integration.platform),
    targetChannel: p.target.channel,
    targetIntegrationId: integration.id,
    trigger: p.trigger,
    enabled: true
  })
  deps.recomputeDuties?.(orgId)
  void deps.audit
    .append({
      kind: 'cron_change',
      orgId,
      agentId: agent.id,
      frameType: 'cron/author',
      message: `cron ${cron.id} authored by agent ${agent.id}`,
      details: {
        cronId: cron.id,
        schedule: cron.schedule,
        timezone: cron.timezone,
        targetChannel: cron.targetChannel,
        enabled: cron.enabled
      }
    })
    .catch(() => {})
  // The row is durable before the push, matching the route: a daemon that is offline
  // converges on its next register, so a failed push is not a failed authoring.
  const wire = cronToUpsert(cron)
  if (wire) {
    await deps.agentDelivery.cronUpsert(agent, wire, (err, target) => {
      if (err instanceof NoConnection) return
      deps.log.error({ daemonId: target, cronId: cron.id }, `cron/upsert push failed: ${String(err)}`)
    })
  }
  conn.replyTo(frame, 'cron/author/ok', {
    cronId: cron.id,
    schedule: cron.schedule,
    timezone: cron.timezone,
    nextRun: nextRun.toISOString()
  })
}
```

- [ ] **Step 5: Register the handler**

In `packages/control-plane/src/ws/handlers/index.ts`, add the import beside `handleCronReport` at line 37:

```ts
import { handleCronAuthor } from './cron-author.js'
```

Add the table entry after `'cron/report': handleCronReport,` at line 93:

```ts
      'cron/author': handleCronAuthor,
```

Add it to the re-export block after `handleCronReport,` at line 152:

```ts
  handleCronAuthor,
```

- [ ] **Step 6: Advertise the feature**

In `packages/control-plane/src/ws/handlers/register.ts`, import the constant from protocol and add it to `serverFeatures` after `MEMORY_CAPTURE_FENCE_V1_FEATURE`:

```ts
// An agent can author its own cron through the daemon (`cron/author`). A daemon must not
// send that REQ before seeing this: a new request type is frame-fatal to an older CP.
AGENT_CRON_AUTHOR_FEATURE
```

- [ ] **Step 7: Wire the deps in the container**

In `packages/control-plane/src/container.ts`, inside the `wsDeps` literal, add after `cron: repos.cron,`:

```ts
    audit: repos.audit,
    agentDelivery,
```

`recomputeDuties` is optional on the WS edge; add it beside them so the duty edge an authored cron creates is felt immediately rather than at the next rotation:

```ts
    recomputeDuties: (orgId: string) => dutyRecompute.kick(orgId),
```

`audit`, `agentDelivery` and `dutyRecompute` are all already constructed above this literal (lines 492, 838, 877); no new construction is needed.

- [ ] **Step 8: Run the test and typecheck**

Run: `pnpm --filter @agentconnect.md/control-plane exec vitest run --project unit src/ws/handlers/cron-author.test.ts`

Expected: PASS.

Run: `pnpm --filter @agentconnect.md/control-plane typecheck`

Expected: FAIL, listing every typed `DaemonWsDeps` literal that is now missing `audit` and `agentDelivery`. That is Task 3's work for `test/fakes/build-ws.ts`; the other two sites are `test/protocol/drain.test.ts:128` and `test/protocol/fencing.test.ts:34`, which build their literals field by field and need the same two lines:

```ts
    audit: {} as DaemonWsDeps['audit'],
    agentDelivery: {} as DaemonWsDeps['agentDelivery'],
```

Add them there and re-run. Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/control-plane/src/ws/deps.ts packages/control-plane/src/ws/handlers/cron-author.ts \
  packages/control-plane/src/ws/handlers/cron-author.test.ts packages/control-plane/src/ws/handlers/index.ts \
  packages/control-plane/src/ws/handlers/register.ts packages/control-plane/src/container.ts \
  packages/control-plane/test/protocol/drain.test.ts packages/control-plane/test/protocol/fencing.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
feat(cp): author a cron over the daemon wire

The route's write path behind a frame: same validation, same fence, same
audit, plus an idempotency key so a retried request answers the cron it
already made instead of a second one.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The CP integration test, over a real connection and a real database

The unit test proves the handler's logic against fakes. This one proves the frames and the row against Testcontainers Postgres and a real `DaemonConnection`, which is the only level that would catch a `FRAME_SCHEMAS` mismatch, an org-fence rejection, or an audit row the handler thinks it wrote.

**Files:**

- Modify: `packages/control-plane/test/fakes/build-ws.ts:172-195`, `:356-403`
- Create: `packages/control-plane/test/protocol/cron-author.handler.test.ts`

**Interfaces:**

- Consumes: everything Task 2 produced, plus `seedDaemon` / `seedAgent` from `test/fixtures/seed.ts` and `InMemoryDaemonStub` from `test/fakes/daemon-stub.ts`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Give the harness the two deps**

In `packages/control-plane/test/fakes/build-ws.ts`, add `audit: new PgAuditRepo(prisma)` to the `repos` literal at lines 172-195 (import `PgAuditRepo` from `../../src/persistence/repositories/audit.repo.js`), then hoist the `AgentDelivery` currently constructed inline inside `integrationConverge` at line 383 into one `const` before the `deps` literal:

```ts
const agentDelivery = new AgentDelivery({ control: sender, specs, placement: placementResolver })
```

Use it in both places — `integrationConverge`'s `convergeIntegrationGating` call and the `deps` literal:

```ts
    audit: repos.audit,
    agentDelivery,
```

Leaving `recomputeDuties` out is deliberate: it is optional on the edge, and the unit test in Task 2 already asserts the call.

- [ ] **Step 2: Write the failing test**

Create `packages/control-plane/test/protocol/cron-author.handler.test.ts`. It follows `register.handler.test.ts`'s handshake idiom — auth, register, then the frame under test — because that is the only way to exercise the real router, the real org fence and the real codec.

```ts
/**
 * `cron/author` end to end: a daemon handshake, then an authored cron.
 *
 * What only this level can show: the frame survives `FRAME_SCHEMAS` in both directions,
 * the row is a real `cron_def` with no human creator, and the CP pushes the def back down
 * as `cron/upsert` — the frame the daemon's Scheduler arms from.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildWsHarness } from '../fakes/build-ws.js'

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const BOT = 'b1b1b1b1-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INTEGRATION = 'e1e1e1e1-eeee-4eee-8eee-eeeeeeeeeeee'

async function ready(h: ReturnType<typeof buildWsHarness>, token: string) {
  const { stub } = h.connect()
  const auth = randomUUID()
  stub.inject('auth', { serviceAccountToken: token, daemonId: DAEMON, agentVersion: '0.0.0' }, { id: auth })
  await stub.expectFrame('auth/ok')
  const reg = randomUUID()
  stub.inject(
    'register',
    { routingEpoch: '0', capabilities: { platforms: ['telegram'], runtimes: ['claude'], acp: true, features: [] } },
    { id: reg }
  )
  await stub.expectFrame('register/ok')
  return stub
}

describe('cron/author', () => {
  it('writes a cron_def with no human creator and pushes cron/upsert back down', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await prisma.bot.create({ data: { id: BOT, orgId: DEFAULT_ORG_ID, platform: 'telegram', name: 'greeter' } })
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
    const h = buildWsHarness(prisma)
    const stub = await ready(h, await h.mintToken(DAEMON))
    stub.sent.length = 0

    stub.inject(
      'cron/author',
      {
        requestId: randomUUID(),
        agentId: AGENT,
        name: 'greeting-lunch',
        schedule: '30 6 * * *',
        timezone: 'Asia/Ho_Chi_Minh',
        trigger: 'chúc mọi người ăn trưa ngon miệng',
        target: { platform: 'telegram', channel: '-1001234567890', integrationId: INTEGRATION }
      },
      { id: randomUUID(), orgId: DEFAULT_ORG_ID }
    )

    const ok = await stub.expectFrame('cron/author/ok')
    expect(ok.payload.nextRun).toBe('2026-09-26T23:30:00.000Z')

    const row = await prisma.cronDef.findUniqueOrThrow({ where: { id: ok.payload.cronId } })
    expect(row).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT,
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
    const pushed = stub.sent.find((f) => f.type === 'cron/upsert')
    expect(pushed?.payload).toMatchObject({ cronId: ok.payload.cronId, agentId: AGENT, timezone: 'Asia/Ho_Chi_Minh' })

    // The audit row is what tells this apart from an operator write.
    const audit = await prisma.auditEvent.findFirst({ where: { frameType: 'cron/author' } })
    expect(audit).toMatchObject({ kind: 'cron_change', orgId: DEFAULT_ORG_ID, agentId: AGENT })

    // A retry of the same REQ is the same cron, not a second row.
    stub.inject(
      'cron/author',
      {
        requestId: 'fixed-for-the-retry',
        agentId: AGENT,
        schedule: '30 6 * * *',
        timezone: 'Asia/Ho_Chi_Minh',
        trigger: 'chúc mọi người ăn trưa ngon miệng',
        target: { platform: 'telegram', channel: '-1001234567890', integrationId: INTEGRATION }
      },
      { id: randomUUID(), orgId: DEFAULT_ORG_ID }
    )
    const again = await stub.expectFrame('cron/author/ok')
    expect(await prisma.cronDef.count({ where: { agentId: AGENT } })).toBe(2)
    expect(again.payload.cronId).not.toBe(ok.payload.cronId)
  })
})
```

Two details the reader will otherwise trip on. The second call uses a _different_ `requestId`, which is the honest shape of "an agent that wants two crons" — the `count === 2` assertion is what proves the derived id is per-request and not per-agent. The idempotency half is already covered by Task 2's unit test, where no database is needed to see it. And `stub.sent` is cleared after the handshake so `register/ok`'s own cron snapshot cannot be mistaken for the push.

- [ ] **Step 3: Verify the stub's frame shapes**

`InMemoryDaemonStub.expectFrame` validates the captured frame through `AnyFrame.parse`, so a hand-built payload that drifts from `FRAME_SCHEMAS` fails here rather than in production. If `inject`/`expectFrame` signatures differ from the calls above, read `test/fakes/daemon-stub.ts` and adapt — `register.handler.test.ts` and `organization-suggestion-sync.handler.test.ts` are the working references.

- [ ] **Step 4: Run the test to verify it fails, then passes**

Run: `pnpm --filter @agentconnect.md/control-plane exec vitest run --project integration test/protocol/cron-author.handler.test.ts`

Expected first: FAIL — the handler or the harness deps are missing (impossible after Task 2, so a failure here means the harness edit in Step 1 was incomplete). After Step 1: PASS.

- [ ] **Step 5: Run the whole integration project**

Run: `pnpm --filter @agentconnect.md/control-plane exec vitest run --project integration`

Expected: PASS. Requires Docker. A failure in an unrelated file means the harness change widened something shared — most likely the hoisted `agentDelivery`, which `integrationConverge` now shares.

- [ ] **Step 6: Commit**

```bash
git add packages/control-plane/test/fakes/build-ws.ts packages/control-plane/test/protocol/cron-author.handler.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
test(cp): prove cron/author against a real connection and database

The unit test proves the fence over fakes; this proves the frame, the row and
the push, which no fake can.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The daemon's `cron/author` client method

`CpClient` is where "connected, correlated, typed reply" lives. This is the `requestGitCred` posture with one deliberate difference: the ordinary retry, not `maxTries: 1`, because the CP's derived id makes a retransmit safe and a single-shot send would turn any timeout into a lost authoring.

**Files:**

- Modify: `packages/daemon/src/cp/client.ts` (beside `requestGitCred` at `:978`; type imports in the block near `:1-120`)
- Create: `packages/daemon/test/cp/client-cron-author.test.ts`

**Interfaces:**

- Consumes: `CronAuthor` / `CronAuthorOk` from Task 1.
- Produces: `CpClient.authorCron(payload: CronAuthor): Promise<CronAuthorOk>`.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/cp/client-cron-author.test.ts`. It reuses the `ready()` idiom from `client-frame-org.test.ts` — a `FakeTransport`, a correlated handshake, then the call under test.

```ts
/**
 * `CpClient.authorCron` — the D→C authoring call.
 *
 * What matters here is the failure surface: a CP refusal must reach the agent as its own
 * message (the agent repairs its schedule and retries in the same turn), and a
 * disconnected client must refuse locally rather than hang.
 */
import { describe, it, expect, vi } from 'vitest'
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
      runCron: vi.fn(() => ({ ok: true })),
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
          serverFeatures: [],
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

describe('CpClient.authorCron', () => {
  it('sends the frame scoped to the agent’s organization and resolves the reply', async () => {
    const { client, t } = await ready()
    const call = client.authorCron(payload)
    await tick()

    const sent = t.lastSent()
    expect(sent.type).toBe('cron/author')
    expect(sent.orgId).toBe(ORG)
    expect(sent.payload.target.channel).toBe('-100123')

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
          { corr: sent.id }
        )
      )
    )
    await expect(call).resolves.toMatchObject({ cronId: '55555555-5555-4555-8555-555555555555' })
  })

  it('surfaces a CP refusal as its own error, not as a timeout', async () => {
    const { client, t } = await ready()
    const call = client.authorCron(payload)
    await tick()
    const sent = t.lastSent()

    t.pushInbound(
      JSON.stringify(
        buildEnvelope(
          'error',
          { code: 'BAD_PAYLOAD', message: 'that schedule never fires — pick one that occurs', retryable: false },
          { corr: sent.id }
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
})
```

If `client.stop()` is not the method name on `CpClient`, read `packages/daemon/src/cp/client.ts` for the teardown and use it; the point of the case is only "not READY ⇒ refuse locally".

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/cp/client-cron-author.test.ts`

Expected: FAIL — `client.authorCron` is not a function.

- [ ] **Step 3: Add the method**

In `packages/daemon/src/cp/client.ts`, add `CronAuthor` and `CronAuthorOk` to the type-only import block from `@agentconnect.md/protocol` (beside `CronReport`), and add the method directly after `requestGitCred` at line 978:

```ts
  /** Author a cron for one agent (D→C `cron/author` REQ). The ordinary retry, not
   *  `requestGitCred`'s one shot: the CP derives the cron id from the frame's `requestId`,
   *  so a retransmit answers the same cron and a dropped reply costs nothing. */
  async authorCron(payload: CronAuthor): Promise<CronAuthorOk> {
    this.requireReady('cron/author')
    const rep = await this.request('cron/author', payload)
    if (rep.type !== 'cron/author/ok') {
      throw new WireError('INTERNAL', `expected cron/author/ok, got ${rep.type}`, false)
    }
    return rep.payload as CronAuthorOk
  }
```

`requireReady` throws `WireError('INTERNAL', 'control plane unreachable for cron/author (client …)', true)`; a correlated `error` frame is already turned into a `WireError` carrying the CP's code and message by the correlator, which is why the second test's rejection needs no special handling.

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/cp/client-cron-author.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/cp/client.ts packages/daemon/test/cp/client-cron-author.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
feat(daemon): add the cron/author client call

Connected-only, correlated, typed reply — with the ordinary retry rather than
one shot, because the CP's derived id makes a retransmit answer the same cron.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The op, and the strict argument schema that is the authorization story

This is where "the model cannot name a target" becomes true. A `z.strictObject` refuses a stray `channel` by name; a plain `z.object` would strip it silently, and the stripping is invisible. The shared `unexpectedKeys` error map moves into `ops/args.ts` — the module that already holds the zod vocabulary every tool schema is built from — rather than being copied.

**Files:**

- Modify: `packages/daemon/src/mcp/ops/args.ts` (append)
- Modify: `packages/daemon/src/mcp/ops/memory.ts:116-125` (import instead of declaring)
- Create: `packages/daemon/src/mcp/ops/cron.ts`
- Create: `packages/daemon/test/mcp-schedule-cron.test.ts`

**Interfaces:**

- Consumes: `authorCron` from Task 4 (through a `CronAuthorDeps` seam, so the test needs no client).
- Produces: `SCHEDULE_CRON_ARGS`, `CronAuthorDeps`, and `scheduleCron(ctx, args, deps)`; `unexpectedKeys` exported from `ops/args.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/mcp-schedule-cron.test.ts`:

```ts
/**
 * `scheduleCron` — the two load-bearing properties.
 *
 * A cron must target the session the call ran in, and the model must not be able to name a
 * different one. Both are asserted against the frame the op builds, because the schema and
 * the context copy are separately breakable: loosening `strictObject` to `object` would
 * silently strip a `channel` argument and no other test would notice.
 */
import { describe, it, expect, vi } from 'vitest'
import { scheduleCron } from '../src/mcp/ops/cron.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import type { SessionContext } from '../src/mcp/ops.js'
import type { CronAuthor } from '@agentconnect.md/protocol'

const ctx: SessionContext = {
  agentId: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
  platform: 'telegram',
  integrationId: 'int-tg',
  isDm: false,
  channel: '-1001234567890',
  thread: '-1001234567890:42',
  tools: toolsForIntegrations([
    {
      id: 'int-tg',
      platform: 'telegram',
      core: { mode: 'direct', bindRules: [], mutedChannels: [], affinityDenied: [], gated: false },
      config: { botToken: '123456:ABC' }
    } as never
  ])
}

const args = { schedule: '30 6 * * *', timezone: 'Asia/Ho_Chi_Minh', prompt: 'chào cả nhà' }

function deps() {
  const seen: CronAuthor[] = []
  return {
    seen,
    authorCron: vi.fn(async (req: CronAuthor) => {
      seen.push(req)
      return {
        cronId: '55555555-5555-4555-8555-555555555555',
        schedule: req.schedule,
        timezone: req.timezone,
        nextRun: '2026-09-26T23:30:00.000Z'
      }
    })
  }
}

describe('scheduleCron', () => {
  it('fills every coordinate from the session, never from the model', async () => {
    const d = deps()
    await scheduleCron(ctx, args, d)

    expect(d.seen).toHaveLength(1)
    expect(d.seen[0]).toMatchObject({
      agentId: ctx.agentId,
      schedule: args.schedule,
      timezone: args.timezone,
      trigger: args.prompt,
      target: { platform: 'telegram', channel: '-1001234567890', integrationId: 'int-tg' }
    })
    // A fresh id per call: two calls are two crons, which is what a caller asking twice means.
    expect(d.seen[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('refuses a channel argument by name', async () => {
    const d = deps()
    await expect(scheduleCron(ctx, { ...args, channel: '#other' }, d)).rejects.toThrow(/unexpected argument: channel/)
    expect(d.authorCron).not.toHaveBeenCalled()
  })

  it('refuses every other coordinate the model might reach for', async () => {
    const d = deps()
    for (const stray of ['thread', 'integrationId', 'platform', 'agentId', 'id']) {
      await expect(scheduleCron(ctx, { ...args, [stray]: 'x' }, d)).rejects.toThrow(
        new RegExp(`unexpected argument: ${stray}`)
      )
    }
    expect(d.authorCron).not.toHaveBeenCalled()
  })

  it('refuses a session with no conversation to fire into', async () => {
    const d = deps()
    const headless = { ...ctx, integrationId: undefined }
    await expect(scheduleCron(headless, args, d)).rejects.toThrow(/no platform integration|no conversation/)
    expect(d.authorCron).not.toHaveBeenCalled()
  })

  it('carries the CP’s refusal back to the agent verbatim', async () => {
    const d = deps()
    d.authorCron = vi.fn(async () => {
      throw Object.assign(new Error('that schedule never fires — pick one that occurs'), { code: 'BAD_PAYLOAD' })
    }) as never
    await expect(scheduleCron(ctx, args, d)).rejects.toThrow(/never fires/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/mcp-schedule-cron.test.ts`

Expected: FAIL — `../src/mcp/ops/cron.js` does not exist.

- [ ] **Step 3: Share the strict-key error map**

In `packages/daemon/src/mcp/ops/args.ts`, append:

```ts
/** A stray key is almost always a SIBLING tool's argument; refuse it by name rather than
 *  dropping it, which is the difference between a guarantee and a silent strip (#1921). */
export const unexpectedKeys: { error: z.core.$ZodErrorMap } = {
  error: (issue) =>
    issue.code === 'unrecognized_keys'
      ? `unexpected argument${issue.keys.length > 1 ? 's' : ''}: ${issue.keys.join(', ')}`
      : undefined
}
```

In `packages/daemon/src/mcp/ops/memory.ts`, delete the private `unexpectedKeys` declaration at lines 116-125 and add it to the existing import from `./args.js`:

```ts
import { optionalString, parseArgs, requiredString, unexpectedKeys } from './args.js'
```

(Keep whatever names that import already lists; add only `unexpectedKeys`.)

- [ ] **Step 4: Write the op**

Create `packages/daemon/src/mcp/ops/cron.ts`:

```ts
/**
 * `scheduleCron` — an agent schedules itself (docs/superpowers/specs/2026-09-26-agent-authored-cron-design.md §6).
 *
 * STRICT by construction, and that is the whole authorization story: the target is the
 * conversation this call ran in, so the model must not be able to name a different one. A
 * plain `z.object` would strip a stray `channel` silently, which is why this is not one.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CronAuthor, CronAuthorOk } from '@agentconnect.md/protocol'
import { optionalString, parseArgs, requiredString, unexpectedKeys } from './args.js'
import type { SessionContext } from './context.js'

export const SCHEDULE_CRON_ARGS = z.strictObject(
  {
    schedule: requiredString('schedule'),
    timezone: requiredString('timezone'),
    prompt: requiredString('prompt'),
    name: optionalString('name')
  },
  unexpectedKeys
)

/** The one seam this op has: it talks to the control plane, never to a platform gateway. */
export interface CronAuthorDeps {
  authorCron: (req: CronAuthor) => Promise<CronAuthorOk>
}

export async function scheduleCron(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CronAuthorDeps
): Promise<unknown> {
  const parsed = parseArgs(SCHEDULE_CRON_ARGS, args)
  // No integration, no conversation: refused rather than authored headless, because a cron
  // the agent believes posts — and that never posts — is worse than a refusal.
  if (!ctx.integrationId) {
    throw new Error('scheduleCron: this session has no platform integration, so there is no conversation to fire into.')
  }
  const ok = await deps.authorCron({
    requestId: randomUUID(),
    agentId: ctx.agentId,
    ...(parsed.name ? { name: parsed.name } : {}),
    schedule: parsed.schedule,
    timezone: parsed.timezone,
    trigger: parsed.prompt,
    target: { platform: ctx.platform, channel: ctx.channel, integrationId: ctx.integrationId }
  })
  return {
    cronId: ok.cronId,
    schedule: ok.schedule,
    timezone: ok.timezone,
    nextRun: ok.nextRun,
    channel: ctx.channel
  }
}
```

`ctx.thread` is deliberately not sent: `CronTarget` has no thread field and the daemon's `buildSyntheticMessage` derives the fire's thread from the cron id (`scheduler.ts:51-79`), so the reply lands in the conversation as a new thread rather than reviving the one the tool was called in.

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/mcp-schedule-cron.test.ts`

Expected: PASS.

- [ ] **Step 6: Confirm the memory-tool schemas still hold**

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/mcp-tool-argument-errors.test.ts`

Expected: PASS. That suite asserts the `unexpected argument: …` wording, so it is what catches a botched hoist.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/mcp/ops/cron.ts packages/daemon/src/mcp/ops/args.ts \
  packages/daemon/src/mcp/ops/memory.ts packages/daemon/test/mcp-schedule-cron.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
feat(daemon): add the scheduleCron op

Every coordinate comes from the session context; a stray channel, thread or
integrationId is refused by name rather than silently dropped, which is what
makes "the model cannot name a destination" a guarantee instead of a habit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The tool descriptor, the feature gate, and the dispatch entry

Last vertical slice: the descriptor the model reads, the registration that makes it dispatchable, the auto-allow entry that keeps it from prompting on every call, and the gate that keeps a fork daemon from calling a CP that does not serve `cron/author`.

**Files:**

- Modify: `packages/daemon/src/mcp/tools.ts:299` (new builder), `:1275-1308` (`ALL_TOOL_NAMES`), `:1317-1358` (`toolsForIntegrations`)
- Modify: `packages/daemon/src/mcp/ops.ts` (imports, `:171-185`, `:225-284`, `:293-352`)
- Modify: `packages/daemon/src/daemon.ts:3011` (the dep), `:3333-3336` (the gate)
- Modify: `packages/daemon/test/mcp-tool-args.test.ts:36-45`

**Interfaces:**

- Consumes: `scheduleCron`, `SCHEDULE_CRON_ARGS`, `CronAuthorDeps` from Task 5; `AGENT_CRON_AUTHOR_FEATURE` from Task 1; `authorCron` from Task 4.
- Produces: the tool name `scheduleCron` in the advertised registry, the dispatch table and the permission auto-allow set; the `cronAuthor` option on `toolsForIntegrations`.

- [ ] **Step 1: Write the failing test**

Append to `packages/daemon/test/mcp-tool-args.test.ts`:

```ts
describe('the scheduleCron feature gate', () => {
  it('advertises scheduleCron only when the CP serves it', () => {
    const on = toolsForIntegrations([slackInt, telegramInt], { cronAuthor: true }).map((t) => t.name)
    const off = toolsForIntegrations([slackInt, telegramInt]).map((t) => t.name)
    // `cron/author` is frame-fatal to a CP that does not know it, so the tool must not exist
    // there — an agent that called it would report a broken feature instead of an absent one.
    expect(on).toContain('scheduleCron')
    expect(off).not.toContain('scheduleCron')
  })
})
```

and widen the `advertised` array at lines 36-45 so the field-agreement cases cover the new tool:

```ts
const advertised: ToolDescriptor[] = [
  ...toolsForIntegrations([slackInt, telegramInt], {
    organizationKnowledge: true,
    cronAuthor: true,
    currentPlatform: 'slack'
  })
  // …the rest unchanged
]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/mcp-tool-args.test.ts`

Expected: FAIL — `scheduleCron` is not advertised, and `'advertises every dispatchable tool that takes arguments'` will fail too once Step 3 registers the schema.

- [ ] **Step 3: Write the descriptor**

In `packages/daemon/src/mcp/tools.ts`, add beside `buildShareFileTool` (line 299):

```ts
/** `scheduleCron` — an AgentConnect cron that wakes THIS agent on a schedule, firing with
 *  nobody watching and posting into the conversation it was authored in. Not `scheduleMessage`:
 *  that hands the platform a fixed message to post; this wakes the agent to decide then. */
function buildScheduleCronTool(): ToolDescriptor {
  return {
    name: 'scheduleCron',
    description:
      'Schedule YOURSELF to wake on a recurring schedule and act in THIS conversation. The schedule lives in ' +
      'AgentConnect rather than in your session, so it keeps firing after this session ends and while nobody is ' +
      'talking to you — which is what makes it different from a scheduler your own runtime offers, and from ' +
      '`scheduleMessage`, which only posts a fixed message and cannot decide anything when it fires. `schedule` ' +
      'is a five-field cron expression (`30 6 * * *` = 06:30 every day) and `timezone` is the IANA zone it is ' +
      'read in — REQUIRED, and never defaulted: ask the person which zone they mean instead of assuming UTC. ' +
      '`prompt` is what you are told when it fires; write it as an instruction to your future self, including ' +
      'anything you would otherwise have to look up again. The result posts into this conversation only — you ' +
      'cannot name a channel, a thread, or another bot. Returns the cron id and its next fire time.',
    inputSchema: obj(
      {
        schedule: {
          type: 'string',
          minLength: 1,
          description: 'Croner five-field expression, e.g. `30 6 * * *`.'
        },
        timezone: {
          type: 'string',
          minLength: 1,
          description: 'IANA zone the schedule is read in, e.g. `Asia/Ho_Chi_Minh`. Required — never assume UTC.'
        },
        prompt: {
          type: 'string',
          minLength: 1,
          description: 'What you are told when it fires — an instruction to your future self.'
        },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: "Optional short label for the operator's cron list."
        }
      },
      ['schedule', 'timezone', 'prompt']
    )
  }
}
```

- [ ] **Step 4: Advertise it behind the feature**

Widen the options object at line 1319:

```ts
  options: { organizationKnowledge?: boolean; currentPlatform?: string; cronAuthor?: boolean } = {}
```

and add the tool beside `add(COLLABORATION_TOOLS)` at line 1332:

```ts
// The CP answered on register that it serves `cron/author`; without that, the frame is
// frame-fatal to it, so the tool must not be offered at all (see AGENT_CRON_AUTHOR_FEATURE).
if (options.cronAuthor) add([buildScheduleCronTool()])
```

Add the descriptor to `ALL_TOOL_NAMES` beside `buildShareFileTool()` at line 1281:

```ts
      buildScheduleCronTool(),
```

`ALL_TOOL_NAMES` is the permission auto-allow set; a name missing from it draws an approval prompt on every call.

- [ ] **Step 5: Register the dispatch entry and the validator**

In `packages/daemon/src/mcp/ops.ts`:

```ts
import { scheduleCron, SCHEDULE_CRON_ARGS, type CronAuthorDeps } from './ops/cron.js'
```

Add `CronAuthorDeps` to the `OpsDeps extends` list (after `ShareFileDeps`), add to `HANDLERS` after `['shareFile', shareFile],`:

```ts
  ['scheduleCron', scheduleCron],
```

and to `TOOL_ARG_SCHEMAS` beside `['scheduleMessage', SCHEDULE_MESSAGE_ARGS],`:

```ts
  ['scheduleCron', SCHEDULE_CRON_ARGS],
```

- [ ] **Step 6: Wire the dep and the gate in the daemon**

In `packages/daemon/src/daemon.ts`, beside the other CP round-trips (near `orgSkills` at line 3007, inside the `McpControlServer` deps literal):

```ts
      // scheduleCron (agent-authored-cron-design.md §6): the payload is built wholly from the
      // trusted session context inside the op — the model supplies only schedule/timezone/prompt/name.
      authorCron: async (req) => {
        const client = this.cpClient
        if (!client) throw new Error('control plane is not connected')
        return await client.authorCron(req)
      },
```

And at the tool-assembly site (lines 3333-3336):

```ts
let tools = toolsForIntegrations(agent.integrations, {
  organizationKnowledge: this.cpClient?.supportsServerFeature?.(ORGANIZATION_KNOWLEDGE_FEATURE) === true,
  cronAuthor: this.cpClient?.supportsServerFeature?.(AGENT_CRON_AUTHOR_FEATURE) === true,
  currentPlatform: platform
})
```

Add `AGENT_CRON_AUTHOR_FEATURE` to the protocol value import at line 34 (where `ORGANIZATION_KNOWLEDGE_FEATURE` is imported).

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/mcp-tool-args.test.ts`

Expected: PASS. `'%s takes exactly the advertised arguments'` runs once per `TOOL_ARG_SCHEMAS` key, so it now holds `scheduleCron`'s descriptor and its zod schema to the same four fields.

Run: `pnpm --filter @agentconnect.md/daemon exec vitest run test/mcp-ops.test.ts test/mcp-tools.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/src/mcp/tools.ts packages/daemon/src/mcp/ops.ts packages/daemon/src/daemon.ts \
  packages/daemon/test/mcp-tool-args.test.ts
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
feat(daemon): offer scheduleCron when the CP serves it

The descriptor that tells an agent its schedule outlives its session, the
dispatch and auto-allow entries it needs, and the feature gate that keeps a
fork daemon from sending a frame an older CP cannot decode.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Document the behavior

Per the repo convention this file is product behavior, not a follow-up. It is last because it describes what Tasks 1-6 actually shipped.

**Files:**

- Modify: `docs/product-conventions.md` (a new `###` section in the `### What sendMessage is for` / `### Sharing a produced file into the current conversation` family, after line 461)

**Interfaces:**

- Consumes: nothing.
- Produces: nothing. Docs only.

- [ ] **Step 1: Read the neighbouring sections**

Read `docs/product-conventions.md` at lines 357-462 before editing. The convention in this file is prose that states _why_, with no implementation vocabulary — no field names, no function names, no frame names.

- [ ] **Step 2: State the distinction and the limits**

Add a `### Scheduling the agent itself` section after the forwarding section (line 461), covering:

- **The distinction, in one sentence each.** `scheduleMessage` hands the platform a message to post at a fixed time; `scheduleCron` wakes the agent at a fixed time to decide what to do then. A reader who conflates them will ask why Telegram offers one and not the other — the answer is that a scheduled post needs a platform primitive Telegram does not have, while a wake needs nothing from the platform.
- **What makes the wake different.** It lives in AgentConnect, not in the agent's session, so it fires when the session has ended and nobody is watching; that is the whole reason an agent's own runtime scheduler is not a substitute.
- **Where it posts.** Into the conversation the agent was answering when it scheduled, and nowhere else: the agent cannot name a channel, a thread, or a different bot. A session with no conversation of its own cannot schedule at all, and is refused rather than quietly given a schedule that never says anything.
- **The timezone is the person's.** The agent must state a named zone and cannot fall back to one nobody chose; it is expected to ask.
- **The operator owns it afterwards.** An agent-authored cron is an ordinary row in the Crons view with no human creator shown, and the audit log names the authoring agent. It can be disabled or deleted like any other — and a wake is not a loop: an agent that schedules many is visible there.

- [ ] **Step 3: Check the wording against the shipped behavior**

Re-read the new section and confirm every claim matches what Tasks 1-6 built. Specifically: it must not claim the agent can schedule into another conversation, must not describe an omission of the timezone as defaulting, and must not describe the fire as a `sendMessage` post — the daemon posts the trigger as its own message and the agent's turn answers it.

- [ ] **Step 4: Commit**

```bash
git add docs/product-conventions.md
git -c user.name=bacnv -c user.email=bacnv@users.noreply.github.com commit -m "$(
  cat << 'EOF'
docs(product): record the agent-scheduled wake and how it differs from a scheduled post

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## End-to-end verification

After Task 7, run the workspace gates once, from the repo root:

```bash
pnpm typecheck
pnpm --filter @agentconnect.md/protocol test
pnpm --filter @agentconnect.md/daemon test
pnpm --filter @agentconnect.md/control-plane exec vitest run --project unit
pnpm --filter @agentconnect.md/control-plane exec vitest run --project integration
```

`typecheck` matters more than usual here: `DaemonWsDeps` gained two required fields, and the compiler is the only thing that sees every literal that must supply them. Docker is required for the integration project only; the unit project above needs none.

**What this plan does not verify, and cannot:** a cron actually firing. Nothing in the workspace suite drives a real daemon `Scheduler` over a real interval. Before calling the feature done, take a Telegram agent whose CP advertises `agent-cron-author-v1`, ask it in a group to greet the room daily, and confirm all five: the tool is offered and the schedule is accepted; a row with no creator appears in the console's Crons view; the daemon's log shows it arming the def; the greeting posts into that group with nobody having spoken; and disabling the row in the console stops the next fire. If the agent instead reaches for `CronCreate`, the tool was not offered — check `register/ok.serverFeatures` first.
