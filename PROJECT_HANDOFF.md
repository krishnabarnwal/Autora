# PROJECT HANDOFF — Autonomous AI Creator

_Handoff rewritten 2026-08-09 after Phase 12, then extended the same day with §9 for Phase 12.5 (Breeth strategic memory). Everything below is verified against the actual repository (files read, tests run, `git status` captured), not the README's forward-looking text — the README and `client/src/App.jsx` still say "Phase 1 of 21"; that is stale copy, ignore it._

## 1. Project purpose & current architecture

An autonomous AI persona (reference persona: **Sentinel**, an AI security researcher) that discovers technology topics from live sources, decides on its own whether each is worth publishing, writes it in a consistent voice, remembers what it published, and avoids repetition — with no human prompting after `POST /api/agent/init`. "Publishing" is simulated by persisting to the app's own MongoDB and exposing it via `GET /api/agent/feed`; there is no real social posting.

**As of Phase 12 the pipeline is wired into a running autonomous loop.** A registered agent cycles on a timer with no further input:

```
scheduler (one CycleWorker per agent, owns WHEN)
  └─ runCycle(agent) (owns WHAT, ≤2 LLM calls)
       live sources -> collect -> filter -> dedupe -> rank -> candidates   (0 LLM)
         -> memory.checkRepetition per candidate                          (0 LLM)
              BLOCKED     -> dropped before any LLM call
              DISCOURAGED -> kept, ordered below fresh ALLOWED
         -> editorial evaluateCandidates                          (LLM CALL #1)
         -> if publish: generatePost                              (LLM CALL #2)
         -> publishFinalPost (Post + published TopicMemory)               (0 LLM)
         -> else memory.recordDecision('deferred')                        (0 LLM)
         -> breeth.addEpisode  OPTIONAL, off by default, never fatal      (0 LLM)
  └─ worker folds stat deltas + timing + backoff into ONE Agent update
-> GET /api/agent/feed -> dashboard (Phase 14, not built)
```

Design priorities (persistent, from the project owner): reliability over complexity; working autonomy over flashy features; real agent behavior over demo theater; low API usage (cheap deterministic local work first, LLM only for judgment/writing — **at most 2 LLM calls per publishing cycle, 0 when nothing is worth judging**).

Build discipline: **one phase at a time — implement, test, verify, report, then STOP and wait for go-ahead.**

## 2. Tech stack

- **Monorepo** with a root `package.json` orchestrating `server/` and `client/` (`npm run install:all`, `dev:server`, `dev:client`, `test`).
- **Server:** Node.js ESM (`"type":"module"`, engines `>=20`), Express `5.1.0`, Mongoose `9.9.1`, `cors`, `dotenv`. Dev-only: `mongodb-memory-server` `11.2.0`.
- **Database:** MongoDB (Atlas in production). An in-process ephemeral MongoDB exists **only** for local testing behind an explicit `USE_EPHEMERAL_DB=true` opt-in; env validation forbids it in production (never a silent fallback).
- **LLM:** provider abstraction with `gemini` and `mock` adapters behind one factory; default model `gemini-3.5-flash`. No provider name/endpoint leaks outside `services/llm/`.
- **Tests:** built-in `node:test` runner (no Jest/Mocha). `npm test` = `node --test --test-concurrency=1 --test-timeout=60000 "test/**/*.test.js"`. There is **no lint or typecheck script** in `server/package.json` (scripts are only `start`, `dev`, `test`).
- **Client:** React + Vite + Tailwind. Currently only a Phase 1 health-check shell (`client/src/App.jsx`); the real dashboard is Phase 14.

## 3. Current folder structure (source, excluding node_modules)

```
server/src/
  app.js                 Express app factory (/api/health, /api/agent, error handler)
  server.js              process entrypoint: signal handling, crash guards
  bootstrap.js           validate -> connect DB -> syncIndexes -> listen -> START SCHEDULER -> shutdown
  config/                env.js (config + validateConfig + publicConfig), database.js
  models/                Agent.js, Post.js, TopicMemory.js, index.js (+ syncIndexes)
  routes/                agent.js (init, feed), validators.js
  controllers/           (empty: .gitkeep — unused; route logic lives in routes/)
  scheduler/             worker.js (CycleWorker + calculateBackoffDelay)   <- Phase 12
                         index.js  (Scheduler registry + get/setScheduler) <- Phase 12
  services/
    sources/             live source adapters (HN, RSS), http pool, normalize, registry
    topics/              filter, dedupe, rank, relevance, index (discoverTopics)
    llm/                 provider factory, gemini/mock, json, retry, usage, candidates
    editorial/           Phase 9 decision (evaluateCandidates) + prompt/schema/verify
    generation/          Phase 10 FinalPost (generatePost, verifyGeneratedPost)
    publisher/           Phase 10B publishFinalPost
    memory/              Phase 11 index.js
    breeth/              index.js — optional strategic memory       <- Phase 12.5
    agent/               runCycle.js                                       <- Phase 12
  scripts/               smoke-*.js (api, sources, llm, editorial, post-generation, publish, memory)
  utils/                 text.js, logger.js, ids.js, errors.js,
                         agentEvents.js  <- Phase 12 (leaf notification seam)
server/test/             node:test suites mirroring src/ + fixtures/ + helpers/
                         + agent/runCycle.test.js, scheduler/{worker,index,wiring}.test.js
client/src/              App.jsx (Phase 1 shell), services/api.js, main.jsx (dashboard = Phase 14)
```

