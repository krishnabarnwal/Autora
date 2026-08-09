# Autonomous AI Creator

**Problem Statement 3 — Autonomous AI Content Creator**

An autonomous AI persona that discovers technology topics from live sources, decides on its own
whether each one is worth publishing, writes it up in a consistent editorial voice, and remembers
what it already said — all on a background schedule, with no human prompting after initialization.

Reference persona: **Sentinel**, an AI security researcher. The architecture accepts any persona
supplied through `POST /api/agent/init`.

---

## What it does

You call `POST /api/agent/init` once with a persona. Nothing else is ever called. From that moment
a background worker runs the agent on its own schedule, and each cycle it:

1. **Discovers** — fetches ~23 live RSS/Atom/JSON sources concurrently (security blogs, vendor
   advisories, arXiv, Hacker News). A failing source is logged and skipped, never fatal.
2. **Filters and deduplicates locally** — drops stale, low-quality, and off-domain items, then
   removes duplicates by URL, title, and topic similarity. All deterministic, zero LLM cost.
   A typical cycle narrows ~2,500 raw items to ~8 candidates.
3. **Checks memory** — topics it already published are `BLOCKED` and dropped *before* any model
   call. Recently rejected topics are `DISCOURAGED` — still judged, just weighted down.
4. **Decides** (1 LLM call) — the model is shown the surviving candidates and the persona's
   editorial standards and answers: publish this one, or publish nothing. **Choosing to publish
   nothing is a legitimate outcome**, recorded as a deferral, not treated as an error.
5. **Writes** (1 LLM call, only if it decided to publish) — generates the post, which is validated
   against a schema before anything is stored.
6. **Publishes** — writes to MongoDB behind a uniqueness index, so the same topic cannot be
   published twice even under concurrency.
7. **Remembers** — records the decision (published / deferred / rejected) so the next cycle
   behaves differently, and optionally mirrors a strategic episode into Breeth.

`GET /api/agent/feed` only ever *reads* what the worker already stored. It never generates content
on request — the autonomy is real, not lazily triggered by the reader.

```
LIVE SOURCES -> COLLECTOR -> LOCAL FILTER -> DEDUPE -> SCORING -> CANDIDATES
    -> MEMORY GATE -> AI EDITORIAL JUDGE -> SELECTED TOPIC -> AI WRITING
    -> VALIDATION -> MONGODB -> FEED API -> DASHBOARD
```

## Main features

- **Genuinely autonomous scheduler** — a per-agent background worker independent of HTTP. It
  resumes agents on restart with a stagger, refuses overlapping cycles for the same agent, and
  applies exponential backoff (capped at 30 min) on real failures.
- **A hard LLM budget of 0, 1, or 2 calls per cycle** — the expensive step is reached only after
  the cheap deterministic work has done everything it can. A memory-blocked cycle costs zero.
- **The agent can decline to publish** — quality gate, not a content treadmill. Skips are recorded
  and shape later cycles.
- **Persistent topic memory** — MongoDB is the authoritative record for duplicate prevention and
  repetition detection.
- **Optional Breeth strategic memory** — cross-cycle recall layered on top. Disabled, unkeyed, or
  unreachable, the agent behaves exactly as it did before the feature existed: it can never fail a
  cycle, trigger backoff, block publishing, or override a deterministic decision.
- **Fail-safe by construction** — `runCycle` never throws at the scheduler; every failure comes
  back as a structured result. A quota 429 degrades the cycle into a skip rather than failing it.
- **Live dashboard** — pipeline visualization, agent state, recent activity, memory, and real
  usage stats.
- **Config that fails loudly** — production without `MONGODB_URI` refuses to start, an ephemeral
  database is rejected outright in production, and an unparseable cycle interval is a startup
  error rather than a silent fallback.
- **642 tests**, all passing, on the built-in `node:test` runner.

## Tech stack

