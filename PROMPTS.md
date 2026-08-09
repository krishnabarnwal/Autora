# PROMPTS.md

A record of the major AI prompts used to build the Autonomous AI Creator.

This project was built with **Claude (Opus)** in an agentic coding workflow. The prompts below
are the ones that actually shaped the codebase — the phase briefs, the constraints that were
repeated every time, and the debugging prompts that changed the design. They are reproduced in
substance rather than verbatim transcript, and are grouped by what they were for.

**No API keys, secret values, credentials, connection strings, or private conversation content
appear in this file.** Where a prompt referenced a secret, the secret is described by its
variable name only.

---

## 1. Ground rules given up front (repeated in nearly every prompt)

These were restated on almost every task, because they are the constraints that kept the build
coherent across 12+ phases:

- **Phase discipline.** "Build one phase, verify it, report what you did, then stop and wait for
  my go-ahead. Do not start the next phase on your own."
- **No unrequested scope.** "Do not add features, refactor unrelated code, or change the
  autonomous pipeline unless I asked for it."
- **No new dependencies.** "Do not introduce a new dependency" — the server ships with only
  `cors`, `dotenv`, `express`, `mongoose` (plus `mongodb-memory-server` for tests). No LLM SDK,
  no HTTP client, no test framework, no router library.
- **Secrets never enter the codebase.** "Never hard-code a key, never print or log it, never put
  it in an error message or an auth header you echo back, never expose it through an API
  response or the dashboard, never commit `.env`. Do not ask me to paste a key into chat or into
  source code."
- **Git safety.** "Do not run `git reset --hard` or `git clean -fd`. Do not discard existing
  changes."
- **The database must be real.** "MongoDB must be genuinely persistent. An ephemeral in-memory
  database is a local-testing opt-in only — never a silent fallback, and never in production."
- **Tests are part of the deliverable.** "Every phase ships with tests using the built-in
  `node:test` runner. Report real pass/fail counts, not estimates."

---

## 2. Framing prompt — what the system had to be

> Build an **Autonomous AI Creator** for Problem Statement 3: an AI persona that operates on its
> own schedule with no human prompting after initialization. It must discover real topics from
> live sources, decide for itself whether anything is worth publishing, write the piece in a
> consistent editorial voice, remember what it has already covered so it does not repeat itself,
> and store everything in MongoDB. `POST /api/agent/init` starts it; `GET /api/agent/feed` only
> reads what the background worker already produced — the feed endpoint must never generate
> content on request.

Follow-up constraint that drove most of the architecture:

> The LLM is the expensive part. Do the cheap deterministic work first — collect, filter,
> deduplicate, score — and only ask the model for the two things that genuinely need judgment:
> one editorial decision and one piece of writing. A cycle costs **0, 1, or 2 LLM calls** and
> never more. A cycle that is blocked by memory must cost **zero**.

---

## 3. Phase prompts (the build sequence)

Each was issued as its own brief, with the phase-discipline rule attached.

**Phases 1–2 — scaffold and configuration.**
> Set up the monorepo (`server/`, `client/`), the health endpoint, and a config module that
> validates the environment at startup. Startup must *fail loudly* on a bad configuration rather
> than degrade quietly: production without `MONGODB_URI` must refuse to start, and
> `USE_EPHEMERAL_DB` must be rejected outright in production.

**Phases 3–5 — live sources and topic processing.**
> Write source adapters that fetch real feeds and normalize them into one shape. One failing
> source must never fail the cycle. Then filter locally for staleness, quality, and domain
> relevance, deduplicate by URL / title / topic similarity, and score the survivors — all
> deterministic, no LLM.

**Phases 6–8 — LLM provider abstraction.**
> Write a provider interface with two implementations: a Gemini adapter calling the REST API
> directly with `fetch` (no SDK), and a scriptable mock for tests. Include retry with backoff,
> a usage tracker, and strict JSON parsing that treats a malformed model response as a handled
> failure rather than a crash.

**Phase 9 — editorial decision (1 LLM call).**
> Give the model the candidate set and the persona's editorial standards and let it decide:
> publish this one, or publish nothing. **Skipping is a legitimate outcome**, not an error. If
> the editorial call fails for any reason — including a quota 429 — the cycle degrades into a
> skip; it must not fail and must not trigger backoff.