Note: `server/src/scheduler/.gitkeep` and `server/src/services/agent/.gitkeep` are **still present** even though both directories now hold real code. Phase 11 deleted `services/memory/.gitkeep` when it filled that directory; these two were left in place. Harmless, but inconsistent.

## 4. Phases 1–8: foundation (all complete, all tested)

- **Phase 1** — monorepo scaffold, `GET /api/health`, client health shell.
- **Phase 2** — `config/env.js`: typed config, `validateConfig()` (throws on a bad production combination, returns `{warnings}`), `publicConfig()` (never emits a secret). `config/database.js`: connect/disconnect, ephemeral opt-in.
- **Phase 3** — Mongoose models. `Agent` (agentId `agt_` + 16 hex, `persona {name, domain}`, `personaKey` unique, `status`, `stats`, `lastCycleAt`, `nextCycleAt`, `lastError {message, at}`), `Post` (`toFeedJSON()`, `feedFor(agentId, {limit, before})`), `TopicMemory` (unique `(agentId, normalizedTopic)`). `syncIndexes()` runs at boot.
- **Phase 4** — public API: `POST /api/agent/init` (idempotent by persona: 201 create / 200 reuse, unique-index race adopted via `err.code === 11000`), `GET /api/agent/feed` (404 for an unknown agentId, `{posts: []}` for an initialized agent with nothing published).
- **Phase 5** — live sources: Hacker News + RSS adapters, a shared HTTP pool with timeouts, `normalize.js`, and a registry. Failures are per-source and non-fatal.
- **Phase 6** — `services/topics`: `filter` (noise/recency/length gates), `dedupe` (near-duplicate collapse), `rank` (deterministic scoring), `relevance` (domain fit), and `discoverTopics()` composing them. **Zero LLM calls.**
- **Phase 7** — `services/llm`: provider factory + `gemini`/`mock` adapters, strict JSON parsing, retry with backoff, usage accounting. The provider name and endpoint never leak outside this directory.
- **Phase 8** — candidate shaping for the editorial prompt.

## 5. Phase 9 — editorial decision (1 LLM call)

`evaluateCandidates(candidates, {agent, provider})` asks the model, in one call, which candidate (if any) is worth publishing and why. `prompt.js` builds it, `schema.js` pins the response shape, `verify.js` rejects a malformed or hallucinated selection. The agent may legitimately answer "publish nothing" — that is a real editorial outcome, not a failure.

## 6. Phase 10 / 10B — generation and publishing

`generatePost(...)` produces a `FinalPost` in the persona's voice (1 LLM call), `verifyGeneratedPost` enforces length, voice, and source-citation rules. `publishFinalPost(...)` writes the `Post` and a `published` `TopicMemory` row in one step, and is the only writer of published content.

## 7. Phase 11 — memory (0 LLM calls)

`services/memory/index.js` exposes `checkRepetition(agentId, topic)` → `{gate, reason}` where gate is `BLOCKED`, `DISCOURAGED`, or `ALLOWED`, and `recordDecision(...)` for `deferred`/`published` rows. The memory layer is **advisory**: the authoritative duplicate gate is the `TopicMemory` unique index on `(agentId, normalizedTopic)`, so a race that slips past the advisory check still cannot produce a duplicate post.

## 8. Phase 12 — the autonomous loop

Phase 12 added no new content capability. It added **time**: an orchestrator that runs one cycle, and a scheduler that decides when cycles happen. The split is deliberate and load-bearing:

> **`runCycle` owns WHAT happens in a cycle. `CycleWorker` owns WHEN cycles run. `Scheduler` owns WHICH agents have a worker.**

### 8.1 `services/agent/runCycle.js` (362 lines) — WHAT

`runCycle(agent, options)` composes Phases 5–11 and returns a plain result — it performs **no Agent write of its own**:

```js
{ agentId, outcome, failed, stats, errors }
```

- `OUTCOME` = `{ PUBLISHED: 'published', DUPLICATE: 'duplicate', IDLE: 'idle', PAUSED: 'paused', FAILED: 'failed' }`.
- `stats` is a **delta block** — `{topicsDiscovered, topicsAfterFilter, topicsRejected, topicsSelected, postsPublished, llmCalls}` — not an absolute total. The worker folds it into `$inc`.
- `DEFAULT_SERVICES` is a frozen object of the real collaborators (`discoverTopics`, `checkRepetition`, `evaluateCandidates`, `generatePost`, `publishFinalPost`, `recordDecision`, and — since Phase 12.5 — `breeth`); every one is injectable, which is why the suite needs no database, no provider, and no Breeth server.
- `INACTIVE_STATUSES = new Set(['paused', 'removed'])` short-circuits to `OUTCOME.PAUSED` before any work. (`'removed'` is defensive — see §14 item 5.)
- `CycleInputError` is thrown for a null/malformed agent, i.e. a programming error, not a runtime condition.

