/**
 * Fixtures for the Phase 11 memory + repetition tests.
 *
 * Reuses the Phase 10B publisher fixtures so a "published" topic in these tests
 * is persisted through the real publisher (proving the memory service reads the
 * same rows the publisher writes), and adds a small, deterministic family of
 * topic strings with known token overlap for the similarity cases.
 */
import { TopicMemory } from '../../src/models/index.js';
import { normalizeTopic } from '../../src/utils/text.js';
import { seedAgent, buildFinalPost, buildContext, CANDIDATE } from './publisher.js';

export { seedAgent, buildFinalPost, buildContext, CANDIDATE };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The normalized key of the published fixture topic, for direct assertions. */
export const PUBLISHED_NORMALIZED = normalizeTopic(CANDIDATE.title);

/**
 * A family of topics with known relationships to CANDIDATE.title:
 *   - reordered: identical token multiset -> identical normalized key (exact)
 *   - similar:   drops one token, adds none -> high overlap (fuzzy match)
 *   - unrelated: disjoint tokens -> no match
 */
export const TOPICS = {
  // Same words as CANDIDATE.title, reversed. normalizeTopic sorts tokens, so the
  // key is identical — this is an *exact* repetition, not merely a similar one.
  reordered: CANDIDATE.title.split(/\s+/).reverse().join(' '),
  // Same subject minus the word "Prompt": 9 of the 10 content tokens overlap.
  similar: 'Injection via indirect tool output bypasses the agent sandbox in production frameworks',
  // Nothing in common.
  unrelated: 'A friendly guide to brewing better espresso at home',
};

/** The prompt's illustrative similarity pair (Step 4C). */
export const PROMPT_EXAMPLE = {
  a: 'Prompt injection attacks against AI browsers',
  similar: 'AI browser prompt injection attacks',
  unrelated: 'How browsers improve AI productivity',
};

/** Two topics sharing exactly two of three tokens — a borderline pair used to
 *  prove the similarity threshold is honoured (matched only when lowered). */
export const BORDERLINE = {
  seeded: 'Kubernetes autoscaling patterns',
  probe: 'Kubernetes autoscaling failures',
};

/**
 * Insert a memory row directly (bypassing the service under test), optionally
 * backdated. createdAt is set through the raw driver so Mongoose's timestamp
 * handling cannot re-stamp it to now.
 *
 * @returns {Promise<import('mongoose').Document>}
 */
export async function seedMemory(agentId, {
  topic,
  decision = 'rejected',
  reason = 'Seeded for a memory test.',
  rejectionCategory = decision === 'rejected' ? 'low_novelty' : null,
  keywords = [],
  sourceUrls = [],
  score = null,
  cycleId = null,
  postId = null,
  ageDays = 0,
} = {}) {
  const doc = await TopicMemory.create({
    agentId, topic, decision, reason, rejectionCategory, keywords, sourceUrls, score, cycleId, postId,
  });
  if (ageDays > 0) {
    const backdated = new Date(Date.now() - ageDays * DAY_MS);
    await TopicMemory.collection.updateOne({ _id: doc._id }, { $set: { createdAt: backdated } });
  }
  return doc;
}

/** Publish CANDIDATE for an agent through the real publisher path. */
export async function publishCandidate(agentId, overrides = {}) {
  const { publishFinalPost } = await import('../../src/services/publisher/index.js');
  return publishFinalPost(buildFinalPost(), buildContext({ agentId, ...overrides }));
}
