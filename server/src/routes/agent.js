import { Router } from 'express';
import { Agent, CycleRun, Post, TopicMemory, personaKeyFor } from '../models/index.js';
import { getRecentMemory, MemoryInputError } from '../services/memory/index.js';
import { notifyAgentInitialized } from '../utils/agentEvents.js';
import { badRequest, notFound } from '../utils/errors.js';
import { logger, recentActivity } from '../utils/logger.js';
import {
  parseActivityQuery,
  parseAgentId,
  parseAgentListQuery,
  parseCycleQuery,
  parseFeedPaging,
  parseInitBody,
  parseMemoryQuery,
} from './validators.js';

const log = logger('API');

/** 404 unless the agent exists, so a typo is never mistaken for empty data. */
async function requireAgent(agentId) {
  const agent = await Agent.findOne({ agentId });
  if (!agent) {
    throw notFound('agent_not_found', 'No agent exists with that agentId. Call POST /api/agent/init first.');
  }
  return agent;
}

/**
 * Public agent API: the endpoints the dashboard and init flow rely on.
 *
 * Still inert with respect to content: these handlers read and write MongoDB and
 * hand the agent to the scheduler, but they never call the LLM, never fetch an
 * external source, and never create a post. All content creation happens in the
 * autonomous worker's own cycle, so the feed stays a pure read of what the agent
 * already decided to publish and POST /init returns immediately.
 *
 * Express 5 forwards rejected promises to the error handler in app.js, so
 * handlers can throw validation errors directly.
 */