**The LLM budget is a hard invariant, enforced by tests, not by convention:**

| cycle shape | LLM calls |
|---|---|
| no candidates survive discovery | **0** |
| every candidate `BLOCKED` by memory | **0** |
| editorial says publish nothing | **1** (editorial only) |
| a post is published | **2** (editorial + generation) |

`BLOCKED` candidates are dropped *before* the editorial call, so repetition costs nothing. `DISCOURAGED` candidates are kept but ordered below fresh `ALLOWED` ones, so the agent prefers novelty without being forbidden from revisiting a topic. On a non-publish decision, `recordDeferredCandidate(...)` writes one `deferred` row for `viable[0]` and swallows its own errors — bookkeeping must never fail a cycle.

### 8.2 `scheduler/worker.js` (345 lines) — WHEN, for one agent

`CycleWorker` is the clock around a cycle, and **the single writer of Agent state**. Every collaborator is an injected seam — `now`, `setTimer`, `clearTimer`, `reload`, `persist`, `runCycleFn`, `logger`, `cycleIntervalMs`, `maxBackoffMs`, `bootDelayMs` — so the whole timer loop is tested on a fake clock with no real timers, no database, and no provider.

Lifecycle of one tick:

```
_tick()  guard: return immediately if stopped or already running
  └─ _runOnce()
       reload(agentId)          throw  -> count a failure, back off, NO stat write
                                null   -> stop() (the agent no longer exists)
       runCycle(agent)          throw  -> caught, becomes a failed result
                                PAUSED -> stop(), NO stat write
       _applyResult(result)     -> exactly ONE persist()
  finally: reschedule unless stopped
```

Guarantees, each pinned by a test:

- **Immediate first cycle.** `start()` arms a zero-delay timer (`bootDelayMs`), so a newly registered or resumed agent produces work at once instead of after an idle interval.
- **`start()` is idempotent** — a second call while a timer is armed or a cycle is in flight is a no-op, so there is never a second loop for one agent.
- **No overlapping cycles.** A tick arriving while a cycle is running early-returns on the `running` guard; the test asserts `maxConcurrent === 1`.
- **A failure never kills the loop.** Three layers of catch: inside `_safeRunCycle`, inside `_runOnce`, and a last-resort catch in `_tick` — and the reschedule lives in `finally`, so even an unexpected throw past every inner catch still backs off and rearms.
- **One write per cycle.** `_buildUpdate` emits a single update: `$set` for `lastCycleAt`, `nextCycleAt`, `status` (`'autonomous'` or `'error'`), and on failure `lastError.message` / `lastError.at`; `$inc` for `stats.cyclesRun`, `stats.cyclesFailed` (failures only), and each **non-zero** stat delta. Zero deltas are omitted rather than written as `$inc: 0`.
- **A self-stopping worker leaves no orphan timer.** The paused and vanished-agent paths call `stop()`, which clears the pending timer and writes nothing.

**Secret safety by construction.** `lastError.message` is assembled *only* from the controlled `{stage, code}` enums a cycle result carries, each passed through a local `sanitizeToken` (`/[^a-z0-9_.-]/gi` stripped, 40 chars max), then capped at 300 characters total with a `...` suffix. Raw error text never reaches durable Agent state, so a connection string or key cannot be persisted even if a future code path put one in an error. A test feeds a synthetic `mongodb+srv://user:...@host/db` string through as a `code` and asserts the stored message contains no `://`, no `@`, no `/`, and no `user:password` pair.

### 8.3 Backoff behavior

```js
export const DEFAULT_MAX_BACKOFF_MS = 30 * 60 * 1000;   // 30 minutes

calculateBackoffDelay(consecutiveFailures, cycleIntervalMs, maxBackoffMs)
  = consecutiveFailures <= 0
      ? cycleIntervalMs
      : min(cycleIntervalMs * 2 ** (consecutiveFailures - 1), maxBackoffMs)
```

It is exported as a **pure function**, so the entire progression is tested as a truth table with no timers at all.

| consecutive failures | delay (interval = 45 s, ceiling = 30 min) |
|---|---|
| 0 (healthy) | 45 s |
| 1 | 45 s |
| 2 | 90 s |
| 3 | 3 min |
| 4 | 6 min |
| … | doubling |
| 50 / 1e9 | 30 min (clamped) |

Properties that are deliberate, not accidental:

- **The first retry is still at base cadence.** One transient blip does not slow the agent down.
- **Backoff may exceed one cycle interval and is *not* capped at it.** A persistently failing agent genuinely does back off past its normal cadence, all the way to the ceiling. This was an explicit design decision.
- **Success resets to zero.** `consecutiveFailures = 0` on any successful cycle, restoring base cadence immediately — no slow ramp-down.
- **Bad inputs degrade, never poison the clock.** A non-finite or non-positive interval falls back to `config.agent.cycleIntervalMs`; a bad ceiling falls back to `DEFAULT_MAX_BACKOFF_MS`; a finite failure count always yields a finite positive delay. `NaN`/`Infinity` can never reach `setTimeout`.
- A **reload failure** counts toward backoff but writes no stats — a database blip is not a cycle.

