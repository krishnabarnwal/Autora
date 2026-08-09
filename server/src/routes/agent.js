import { Router } from 'express';
import { Agent, Post, personaKeyFor } from '../models/index.js';
import { notifyAgentInitialized } from '../utils/agentEvents.js';
import { notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { parseAgentId, parseFeedPaging, parseInitBody } from './validators.js';

const log = logger('API');

/**
 * Public agent API: the two endpoints named in the problem statement.
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

  return router;
}
