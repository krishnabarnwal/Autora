/**
 * Topic discovery pipeline (Phase 6 + 7).
 *
 * collectTopics -> filterTopics -> deduplicateTopics -> rankCandidates
 *
 * The whole pipeline is deterministic after collection and makes no LLM call:
 * roughly a hundred raw articles become the five to ten candidates that Phase 9
 * will spend a single editorial call on. Nothing here touches Express or the
 * feed API, so the scheduler, a script, and the tests all drive it identically.
 */
import { logger } from '../../utils/logger.js';
import { collectTopics } from '../sources/index.js';
import { filterTopics, DEFAULT_MAX_AGE_MS, DEFAULT_MIN_RELEVANCE } from './filter.js';
import { deduplicateTopics } from './dedupe.js';
import { rankCandidates } from './rank.js';
import { buildPersonaProfile } from './relevance.js';

const log = logger('TOPICS');

export const DEFAULT_CANDIDATE_LIMIT = 8;

/**
 * The persona the agent runs as unless POST /api/agent/init says otherwise.
 * A default, not a hard-coding: every stage reads the persona it is given.
 */
export const SENTINEL_PERSONA = {
  name: 'Sentinel',
  domain: 'AI Security',
  identity:
    'An autonomous AI security researcher tracking how AI systems break and how they are defended.',
  voice: 'Precise, evidence-led, and plain-spoken. Explains the mechanism, not just the headline.',
  interests: [
    'prompt injection',
    'LLM vulnerabilities',
    'agent security',
    'model security',
    'AI infrastructure security',
  ],
  editorialStandards: [
    'no speculation without sources',
    'name the mechanism, not just the incident',
    'skip vendor marketing dressed as research',
  ],
};

/**
 * The candidate contract handed to Phase 9. Deliberately small: the editorial
 * call pays per token, so scoring internals stay out of the prompt.
 */
export function toCandidate(item) {
  return {
    title: item.title,
    url: item.url,
    summary: item.summary,
    publishedAt: item.publishedAt,
    source: item.source,
    score: item.score,
    relevance: item.relevance,
    corroboration: item.corroboration ?? 1,
    sources: item.corroboratedBy || [item.source],
    normalizedTopic: item.normalizedTopic,
  };
}

/**
 * Run the full discovery pipeline.
 *
 * @param {{
 *   persona?: object, agentId?: string, limit?: number, now?: number,
 *   maxAgeMs?: number, minRelevance?: number, requireDate?: boolean,
 *   similarityThreshold?: number, maxPerSource?: number,
 *   items?: object[], sources?: object[], only?: string[], exclude?: string[],
 *   timeoutMs?: number, concurrency?: number, perSourceLimit?: number, fetchImpl?: Function
 * }} options `items` skips collection, which is how the tests stay offline.
 * @returns {Promise<{candidates: object[], items: object[], stats: object, rejected: object[], duplicates: object[], sourceResults: object[]}>}
 */
export async function discoverTopics(options = {}) {
  const {
    persona = SENTINEL_PERSONA,
    agentId,
    limit = DEFAULT_CANDIDATE_LIMIT,
    now = Date.now(),
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    minRelevance = DEFAULT_MIN_RELEVANCE,
    requireDate = false,
    similarityThreshold,
    maxPerSource,
    items,
  } = options;

  const profile = buildPersonaProfile(persona);

  let collected = items;
  let sourceResults = [];
  let collectionStats = null;

  if (!collected) {
    const collection = await collectTopics({ ...options, now, agentId });
    collected = collection.items;
    sourceResults = collection.results;
    collectionStats = collection.stats;
  }

  const filtered = filterTopics(collected, { profile, now, maxAgeMs, minRelevance, requireDate });
  log.info(`Filtered ${filtered.stats.received} items to ${filtered.stats.kept}`, {
    agentId, ...filtered.stats,
  });

  const deduped = deduplicateTopics(filtered.kept, { similarityThreshold });
  log.info(`Deduplicated ${deduped.stats.received} items to ${deduped.stats.unique}`, {
    agentId, ...deduped.stats,
  });

  const ranked = rankCandidates(deduped.unique, { limit, now, maxPerSource });
  const candidates = ranked.map(toCandidate);

  log.info(`Selected ${candidates.length} candidates`, {
    agentId,
    persona: persona.name,
    domain: persona.domain,
    topScore: candidates[0]?.score ?? null,
    topics: candidates.map((candidate) => candidate.title),
  });

  if (!candidates.length) {
    log.warn('No candidates survived local filtering; the cycle will publish nothing', {
      agentId,
      collected: collected.length,
      rejected: filtered.stats.rejected,
    });
  }

  return {
    candidates,
    items: ranked,
    rejected: filtered.rejected,
    duplicates: deduped.duplicates,
    sourceResults,
    stats: {
      collection: collectionStats,
      collected: collected.length,
      filter: filtered.stats,
      dedupe: deduped.stats,
      candidates: candidates.length,
      llmCalls: 0,
    },
  };
}

export { collectTopics } from '../sources/index.js';
export { filterTopics, assessQuality, TIER_QUALITY, DEFAULT_MAX_AGE_MS, DEFAULT_MIN_RELEVANCE } from './filter.js';
export { deduplicateTopics, DEFAULT_SIMILARITY_THRESHOLD } from './dedupe.js';
export { rankCandidates, scoreCandidate, freshnessScore, WEIGHTS } from './rank.js';
export { buildPersonaProfile, scoreRelevance, CONCEPTS } from './relevance.js';