| Layer      | Choice                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| Runtime    | Node.js 20+ (developed on 25.x), ES modules                            |
| Backend    | Express 5.1                                                            |
| Database   | MongoDB via Mongoose 9.9 (MongoDB Atlas)                               |
| LLM        | Google Gemini via the REST API — called directly with `fetch`, no SDK  |
| Frontend   | React 19.2 + Vite 8.2 + Tailwind CSS 4.3                               |
| Tests      | Built-in `node:test` + `mongodb-memory-server` (no test framework dep) |
| Extra      | Breeth (optional strategic memory), plain `fetch` for all HTTP         |

Server production dependencies are only `cors`, `dotenv`, `express`, and `mongoose`. The client
ships only `react` and `react-dom`. No LLM SDK, no HTTP client library, no router.

## Requirements

- Node.js 20+
- A MongoDB connection string (MongoDB Atlas free tier is fine)
- A Google Gemini API key (or run with `LLM_PROVIDER=mock`)

## Local setup

```bash
npm run install:all
```

Create your local env file from the template and fill in real values:

```bash
cp .env.example server/.env
```

`server/.env` is gitignored. Never commit real keys.

Then run the two processes in separate terminals:

```bash
npm run dev:server
```

```bash
npm run dev:client
```

- API: http://localhost:5000
- Dashboard: http://localhost:5173

The Vite dev server proxies `/api` to the backend, so no CORS setup is needed locally.

Check the backend directly:

```bash
curl http://localhost:5000/api/health
```

Start the agent (this is the only call you ever have to make):

```bash
curl -X POST http://localhost:5000/api/agent/init -H "Content-Type: application/json" -d "{\"persona\":{\"name\":\"Sentinel\",\"domain\":\"AI Security\"}}"
```

## Environment variables

Names and placeholders only — see [.env.example](.env.example) for the annotated template.
Never commit real values.

| Variable                  | Required | Purpose                                                                     |
| ------------------------- | -------- | --------------------------------------------------------------------------- |
| `MONGODB_URI`             | yes (prod) | MongoDB connection string. Required in production; startup fails without it |
| `USE_EPHEMERAL_DB`        | no       | Local-testing escape hatch only. Rejected in production                     |
| `DNS_SERVERS`             | no       | Comma-separated resolvers, only if your network cannot answer `mongodb+srv` SRV lookups |
| `LLM_PROVIDER`            | no       | `gemini` or `mock` (default `gemini`)                                        |
| `LLM_API_KEY`             | yes      | API key for the selected provider. Fatal in production if unset with `gemini` |
| `LLM_MODEL`               | no       | Model id, e.g. `gemini-3.6-flash`                                            |
| `AGENT_MODE`              | no       | `demo` or `production` — cadence only, same pipeline                         |
| `AGENT_CYCLE_INTERVAL_MS` | no       | Explicit cycle cadence in ms, overriding the mode default. See below         |
| `AGENT_MAX_BACKOFF_MS`    | no       | Ceiling for failure backoff (default 30 minutes)                             |
| `BREETH_ENABLED`          | no       | Enables the optional strategic-memory layer                                  |
| `BREETH_API_KEY`          | no       | Server-side only. Never exposed to the client                                |
| `BREETH_TIMEOUT_MS`       | no       | Breeth request timeout (default `3000`)                                      |
| `PORT`                    | no       | Backend port (default `5000`)                                                |
| `NODE_ENV`                | no       | `development` or `production`                                                |
| `CORS_ORIGIN`             | no       | Comma-separated allowed browser origins                                      |
| `VITE_API_BASE_URL`       | no       | Client-side. Deployed backend origin; leave empty locally                    |

## Agent modes and cadence

Both modes run the **same** autonomous pipeline against the same live sources. Only the cadence
differs — demo mode does not fabricate posts.

| `AGENT_MODE` | Default cycle interval | Use                           |
| ------------ | ---------------------- | ----------------------------- |
| `demo`       | ~45 seconds            | Live demonstrations           |
| `production` | ~6 hours               | The 48-hour evaluation window |

`AGENT_CYCLE_INTERVAL_MS` overrides either default. It exists because the mode defaults are tuned
for visibility, not for provider quota: at 45 seconds the agent asks for ~1,920 editorial calls a
day, while a free-tier Gemini key allows 20 per model per day. Rough guide:
`86,400,000 / your daily call allowance` — about `4320000` (72 minutes) for a 20/day tier. The
value must be a positive integer of at least `1000`; an unparseable value is a startup error, never
a silent fall back to 45 seconds.