### 8.4 `scheduler/index.js` (205 lines) — WHICH agents

`Scheduler` is a registry of at most one worker per agent (`workers = new Map()`), with `createWorker`, `findResumable`, `provider`, `bootStaggerMs`, `workerOptions`, and `logger` all injectable.

- **`register(agentId, {bootDelayMs})`** — idempotent. A live worker is returned untouched; a self-stopped worker is recreated; the worker starts immediately **only if the scheduler itself has started**.
- **`resumeAll()`** — loads `Agent.findResumable()` (status in `autonomous` / `initializing` / `error`, oldest first), registers each with `bootDelayMs: i * bootStaggerMs` (`DEFAULT_BOOT_STAGGER_MS = 2_000`) so a restart with many agents does not fire every cycle in the same tick, then `start()`s the scheduler and returns the count. A `findResumable` failure is caught and treated as "no agents" — a bad query must not abort boot. Bare id strings are tolerated alongside documents.
- **`stopAll()`** — try/catch per worker so one bad `stop()` cannot strand the rest, then clears the map and marks the scheduler unstarted. No orphan timers survive.
- **Dormancy is the reason 541 pre-existing tests stayed green.** `register()` records a worker but arms nothing; only `start()` goes live. Tests build the app with `createApp()` and never boot, so no timer is ever armed.
- Module-level `setScheduler(scheduler)` / `getScheduler()` hold the active instance.

### 8.5 `utils/agentEvents.js` (48 lines) — why this file exists

This is the **one file created beyond the three Phase 12 specified**, and it exists because of a real architectural guard, not convenience.

The first wiring attempt imported the scheduler directly into `routes/agent.js`. `test/routes/feed.test.js` — written in an earlier phase — scans the route's import specifiers and **forbids** `scheduler`, because a static edge from the HTTP request path would pull `worker → runCycle → editorial → generation → the entire LLM stack` into the route's dependency graph. The full suite failed 583/584.

The guard encodes an invariant worth keeping, so it was **not weakened**. The dependency was inverted instead:

```
routes/agent.js  --notifyAgentInitialized(agentId)-->  utils/agentEvents.js  (imports NOTHING)
                                                              ^
bootstrap.js  --setAgentInitializedHandler(id => scheduler.register(id))-----┘
```

`agentEvents.js` is a leaf module with a single `let handler = null`. `notifyAgentInitialized` returns `false` when nothing is listening — which is every test that does not boot a server — so the endpoint stays inert and instant. Non-functions passed to `setAgentInitializedHandler` are coerced to `null`. Errors propagate to the caller, and the route logs them without failing the request: the agent is already persisted, and `resumeAll()` would pick it up on the next restart regardless. Result: 587/587.

### 8.6 Scheduler lifecycle end to end

**Boot** (`bootstrap.js`, after `listen` — the only place the loop starts):

```js
const scheduler = new Scheduler({ provider: getLlmProvider() });
setScheduler(scheduler);
setAgentInitializedHandler((agentId) => scheduler.register(agentId));
const resumed = await scheduler.resumeAll();
```

**A new agent** — `POST /api/agent/init` persists the agent, then announces it. Bootstrap's handler calls `scheduler.register(agentId)`, the worker starts immediately, and the first cycle runs at once. The route re-announces on *every* init, including repeats; `register()`'s idempotency is what guarantees a single loop.

**Shutdown** — signal handling stays in `server.js`; Phase 12 added no new handlers. Inside the **existing** `shutdown`, before the server and database close:

```js
setAgentInitializedHandler(null);
scheduler.stopAll();
setScheduler(null);
```

Order matters. Cycles stop **first**, so no worker can start a cycle against a database that is already closing; detaching the handler stops a late request from registering a worker mid-shutdown; and clearing every pending timer means nothing holds the event loop open. `startServer()` now returns `{server, shutdown, scheduler}` (was `{server, shutdown}`).

## 9. Phase 12.5 — Breeth strategic memory (this addendum)

Breeth was added as an **optional, non-authoritative strategic-memory layer**. It is not a new product feature and it does not change the agent's decisions: the authoritative memory remains MongoDB (§7). Its only job is to persist a high-value summary of what the agent decided and why, so future cycles (or a human reviewing the Breeth graph) can see cross-cycle strategic context that MongoDB's counters do not retain.

The architecture boundary is unchanged and is the point of the whole phase:

> **MongoDB decides (duplicates, repetition, published-topic authority, audit history, scheduler correctness). Breeth only remembers — it never decides, never blocks, and never costs an LLM call.**

### 9.1 Roles

| layer | authoritative for | how |
|---|---|---|
| MongoDB `TopicMemory` | duplicate prevention, repetition gates (`BLOCKED`/`DISCOURAGED`/`ALLOWED`), published-topic authority, audit history | unique index `(agentId, normalizedTopic)` + `checkRepetition`/`recordDecision` |
| Breeth | **nothing** — optional strategic context only | one `POST /v1/episodes` per cycle recording the decision; `POST /v1/search` implemented but **not consulted by any decision** |

