/**
 * Fixtures for the Phase 10B publisher tests.
 *
 * The publisher persists an already-verified FinalPost, so the tests must feed
 * it a genuine one — not a hand-shaped object. buildFinalPost() runs the real
 * verifyGeneratedPost() over the real generation output, exactly as the Phase 10
 * generator does, so a test that passes here is evidence about the true runtime
 * shape. The publishing `context` mirrors what the orchestrator will hand the
 * publisher: the agent, and the Phase 9 editorial decision the post was written
 * from (topic and rationale live there, never on the FinalPost).
 */
import { Agent } from '../../src/models/index.js';
import { verifyGeneratedPost } from '../../src/services/generation/index.js';
import { CANDIDATE, validGeneration, publishDecisionResult } from './generation.js';

export { CANDIDATE, validGeneration, publishDecisionResult };

/**
 * A verified FinalPost, assembled the way the generator assembles it: the mock
 * writer's output run through the real verifier against the real candidate.
 *
 * @param {object} [options]
 * @param {object} [options.candidate] the story whose URL is the only allowed source
 * @param {string} [options.platform] 'linkedin' (default) or 'twitter'
 * @param {object} [options.generation] raw model output to verify (defaults to validGeneration)
 * @param {object} [options.overrides] shallow-merged over the verified FinalPost (for negative cases)
 */
export function buildFinalPost({
  candidate = CANDIDATE,
  platform = 'linkedin',
  generation,
  overrides = {},
} = {}) {
  const output = generation ?? validGeneration({ candidate });
  const finalPost = verifyGeneratedPost(output, { candidate, platform });
  return { ...finalPost, ...overrides };
}

/**
 * A publishing context in the shape the orchestrator will pass. Supply either
 * `agentId` (a string — exercises the agent-existence check) or `agent` (a full
 * document — skips the check on the hot path). The decision defaults to a real
 * publish decision carrying the candidate, so topic and rationale resolve from
 * it just as they will at runtime.
 *
 * @param {object} [options]
 * @param {string} [options.agentId]
 * @param {object} [options.agent]
 * @param {object} [options.decision] a Phase 9 decision result (defaults to publishDecisionResult)
 * @param {object} [options.overrides] merged over the produced context
 */
export function buildContext({ agentId, agent, decision, overrides = {} } = {}) {
  return {
    ...(agent ? { agent } : {}),
    ...(agentId ? { agentId } : {}),
    decision: decision ?? publishDecisionResult(),
    cycleId: 'c_publish_0001',
    ...overrides,
  };
}

/**
 * Create a real Agent so the publisher's existence check passes. Pass distinct
 * name/domain when a test needs two agents (personaKey is unique).
 */
export function seedAgent({ name = 'Sentinel', domain = 'AI Security', ...rest } = {}) {
  return Agent.create({ persona: { name, domain }, ...rest });
}