export function agentRouter() {
  const router = Router();

  /**
   * POST /api/agent/init
   * Body:     { "persona": { "name": "Ada", "domain": "AI Security" } }
   * Response: { "agentId": "agt_…" }
   *
   * Idempotent by persona: calling it repeatedly is safe and returns the same
   * agentId (201 on first creation, 200 thereafter) rather than spawning a
   * second agent whose feed would compete with the first.
   */
  router.post('/init', async (req, res) => {
    const persona = parseInitBody(req.body);
    const personaKey = personaKeyFor(persona.name, persona.domain);

    let agent = await Agent.findOne({ personaKey });
    let created = false;

    if (!agent) {
      try {
        agent = await Agent.create({ persona });
        created = true;
      } catch (err) {
        // Lost a race with a concurrent identical init; the unique index is the
        // arbiter, so adopt the agent the winner created.
        if (err.code === 11000) {
          agent = await Agent.findOne({ personaKey });
        }
        if (!agent) throw err;
      }
    }

    log.info(created ? 'Agent initialized' : 'Agent init reused existing agent', {
      agentId: agent.agentId,
      persona: `${agent.persona.name} / ${agent.persona.domain}`,
      status: agent.status,
    });

    // Announce the agent so the autonomous scheduler can begin its cycles. The
    // route deliberately does not import the scheduler — it notifies a leaf
    // event module, and bootstrap wires that to scheduler.register — so the HTTP
    // layer keeps no dependency on the worker or the LLM stack. Registration is
    // idempotent on the scheduler's side, so a repeat init never starts a second
    // loop. With nothing listening (every test that does not boot a server) this
    // is a no-op, which keeps the endpoint inert and instant. A failure here
    // must never fail the request: the agent is persisted, and resumeAll() would
    // pick it up on the next restart regardless.
    try {
      notifyAgentInitialized(agent.agentId);
    } catch (err) {
      log.error('Could not hand the agent to the autonomous scheduler', {
        agentId: agent.agentId, code: err?.code,
      });
    }

    // Exactly the contract shape. Status distinguishes create from reuse.
    res.status(created ? 201 : 200).json({ agentId: agent.agentId });
  });

  /**
   * GET /api/agent/feed?agentId=agt_…
   * Response: { "posts": [ { id, createdAt, text, rationale, sources } ] }
   *
   * Newest first. An existing agent with nothing published returns
   * { "posts": [] }; an agentId that was never initialized is a 404, so a
   * mistyped id is distinguishable from a genuinely empty feed.
   */
  router.get('/feed', async (req, res) => {
    const agentId = parseAgentId(req.query.agentId);
    const { limit, before } = parseFeedPaging(req.query);

    const exists = await Agent.exists({ agentId });
    if (!exists) {
      throw notFound('agent_not_found', 'No agent exists with that agentId. Call POST /api/agent/init first.');
    }

    const posts = await Post.feedFor(agentId, { limit, before });

    // toFeedJSON is the single source of truth for the response shape.
    res.json({ posts: posts.map((post) => post.toFeedJSON()) });
  });

  /**
   * GET /api/agent
   * Response: { "agents": [ …toPublicJSON() ] }
   *
   * Newest first, so a dashboard that opens with no agentId can pick the most
   * recently initialized agent without guessing. Reuses toPublicJSON, so this
   * endpoint can never expose a field the agent contract does not already allow.
   */
  router.get('/', async (req, res) => {
    const { limit } = parseAgentListQuery(req.query);
    const agents = await Agent.find().sort({ createdAt: -1 }).limit(limit);
    res.json({ agents: agents.map((agent) => agent.toPublicJSON()) });
  });

  /**
   * GET /api/agent/:agentId
   * Response: { "agent": {…}, "counts": {…} }
   *
   * The agent's own persisted state plus the two collection counts the dashboard
   * would otherwise have to derive by downloading every row. `stats` on the agent
   * is the worker's cumulative tally; `counts` is what is on disk right now, and
   * the two are reported separately rather than reconciled here.
   *
   * `lastError` is added alongside rather than inside toPublicJSON, so the list
   * endpoint's shape stays untouched. It is safe to expose: the worker builds that
   * message solely from sanitized {stage, code} tokens, never from a raw provider
   * error that could carry a URI or a key.
   */
  router.get('/:agentId', async (req, res) => {
    const agentId = parseAgentId(req.params.agentId);
    const agent = await requireAgent(agentId);

    const [posts, memories] = await Promise.all([
      Post.countDocuments({ agentId }),
      TopicMemory.countDocuments({ agentId }),
    ]);

    const lastError = agent.lastError?.message
      ? {
          message: agent.lastError.message,
          at: agent.lastError.at ? agent.lastError.at.toISOString() : null,
        }
      : null;

    res.json({ agent: agent.toPublicJSON(), counts: { posts, memories }, lastError });
  });

  /**
   * GET /api/agent/:agentId/activity?limit=&scope=agent|all
   * Response: { "scope", "persistent": false, "events": [ {ts, level, tag, message, agentId?, data?} ] }
   *
   * A read of the logger's in-memory ring buffer — the same entries the worker
   * writes as it runs, already scrubbed of anything matching the logger's secret
   * pattern. Process-local and wiped on restart, which the response states
   * outright via `persistent: false` so the UI can say so rather than implying
   * the history is durable.
   */
  router.get('/:agentId/activity', async (req, res) => {
    const agentId = parseAgentId(req.params.agentId);
    const { limit, scope } = parseActivityQuery(req.query);
    await requireAgent(agentId);

    // scope=all keeps the agent filter off so untagged system events (startup,
    // source fetches, scheduler ticks) are visible too.
    const events = recentActivity(scope === 'all' ? { limit } : { agentId, limit });

    res.json({ scope, persistent: false, events });
  });

  /**
   * GET /api/agent/:agentId/memory?limit=&days=&decision=
   * Response: { "memory": [ …toMemoryView() ], "totals": {…} }
   *
   * Delegates entirely to the Phase 11 memory service: getRecentMemory owns the
   * clamping, the ordering, and the compact view, so this route adds no query of
   * its own and cannot drift from what the agent itself reads. `totals` groups the
   * agent's full decision history by outcome, which is the evidence that the agent
   * rejects topics rather than publishing everything it finds.
   */
  router.get('/:agentId/memory', async (req, res) => {
    const agentId = parseAgentId(req.params.agentId);
    const { limit, days, decision } = parseMemoryQuery(req.query);
    await requireAgent(agentId);

    let memory;
    try {
      memory = await getRecentMemory(agentId, { limit, days, decision });
    } catch (err) {
      // An unknown ?decision= is a client mistake, not a server fault; the memory
      // service already validated it against its own enum.
      if (err instanceof MemoryInputError) {
        throw badRequest(`memory_${err.code}`, err.message);
      }
      throw err;
    }

    const grouped = await TopicMemory.aggregate([
      { $match: { agentId } },
      { $group: { _id: '$decision', count: { $sum: 1 } } },
    ]);
    const totals = { published: 0, rejected: 0, deferred: 0 };
    for (const row of grouped) {
      if (row._id in totals) totals[row._id] = row.count;
    }

    res.json({ memory, totals });
  });

  /**
   * GET /api/agent/:agentId/cycles?limit=&before=
   * Response: { "data": [ …toPublicJSON() ], "pagination": { limit, hasMore, nextCursor } }
   *
   * The agent's persistent execution history: one row per cycle, newest first,
   * surviving the restarts that clear the activity buffer. This is the durable
   * counterpart to /activity, and the difference between them is not cosmetic —
   * a row here is an aggregate (counts, timings, the decision, the outcome), not
   * a trace. It cannot tell you what happened *inside* a cycle, and nothing
   * downstream may present it as though it could.
   *
   * Always scoped to the requested agent: the query filters on agentId and the
   * agent must exist, so an unknown id is a 404 rather than an empty page, and no
   * page can carry another agent's cycles. toPublicJSON is the only shape, and it
   * has no field for a prompt, an article body, a provider payload or a key.
   */
  router.get('/:agentId/cycles', async (req, res) => {
    const agentId = parseAgentId(req.params.agentId);
    const { limit, before } = parseCycleQuery(req.query);
    await requireAgent(agentId);

    // Fetch one more than asked for: whether that extra row exists is the answer
    // to hasMore, without a second count query over a collection that only grows.
    const rows = await CycleRun.historyFor(agentId, { limit: limit + 1, before });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const oldest = page[page.length - 1];

    res.json({
      data: page.map((row) => row.toPublicJSON()),
      pagination: {
        limit,
        hasMore,
        // Only offered when there is genuinely another page, so a client can
        // stop on nextCursor === null instead of re-requesting the end forever.
        nextCursor: hasMore && oldest?.startedAt ? oldest.startedAt.toISOString() : null,
      },
    });
  });

  return router;
}