**Phase 10 / 10B — generation and publishing.**
> One call produces the post. Validate the result against the schema before anything is written.
> Publishing is a separate step with a uniqueness guarantee: the same topic must not be
> published twice, and the database index — not the handler — is the arbiter.

**Phase 11 — memory (0 LLM calls).**
> Add topic memory with three states: `BLOCKED` (already published — dropped before any LLM
> call), `DISCOURAGED` (recently rejected — still judged, just weighted down), and clear.
> Discouraged is a soft signal, not a veto. Every decision, including deferrals, is recorded.

**Phase 12 — the autonomous loop.**
> Compose the phases into `runCycle`, then build a scheduler that runs it per agent on an
> interval, with exponential backoff on real failures, stagger on resume, and no overlapping
> cycles for the same agent. `runCycle` must never throw at the scheduler: every failure is a
> returned result with `failed` and structured `errors`.

**Phase 12.5 — Breeth strategic memory (optional layer).**
> Add cross-cycle strategic recall through Breeth, injected as a dependency. Hard requirement:
> **MongoDB remains the authoritative memory.** Breeth must never fail a cycle, never trigger
> backoff, never prevent publishing, never prevent the MongoDB write, and never override a
> deterministic decision. Disabled, unkeyed, or unreachable, the agent must behave exactly as it
> did before the feature existed. The key is server-side only, read from `BREETH_API_KEY`.

**Phase 12.6 — dashboard.**
> Add read-only endpoints for agent state, activity, and memory, and a single-page React
> dashboard that visualizes the pipeline and the agent's live decisions. No router, no new
> dependency, no write operations from the UI.

---

## 4. Debugging prompts that changed the code

These were investigation prompts, and each produced a real fix.

**MongoDB Atlas would not connect locally.**
> The connection fails with `querySrv ECONNREFUSED` on `mongodb+srv://`. Before assuming the
> credentials are wrong, work out whether this is DNS. Do not print the connection string.

Outcome: the local stub resolver refuses SRV lookups. Added an optional `DNS_SERVERS` variable
rather than changing the URI scheme or weakening the connection logic.

**Gemini quota exhaustion during demos.**
> Diagnose why the agent stops publishing after about fifteen minutes in demo mode. Distinguish
> between "the key is invalid", "the model id is retired", and "the daily quota for this model
> is spent" — an HTTP 429 naming `GenerateRequestsPerDayPerProjectPerModel-FreeTier` is the
> third, not the first.

Outcome: at a 45-second cadence the agent asks for ~1,920 editorial calls a day against a
free-tier allowance of 20 per model per day. Added `AGENT_CYCLE_INTERVAL_MS` as an explicit
cadence override, with the mode defaults preserved exactly. An unparseable value is a startup
error, deliberately **not** a silent fall back to 45 seconds — falling back would recreate the
exact problem the variable exists to prevent.

**The dashboard reported zero LLM calls.**
> Fix the real `stats.llmCalls` metric so it counts actual Gemini provider calls instead of
> relying on the mock provider's `.calls` array. Do not invent a second usage-tracking system.
> Be careful about whether the count means *logical* LLM calls or *physical* HTTP attempts
> including retries — use the project's existing semantics and document the chosen meaning in
> code and tests.

Outcome: the metric was read off `provider.calls.length`, a test seam only the mock has; against
real Gemini it was `undefined`, so every production cycle reported zero. The count is now taken
from what the editorial and generation services report. The documented semantics: `llmCalls` is
**logical calls** (a retried 429 is one call), and `llmAttempts` stays separately visible as
transport attempts.

---

## 5. Review and hardening prompts

Used repeatedly rather than once:

- "Re-read the service contracts before you implement against them. Do not assume a shape."
- "Where is this failure surfaced? Show me that a failing X cannot take down the cycle."
- "Scan the diff for anything secret-shaped before I commit."
- "Run the full suite and give me the actual numbers."
- "This is a real problem with the approach — say so in a sentence, then build it as specified
  and tell me what you assumed."

## 6. Submission prompt

> Final submission mode. Do not add features, refactor, or change the autonomous pipeline. Run
> `git status --short` and `git diff --check`, run the frontend production build and the backend
> test suite, verify that `.env` files and secrets are ignored and will not be committed, write
> `PROMPTS.md` (no keys, no secret values, no private chat data), check the README covers the
> project name, Problem Statement 3, what the agent does, features, tech stack, local setup,
> environment variable **names and placeholders only**, and deployment. Do not create fake or
> demo database records. Do not push yet.
