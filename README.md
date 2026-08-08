# Autonomous AI Creator

An autonomous AI persona that discovers technology topics from live sources, decides on its own
whether each one is worth publishing, writes it up in a consistent editorial voice, and remembers
what it already said — all on a background schedule, with no human prompting after initialization.

Reference persona: **Sentinel**, an AI security researcher. The architecture accepts any persona
supplied through `POST /api/agent/init`.

> Build status: Phase 1 of 21 complete (project scaffold). Full documentation lands in Phase 21.

## How it works

```
LIVE SOURCES -> COLLECTOR -> LOCAL FILTER -> DEDUPE -> CANDIDATES
    -> AI EDITORIAL JUDGE -> SELECTED TOPIC -> AI WRITING
    -> MEMORY CHECK -> VALIDATION -> MONGODB -> FEED API -> DASHBOARD
```

Cheap local processing runs first so the LLM is only asked to do the work that needs judgment.
A typical cycle narrows ~100 discovered articles to ~5 candidates, then spends roughly two LLM
calls: one editorial decision, one piece of writing.

The scheduler is what makes the agent autonomous. `POST /api/agent/init` registers a persona and
activates a background worker; nothing else has to be called. The feed endpoint only reads what
the worker has already stored — it never generates content on request.

## Requirements

- Node.js 20+ (developed on 25.7)
- A MongoDB connection string (MongoDB Atlas free tier is fine)
- An API key for the runtime LLM (Gemini by default)

Neither the database nor the LLM key is needed to run the Phase 1 scaffold.

## Setup

```bash
npm run install:all
```

Then create your local env file from the template and fill in real values:

```bash
cp .env.example server/.env
```

`server/.env` is gitignored. Never commit real keys.

| Variable       | Purpose                                                       |
| -------------- | ------------------------------------------------------------- |
| `MONGODB_URI`  | MongoDB connection string. Empty falls back to ephemeral dev DB |
| `LLM_PROVIDER` | `gemini` or `mock`                                            |
| `LLM_API_KEY`  | API key for the selected provider                             |
| `LLM_MODEL`    | Model id, e.g. `gemini-3.5-flash`                             |
| `AGENT_MODE`   | `demo` or `production` — see below                             |
| `PORT`         | Backend port, default `5000`                                  |
| `CORS_ORIGIN`  | Comma-separated allowed browser origins                       |

## Running locally

Two terminals:

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

## Agent modes

Both modes run the **same** autonomous pipeline against the same live sources. Only the cadence
differs — demo mode does not fabricate posts.

| `AGENT_MODE` | Cycle interval | Use                                    |
| ------------ | -------------- | -------------------------------------- |
| `demo`       | ~45 seconds    | Live demonstrations                    |
| `production` | ~6 hours       | The 48-hour evaluation window          |

## API contract

`POST /api/agent/init`

```json
{ "persona": { "name": "Ada", "domain": "AI Security" } }
```

Returns `{ "agentId": "abc-123" }`.

`GET /api/agent/feed?agentId=abc-123`

Returns `{ "posts": [...] }` — newest first, unique ids, ISO 8601 UTC timestamps, and a
`rationale` plus `sources` on every post. An agent with no posts yet returns `{ "posts": [] }`.

## Project layout

```
server/
  src/
    config/       env loading and redacted public config
    controllers/  request handlers
    routes/       express routers
    models/       mongoose schemas (agent, post, topic memory)
    services/
      llm/        provider abstraction (gemini, mock)
      sources/    live source adapters, normalized output
      agent/      the autonomous pipeline
      memory/     topic recall and repetition detection
    scheduler/    background worker, independent of HTTP
    utils/        logger with activity buffer
    app.js        express app factory
    server.js     process bootstrap and signal handling
  test/           node:test suites
client/
  src/
    components/   dashboard UI pieces
    pages/        dashboard views
    hooks/        polling and countdown hooks
    services/     API client
```

## Tests

```bash
npm test
```

Uses the built-in `node:test` runner — no extra test framework dependency.