## API contract

`POST /api/agent/init`

```json
{ "persona": { "name": "Ada", "domain": "AI Security" } }
```

Returns `{ "agentId": "agt_..." }`. Idempotent per persona — the database, not the handler, is the
arbiter, so concurrent inits cannot both win.

`GET /api/agent/feed?agentId=agt_...`

Returns `{ "posts": [...] }` — newest first, unique ids, ISO 8601 UTC timestamps, and a `rationale`
plus `sources` on every post. An agent with no posts yet returns `{ "posts": [] }`.

Read-only dashboard endpoints:

| Endpoint                        | Returns                                     |
| ------------------------------- | ------------------------------------------- |
| `GET /api/health`               | Liveness + database ping + redacted config  |
| `GET /api/agent`                | All agents                                  |
| `GET /api/agent/:agentId`       | One agent's state and stats                 |
| `GET /api/agent/:agentId/activity` | Recent cycle activity                    |
| `GET /api/agent/:agentId/memory`   | Topic memory rows                        |

## Deployment

The backend and frontend deploy as two separate services.

**Backend** (Render, Railway, Fly.io, or any Node host):

- Root directory: `server`
- Build command: `npm install`
- Start command: `npm start` (runs `node src/server.js`)
- Health check path: `/api/health` — returns `503` when the database is unusable, so the host can
  distinguish "process alive" from "actually able to serve"
- Required environment variables: `MONGODB_URI`, `LLM_API_KEY`, `NODE_ENV=production`,
  `AGENT_MODE=production`, and `CORS_ORIGIN` set to the deployed frontend origin.
  Optionally `LLM_MODEL`, `AGENT_CYCLE_INTERVAL_MS`, and the `BREETH_*` variables.
- MongoDB Atlas: allow the host's outbound IPs (or `0.0.0.0/0` for a free-tier demo) in Network
  Access, or the connection will hang rather than fail clearly.
- The scheduler starts with the process and resumes existing agents automatically — do **not**
  deploy more than one always-on instance, or agents would cycle twice.

**Frontend** (Vercel, Netlify, or any static host):

- Root directory: `client`
- Build command: `npm run build`
- Output directory: `dist`
- Environment variable: `VITE_API_BASE_URL` = the deployed backend origin (e.g.
  `https://your-api.onrender.com`). It is baked in at build time, so set it before building.

After both are live, set `CORS_ORIGIN` on the backend to the frontend URL, redeploy the backend,
then call `POST /api/agent/init` once against the deployed API to start the autonomous loop.

## Project layout

```
server/
  src/
    config/       env loading, validation, redacted public config
    controllers/  request handlers
    routes/       express routers
    models/       mongoose schemas (agent, post, topic memory)
    services/
      llm/        provider abstraction (gemini, mock), retry, usage tracking
      sources/    live source adapters, normalized output
      topics/     filtering, dedupe, scoring, candidate selection
      editorial/  the publish-or-skip decision
      generation/ post writing and schema validation
      publisher/  the guarded write to MongoDB
      memory/     topic recall and repetition detection
      breeth/     optional strategic memory (isolated, never fatal)
      agent/      runCycle — the composed autonomous cycle
    scheduler/    background worker and lifecycle, independent of HTTP
    utils/        logger with activity buffer, agent events
    app.js        express app factory
    server.js     process bootstrap and signal handling
  test/           node:test suites
client/
  src/
    components/   dashboard UI pieces
    hooks/        polling hooks
    lib/          formatting helpers
    services/     API client
```

## Tests

```bash
npm test
```

642 tests on the built-in `node:test` runner against an in-memory MongoDB — no extra test
framework dependency, no network calls, no quota spent.

## Documentation

- [PROMPTS.md](PROMPTS.md) — the major AI prompts used to build this project
- [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md) — detailed architecture and phase-by-phase build record
- [.env.example](.env.example) — annotated environment template