### 9.2 Files added and modified

**Created (source):** `server/src/services/breeth/index.js` (334 lines) — the isolated client: config gating, secret stripping, bounded HTTP (explicit `AbortController` + `setTimeout` timeout, never `AbortSignal.timeout`), episode shaping, `searchMemory`, and failure mapping. This is the **only place in the codebase** that builds an `Authorization` header or speaks to `api.thebreeth.com`.

**Created (tests):** 22 tests across `server/test/breeth/service.test.js` (12) and `server/test/breeth/integration.test.js` (10).

**Modified — three files, nothing else:**

- `server/src/config/env.js` — a guarded `breeth` config block (every field defaulted, so an absent block cannot fail startup), warning-only validation (never a hard startup error), and a `breethEnabled: Boolean(...)` boolean in `publicConfig()`. The block is **force-disabled under the test runner** via `!process.env.NODE_TEST_CONTEXT && bool(...)` — the automated suite can never contact the real Breeth API, whatever a local `.env` says (this guard exists because a developer's `.env` with a real key once made the suite hit the live API; the lesson is encoded, not remembered).
- `server/src/services/agent/runCycle.js` (now 442 lines) — `breeth: breethService` added to `DEFAULT_SERVICES` (DI, so the default config makes it a no-op), a `recordStrategicMemory` helper, and one call site right after `recordDeferredCandidate(...)`. `result` gains a `breeth` field that is **never** folded into `failed`, **never** added to `errors`, and **never** written to Agent state by the worker.
- `.env.example` — exactly three new keys (§9.6), with `BREETH_API_KEY=` left empty.

### 9.3 Breeth capabilities actually used

Two capabilities, exactly two endpoints from the officially documented contract (`docs.thebreeth.com`), verified before any HTTP code was written:

1. **Episode recording** — `POST /v1/episodes` with `{content, group_id, source_description, extract_intent}` and `Authorization: Bearer <key>`. One episode per cycle, recording the strategic decision as a prose sentence naming the persona, the event, and the topic. Four event types exist (`published`, `deferred`, `repetition_skip`, `generation_failed`); `extract_intent` is metered, so it is off unless opted in and reserved for an actual publish.
2. **Search API availability** — `POST /v1/search` is implemented in the service and covered by tests, returning the graph edges' `fact` fields as a plain array.

**Search is implemented but intentionally NOT used in the autonomous decision path.** No function anywhere in the pipeline calls `searchMemory()`. It exists as retrieval for a human or for a future phase; today the agent never consults Breeth when deciding. Nothing in this phase claims otherwise.

### 9.4 Failure isolation

Every Breeth failure mode — disabled, unkeyed, timeout, 401, 403, 429, 500, malformed JSON, network error — resolves to the value `{ok:false, available:false, errorCode}` instead of throwing. Because a failed Breeth write leaves `result.failed` `false` and `result.errors` `[]`, it can **never** reach the worker's `consecutiveFailures` counter and **never** triggers scheduler exponential backoff (§8.3). Publishing completes, MongoDB memory recording completes, and the post lands on the feed. A second try/catch inside `recordStrategicMemory` contains even a client that throws (pinned by test).

### 9.5 Security and key handling

- The key lives **only** in the server-side `Authorization` header; it is never in the URL, the body, a result, or a log line (each pinned by test).
- Input is scrubbed **by construction** before any payload is built — URIs, bearer fragments, `key/token/password` assignments, `ck_/sk_/pk_`-prefixed tokens, and long opaque strings are all stripped — so a credential cannot reach a Breeth payload even if a future caller passed one in.
- Breeth failure logs carry the provider's error **slug only** (`internal_error`, `quota_exceeded`, …), never provider prose, never the header, never a request body.
- `publicConfig()` exposes a single boolean; the key never leaves the server. Zero Breeth references in `client/` and zero in `routes/`.
- Live-key scan: the real key from a developer's `.env` appears in **0 tracked files**.

### 9.6 Environment variables

| variable | default | notes |
|---|---|---|
| `BREETH_ENABLED` | `false` | the master switch; also force-disabled under the test runner |
| `BREETH_API_KEY` | (empty) | server-side only; needs read + write scope; admin scope not used |
| `BREETH_TIMEOUT_MS` | `3000` | kept short so an optional write never stalls a cycle |

Implementation-only (defaulted, not in `.env.example`): `BREETH_BASE_URL` → `https://api.thebreeth.com`, `BREETH_GROUP_ID` → `autonomous-ai-creator`, `BREETH_EXTRACT_INTENT` → `false`.

### 9.7 Testing results (verified, not estimated)

**609 passing, 0 failing** (~43 s) — the 587-test Phase 12 baseline plus the 22 new Breeth tests, with **zero regressions**. Target re-runs: scheduler 38/38, memory 52/52, breeth 22/22, config 13/13, agent 8/8. `--test-concurrency=1` remains required.

The seven required cases are all pinned: disabled → zero network requests; missing key → unavailable without a request; successful episode against the mocked verified contract; timeout → abandoned and reported, never thrown; 500 → rejected with slug only (plus a 401/403/429 table); secret safety; LLM budget unchanged.

**The LLM budget is unchanged — still 0 / 1 / 2, asserted against `provider.calls.length`:**

| cycle shape | LLM calls | Breeth episodes |
|---|---|---|
| all candidates `BLOCKED` | **0** | none — `result.breeth === null` |
| editorial skip | **1** | one `deferred` |
| publish | **2** | one `published` |

### 9.8 Current limitation (known, accepted)

**Breeth is not yet consulted by the agent when making decisions.** `searchMemory()` exists and is tested, but nothing calls it: no gate, no relevance input, no repetition hint. MongoDB's `BLOCKED` verdict wins even if Breeth's graph suggests the topic is fresh — "Mongo says BLOCKED → BLOCKED" is a tested invariant, and a Breeth failure can never un-block a topic. Consulting Breeth in the decision path is deliberately left for a future phase; this phase only established the optional write path and the failure isolation.

### 9.9 Enabling Breeth safely (demo procedure)

1. Set the three keys in the **server** environment (never in the client, never committed): `BREETH_ENABLED=true`, `BREETH_API_KEY=<key>` (read + write scope), and the default `BREETH_TIMEOUT_MS=3000` is fine.
2. Restart the server. Verify `publicConfig()` reports `breethEnabled: true` and that the log shows the guard line if it is off.
3. Run one cycle. The activity log should show `Recorded a strategic memory in Breeth {"event":"published","episodeName":"ep_...","entities":N,"edges":M}`; confirm the episode in the Breeth app.
4. To demo the failure isolation, point `BREETH_BASE_URL` at a dead host and run a cycle: the post still publishes, `failed` stays `false`, no backoff, one sanitized warning in the log.
5. Turn it off with `BREETH_ENABLED=false` when the demo is over — the agent runs identically either way.

## 10. Files added and modified in Phase 12

**Created (source):**

| file | lines | role |
|---|---|---|
| `server/src/services/agent/runCycle.js` | 362 (now 442 after Phase 12.5) | one cycle: WHAT |
| `server/src/scheduler/worker.js` | 345 | `CycleWorker` + `calculateBackoffDelay`: WHEN |
| `server/src/scheduler/index.js` | 205 | worker registry + `get/setScheduler`: WHICH |
| `server/src/utils/agentEvents.js` | 48 | leaf event seam (see §8.5) |

**Created (tests) — 46 new tests, 1068 lines:**

| file | lines | tests |
|---|---|---|
| `server/test/agent/runCycle.test.js` | 190 | 8 |
| `server/test/scheduler/worker.test.js` | 447 | 17 |
| `server/test/scheduler/index.test.js` | 297 | 14 |
| `server/test/scheduler/wiring.test.js` | 134 | 7 |

**Modified — three files, nothing else:**

- `server/src/config/env.js` — `maxBackoffMs: num(process.env.AGENT_MAX_BACKOFF_MS, 30 * 60 * 1000)` added to `config.agent` (line 74) plus validation requiring an integer ≥ 1000 (line 236 after Phase 12.5 inserted the `breeth` block above it). The validation is **guarded** with `if (cfg.agent && cfg.agent.maxBackoffMs !== undefined)` because `test/config.test.js`'s `makeConfig` fixture omits the field.
- `server/src/bootstrap.js` — scheduler start after `listen`, teardown inside the existing `shutdown`, `scheduler` added to the return value.
- `server/src/routes/agent.js` — one `notifyAgentInitialized(agent.agentId)` call in `POST /init` wrapped in try/catch, and the router doc comment updated from "deliberately inert" to note that it hands the agent to the scheduler but still never calls the LLM and never creates a post.

Phases 1–11 were **not** rewritten. No test was weakened or deleted.

## 11. Testing results for Phase 12 (verified, not estimated)

Command, run from `server/`:

```bash
npm test
```

which is `node --test --test-concurrency=1 --test-timeout=60000 "test/**/*.test.js"`.

**Result: 587 passing, 0 failing** (~54 s). That is the 541-test pre-existing baseline plus the 46 new Phase 12 tests, with **zero regressions** — no earlier test was modified, weakened, or skipped to make Phase 12 pass.

`--test-concurrency=1` is required: several suites share an ephemeral MongoDB instance and would collide if run in parallel.

What the 46 new tests actually pin:

- **`runCycle.test.js` (8)** — the 2-LLM-call budget on a publishing cycle; **0 calls** when every candidate is `BLOCKED`; `DISCOURAGED` still publishes; an editorial skip costs exactly 1 call and writes one `deferred` row; a generation failure; a publisher throw; a paused agent short-circuits; a null agent throws `CycleInputError`.
- **`worker.test.js` (17)** — the backoff truth table as a pure function (including clamping and `NaN`-proofing); immediate first cycle; idempotent `start()`; **no overlap** (`maxConcurrent === 1`); a throwing `runCycle` and a throwing tick body both survive; exponential progression then reset on success; exactly one Agent update with zero deltas omitted; sanitized and length-capped `lastError`; paused and vanished agents self-stop with no write and no orphan timer; a reload failure backs off without a stat write; `stop()` halts the loop.
- **`index.test.js` (14)** — dormancy (register arms nothing before `start()`); idempotent register; recreation of a self-stopped worker; `resumeAll` stagger and count, including one end-to-end run with a **real** `CycleWorker` on a fake clock; a `findResumable` failure degrading to zero agents; `stopAll` tolerance of a throwing worker; the module accessor.
- **`wiring.test.js` (7)** — the event seam is empty by default; install/clear; init announces the new agentId; a repeat init announces again (the scheduler dedupes); a throwing handler never fails the request; with nothing listening the route is inert and returns exactly `{agentId}`; bootstrap's handler shape registers exactly one worker and does not restart a running loop.

Manual smoke scripts (`server/src/scripts/smoke-*.js`) still exist for Phases 1–11 and were not modified. **No Phase 12 smoke script was added** — the scheduler's behavior is time-dependent, and the fake-clock suite exercises it more precisely than a wall-clock script could.

## 12. Environment variables

| variable | default | notes |
|---|---|---|
| `PORT` | `5000` | |
| `NODE_ENV` | `development` | `production` tightens validation |
| `MONGODB_URI` | — | required unless the ephemeral DB is opted into |
| `USE_EPHEMERAL_DB` | `false` | **local testing only**; validation forbids it in production |
| `DNS_SERVERS` | — | needed on networks whose stub resolver refuses SRV lookups for `mongodb+srv://` |
| `CORS_ORIGIN` | `http://localhost:5173` | comma-separated list |
| `LLM_PROVIDER` | `gemini` | `gemini` or `mock` |
| `LLM_API_KEY` | — | required when the provider is `gemini` |
| `LLM_MODEL` | `gemini-3.5-flash` | Google retires ids; a 404 here means the model, not the key |
| `AGENT_MODE` | `demo` | `demo` or `production`; **this alone sets the cadence** |
| **`AGENT_MAX_BACKOFF_MS`** | **`1800000`** (30 min) | **new in Phase 12.** Backoff ceiling; validated as an integer ≥ 1000 |
| `EDITORIAL_MAX_CANDIDATES` | `8` | hard ceiling still lives in `candidates.js` |
| `EDITORIAL_MIN_CONFIDENCE` | `0.7` | below this, a publish decision is overridden to skip |
| `EDITORIAL_ALLOW_SKIP` | `true` | an editor that cannot decline is not exercising judgement |
| `MEMORY_*` | see `env.js` | `REJECTION_WINDOW_DAYS` 14, `SIMILARITY_WINDOW_DAYS` 30, `SIMILARITY_THRESHOLD` 0.6, `RECENT_LIMIT` 50, `RECENT_DAYS` 30 |
| **`BREETH_ENABLED`** | **`false`** | **new in Phase 12.5.** Optional strategic memory (§9); also force-disabled under the test runner |
| **`BREETH_API_KEY`** | **(empty)** | **new in Phase 12.5.** Server-side only; never committed, never exposed to client |
| **`BREETH_TIMEOUT_MS`** | **`3000`** | **new in Phase 12.5.** How long one Breeth request may take before it is abandoned |

**There is no `AGENT_CYCLE_INTERVAL_MS` variable.** `config.agent.cycleIntervalMs` is derived from `AGENT_MODE`: `demo` → **45 s**, `production` → **6 hours**. Same pipeline in both modes; only the cadence differs. `AGENT_MAX_BACKOFF_MS` is the only env-tunable timing knob Phase 12 added, and it is **not** listed in `.env.example` — see §14 item 9.

## 13. Exact git state

Branch **`main`**. Phases 11 and 12 were committed as `a2aa515` after the Phase 12 rewrite of this file. Captured with `git status --short` after Phase 12.5:

```
 M .env.example
 M server/src/config/env.js
 M server/src/services/agent/runCycle.js
?? server/src/services/breeth/
?? server/test/breeth/
```

Plus this file, `PROJECT_HANDOFF.md`, which is itself untracked.

Last three commits:

```
a2aa515 Complete Phase 11 memory and Phase 12 autonomous agent
ac4e65a feat: improve autonomous content workflow
42a81f6 Initial Phase
```

Read this carefully before committing:

- **Phase 12.5 is entirely uncommitted.** The five entries above are exactly and only the Breeth work; nothing else is in flight. No `.env` is tracked (`.gitignore:7` covers it), and only `.env.example` files — with an empty `BREETH_API_KEY=` — are committed.
- **Phases 11 and 12 are now committed together** in `a2aa515`. The tangle described in the Phase 12 handoff was resolved by committing both at once rather than splitting `env.js`'s diff.
- The commit message `ac4e65a` "improve autonomous content workflow" predates the autonomous loop; the loop arrived in Phase 12 and is in `a2aa515`.

## 14. Known limitations and loose ends

Real, verified, and **deliberately not fixed** in this phase — Phase 12 was scoped to the loop, and the instruction was not to modify application logic while writing this handoff.

**Dead and stale code from the dependency inversion:**

1. **`getScheduler()` has no production consumer.** `bootstrap.js` calls `setScheduler(scheduler)` and `setScheduler(null)`, but nothing ever reads `getScheduler()` — the route reaches the scheduler through the `agentEvents` seam instead (§8.5). The accessor is still exported and still covered by a test. Either give it a consumer or delete the pair.
2. **`server/src/scheduler/index.js` lines 21–25 carry a stale doc comment** claiming "the route calls `getScheduler()?.register(...)`". The dependency inversion made that untrue. The comment describes a design that was abandoned before the phase shipped; a reader trusting it would look for an import that the architectural guard forbids.
3. **`.gitkeep` still sits in `server/src/scheduler/` and `server/src/services/agent/`**, both of which now hold real code. Phase 11 deleted `services/memory/.gitkeep` when it filled that directory; these two were missed. Cosmetic, but it makes the tree inconsistent with its own convention.

**Behavioral gaps:**

4. **A paused agent's worker parks itself permanently.** `runCycle` returns `OUTCOME.PAUSED` and the worker calls `stop()` — correct, since spinning a timer for an agent that will do nothing is waste. But **there is no resume endpoint**: nothing in the API can set `status` back to `autonomous`, and nothing calls `scheduler.register()` for an existing agent. A paused agent therefore stays stopped until the process restarts and `resumeAll()` picks it up (and it will only be picked up if its status is `autonomous`, `initializing`, or `error`). A pause/resume API is un-built.
5. **`'removed'` is not a real status.** `runCycle`'s `INACTIVE_STATUSES` is `{'paused', 'removed'}`, but the `Agent` model's enum is `['initializing', 'autonomous', 'paused', 'error']` — **no `'removed'`**. The guard is harmless and forward-looking, but today it is unreachable. Either add the status or drop it from the set.
6. **`POST /api/agent/init` re-announces on every call**, including repeat inits for an existing persona. Nothing breaks — `register()`'s idempotency is what prevents a rival loop, and a test pins exactly that — but the correctness of the endpoint depends on the scheduler's behavior rather than on the route's.
7. **No cycle history is retained.** The Agent document holds cumulative counters, `lastCycleAt`, `nextCycleAt`, and a single `lastError`. There is no per-cycle audit trail, so "why did the agent skip the last four cycles" is unanswerable after the fact. The Phase 14 dashboard may want one.
8. **A single-process assumption.** The scheduler is in-memory: two server instances against the same database would each resume every agent and run duplicate cycles. Nothing takes a lock or a lease. The `TopicMemory` unique index would prevent duplicate *posts* on the same topic, but not duplicate LLM spend.
9. **`AGENT_MAX_BACKOFF_MS` is absent from `.env.example`**, so the one knob Phase 12 added is undiscoverable from the template. `validateConfig`'s check is also guarded with `!== undefined` to accommodate `test/config.test.js`'s partial `makeConfig` fixture — meaning a config object that omits the field entirely passes validation.
10. **No Phase 12 smoke script.** Every earlier phase has one under `server/src/scripts/`. The fake-clock suite covers the loop far more precisely, but there is no way to watch a real agent cycle against a real provider from the command line short of booting the server.
11. **`server/src/controllers/` is still an empty `.gitkeep` directory.** Route logic lives in `routes/`. Unused since Phase 1.
12. **No lint or typecheck.** `server/package.json` has only `start`, `dev`, `test`. Nothing enforces style or catches a typo in an unexercised branch.
13. **The client is still the Phase 1 health-check shell.** `client/src/App.jsx` and the README both still say "Phase 1 of 21" — stale copy. The dashboard is Phase 14.
14. **Breeth retrieval is implemented but unused (Phase 12.5).** `searchMemory()` works and is tested, but no code path calls it — the agent does not consult Breeth when deciding (§9.8). Wiring it in would be a real behavioral change and needs its own phase, since anything that reads Breeth before a decision must not become a soft dependency.
15. **`server/src/services/breeth/.gitkeep` was never created**, so unlike `scheduler/` and `services/agent/` (item 3) this directory is consistent. Noted only so the inconsistency in item 3 is not read as a convention.

## 15. Where to pick up

**Phase 12 is complete and verified: 587/587 tests passing after Phase 12.** The agent runs autonomously after a single `POST /api/agent/init`, with no human prompting.

**Phase 12.5 is complete and verified: 609/609 tests passing (587 baseline + 22 Breeth), zero regressions.** Breeth strategic memory is wired in as an optional, non-authoritative layer. MongoDB remains the source of truth for all decisions, and a Breeth outage can never fail a cycle.

**Phase 13 has NOT been started, per the build discipline: stop after each phase and wait for go-ahead.**

Before Phase 13, whoever picks this up should decide on the loose ends in §14: items 1–3 are five minutes of cleanup and remove code that actively misleads a reader; items 4–5 are small behavioral decisions (a resume path, and whether `'removed'` becomes a real status) that Phase 13 might otherwise have to guess at.

Standing constraints that still apply: do not expose or modify secrets; keep the ≤2-LLM-calls-per-cycle budget intact; one phase at a time.
