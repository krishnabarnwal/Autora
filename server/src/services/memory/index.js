/**
 * Phase 11 — topic memory + repetition detection.
 *
 * A deterministic, database-backed read/advisory layer over TopicMemory (and, for
 * the published-idempotency signal, Post). It answers the questions an autonomous
 * agent must ask before spending an editorial call or a publish on a topic:
 *
 *   1. Has this agent already published this topic?          -> already_published
 *   2. Has it rejected this topic recently?                  -> recently_rejected
 *   3. Has it already covered a highly similar topic?        -> similar_recent_topic
 *   4. Otherwise                                             -> allowed
 *
 * What this layer must never do, by construction (asserted by security.test.js):
 *   - call the LLM (no provider, no prompt, no generateJSON)
 *   - fetch a source or collect feeds
 *   - import the publisher (a memory -> publisher -> memory cycle) or generation
 *
 * MongoDB is the only external dependency. Every judgement is a pure function of
 * stored rows and the injected clock/thresholds, so the same history always
 * yields the same answer.
 *
 * Boundary with the publisher (Phase 10B): the publisher remains the sole author
 * of *published* persistence (the Post and its published TopicMemory row). This
 * service records only the audit decisions — 'rejected' and 'deferred' — and
 * refuses 'published' with a clear error, so there is exactly one code path that
 * writes a published row and no duplicated idempotency logic.
 *
 * Advisory, not authoritative. checkRepetition() reflects what was written before
 * it ran; two concurrent checks for a brand-new topic can both return 'allowed'.
 * The Post's unique (agentId, normalizedTopic) index — not this service — is the
 * final guarantee that only one post per topic is ever stored. See
 * concurrency.test.js.
 */
import { Post, TopicMemory, TOPIC_DECISIONS, REJECTION_REASONS } from '../../models/index.js';
import { normalizeTopic, jaccardSimilarity, containment, sharedTokenCount } from '../../utils/text.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/env.js';

const log = logger('MEMORY');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Hard ceiling on any memory page, so retrieval is never unbounded. */
const MAX_RECENT_LIMIT = 200;
/** Containment path defaults, mirrored from Phase 7 dedupe for cross-phase consistency. */
const DEFAULT_CONTAINMENT_THRESHOLD = 0.7;
const DEFAULT_MIN_SHARED_TOKENS = 3;

/** Coarse action a caller branches on. Ordered most-to-least constraining. */
export const REPETITION_STATUS = {
  /** Exact topic already published — the DB unique index would reject a duplicate too. */
  BLOCKED: 'blocked',
  /** Heuristic or recent-rejection match — publishing is inadvisable but not forbidden. */
  DISCOURAGED: 'discouraged',
  /** No prior coverage found within the configured windows. */
  ALLOWED: 'allowed',
};

/** Why a candidate was flagged. null when allowed. */
export const REPETITION_REASON = {
  ALREADY_PUBLISHED: 'already_published',
  RECENTLY_REJECTED: 'recently_rejected',
  SIMILAR_RECENT_TOPIC: 'similar_recent_topic',
};

/**
 * A caller/validation error: the input was unfit and nothing was read or written.
 * Thrown (not returned) so a bug surfaces loudly, mirroring the publisher.
 */
export class MemoryInputError extends Error {
  constructor(message, code, details = []) {
    super(message);
    this.name = 'MemoryInputError';
    this.code = code;
    this.details = details;
  }
}

/**
 * An unexpected persistence failure. Its message is fixed and safe — never a raw
 * driver string, which can carry host/topology detail. The code is what a caller
 * branches on.
 */
export class MemoryError extends Error {
  constructor(message, code = 'memory_failed', details = []) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    this.details = details;
  }
}
// --- Internal helpers --------------------------------------------------------

/** A non-empty agentId, or a thrown input error. */
function requireAgentId(agentId) {
  const id = String(agentId ?? '').trim();
  if (!id) throw new MemoryInputError('An agentId is required.', 'missing_agent');
  return id;
}

/**
 * Resolve a raw topic string or a candidate object down to {topic, normalizedTopic}.
 *
 * Accepts a plain string, `{title}` (the Phase 7 candidate shape) or `{topic}`.
 * normalizeTopic is idempotent — normalizing an already-normalized key returns
 * itself — so passing either a headline or a stored normalizedTopic is safe.
 *
 * @throws {MemoryInputError} when there is no usable topic text or it normalizes
 *   to nothing indexable (e.g. only stopwords/punctuation).
 */
function resolveTopic(input, { field = 'candidate' } = {}) {
  if (input == null || (typeof input !== 'string' && typeof input !== 'object')) {
    throw new MemoryInputError(`A ${field} with a topic is required.`, 'invalid_candidate', [field]);
  }
  const topic = typeof input === 'string'
    ? input.trim()
    : String(input.topic ?? input.title ?? '').trim();
  if (!topic) {
    throw new MemoryInputError('A topic (or candidate.title) is required.', 'missing_topic', [field]);
  }
  const normalizedTopic = normalizeTopic(topic);
  if (!normalizedTopic) {
    throw new MemoryInputError(
      'The topic has no indexable content after normalization.',
      'missing_normalized_topic',
      [topic]
    );
  }
  return { topic, normalizedTopic };
}

/** Token set for similarity: the sorted-token normalized key, split to words. */
function topicTokens(normalizedTopic) {
  return normalizedTopic ? normalizedTopic.split(' ') : [];
}

/**
 * Are two topics "essentially the same"? Same rule shape as Phase 7 dedupe:
 * broad token agreement (Jaccard), or the shorter set almost entirely contained
 * in the longer one (catches singular/plural and an extra qualifier word).
 * Pure token math — no LLM. Returns the match verdict and the score to report.
 */
function scoreSimilarity(aTokens, bTokens, { similarityThreshold, containmentThreshold, minSharedTokens }) {
  const jaccard = jaccardSimilarity(aTokens, bTokens);
  const cover = containment(aTokens, bTokens);
  const shared = sharedTokenCount(aTokens, bTokens);
  const matched = jaccard >= similarityThreshold
    || (shared >= minSharedTokens && cover >= containmentThreshold);
  // Report the stronger of the two signals so a containment-only hit is not
  // described by a misleadingly low Jaccard.
  const similarity = Math.round(Math.max(jaccard, matched ? cover : jaccard) * 1000) / 1000;
  return { matched, similarity };
}

/**
 * Compact, bounded projection of a memory row — the only shape this service
 * hands back. Never a full Post or a raw Mongoose document, so callers cannot
 * accidentally depend on internal fields or leak them.
 */
export function toMemoryView(row) {
  if (!row) return null;
  const createdAt = row.createdAt instanceof Date
    ? row.createdAt.toISOString()
    : (row.createdAt ?? null);
  return {
    normalizedTopic: row.normalizedTopic ?? null,
    topic: row.topic ?? null,
    decision: row.decision ?? null,
    score: row.score ?? null,
    rejectionCategory: row.rejectionCategory ?? null,
    postId: row.postId ?? null,
    cycleId: row.cycleId ?? null,
    sources: Array.isArray(row.sourceUrls) ? [...row.sourceUrls]
      : (Array.isArray(row.sources) ? [...row.sources] : []),
    createdAt,
  };
}

/** Wrap an unexpected driver error as a safe MemoryError, logging only {name, code}. */
function persistenceFailure(err, action) {
  log.error(`Memory ${action} failed`, { name: err?.name, code: err?.code });
  return new MemoryError('A memory operation could not be completed.', 'memory_failed');
}
// --- Public API --------------------------------------------------------------

/**
 * The agent's most recent decision on one exact topic, or null.
 *
 * The second argument may be a raw headline or an already-normalized key —
 * normalizeTopic is idempotent, so both resolve to the same lookup. Returns a
 * compact view (never a raw document).
 *
 * @param {string} agentId
 * @param {string|object} topic a topic string, or `{title}` / `{topic}`
 * @returns {Promise<object|null>}
 * @throws {MemoryInputError}
 */
export async function getTopicMemory(agentId, topic) {
  const id = requireAgentId(agentId);
  const { normalizedTopic } = resolveTopic(topic, { field: 'topic' });
  try {
    const row = await TopicMemory.findOne({ agentId: id, normalizedTopic })
      .sort({ createdAt: -1, _id: -1 })
      .lean();
    return toMemoryView(row);
  } catch (err) {
    throw persistenceFailure(err, 'lookup');
  }
}

/**
 * A bounded, newest-first window of this agent's decisions.
 *
 * Agent-scoped, capped at MAX_RECENT_LIMIT no matter what the caller asks, and
 * optionally narrowed to a time window or a single decision kind. Deterministic
 * ordering (createdAt desc, then _id desc as a stable tie-break). Returns compact
 * views only — no unbounded collection scan and no raw documents.
 *
 * @param {string} agentId
 * @param {{limit?: number, days?: number, decision?: string, now?: number}} [options]
 * @returns {Promise<object[]>}
 * @throws {MemoryInputError}
 */
export async function getRecentMemory(agentId, options = {}) {
  const id = requireAgentId(agentId);
  const {
    limit = config.memory.recentLimit,
    days = config.memory.recentDays,
    decision,
    now = Date.now(),
  } = options;

  if (decision !== undefined && !TOPIC_DECISIONS.includes(decision)) {
    throw new MemoryInputError(
      `decision must be one of ${TOPIC_DECISIONS.join(', ')}.`,
      'invalid_decision',
      [String(decision)]
    );
  }

  // Clamp into [1, MAX_RECENT_LIMIT] so a caller can neither disable the bound
  // nor request a non-positive page.
  const capped = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : MAX_RECENT_LIMIT, MAX_RECENT_LIMIT));

  const query = { agentId: id };
  if (decision) query.decision = decision;
  if (Number.isFinite(days) && days > 0) {
    query.createdAt = { $gte: new Date(now - days * DAY_MS) };
  }

  try {
    const rows = await TopicMemory.find(query)
      .select('topic normalizedTopic decision score rejectionCategory postId cycleId sourceUrls createdAt')
      .sort({ createdAt: -1, _id: -1 })
      .limit(capped)
      .lean();
    return rows.map(toMemoryView);
  } catch (err) {
    throw persistenceFailure(err, 'retrieval');
  }
}
/** Shape a checkRepetition result so every branch returns the same fields. */
function repetitionResult({ status, reason, normalizedTopic, similarity = 0, matched = null, windowDays, threshold }) {
  return {
    status,
    reason,
    repeated: status !== REPETITION_STATUS.ALLOWED,
    normalizedTopic,
    similarity,
    matchedMemory: matched ? toMemoryView(matched) : null,
    windowDays,
    threshold,
  };
}

/**
 * Decide whether a candidate repeats prior work, and how strongly.
 *
 * Policy, evaluated most-constraining first:
 *   1. already_published (BLOCKED)   — an exact-normalized-topic Post or published
 *      memory exists. This is the one hard outcome: the Post's unique index would
 *      reject a duplicate anyway. Post is consulted directly so the brief
 *      crash-reconcile window (post stored, memory not yet) is still caught.
 *   2. recently_rejected (DISCOURAGED) — the exact topic was rejected/deferred
 *      within rejectionWindowDays. Older rejections fall out of the window.
 *   3. similar_recent_topic (DISCOURAGED) — a topic within similarityWindowDays
 *      scores above the similarity threshold. Heuristic, hence never BLOCKED; the
 *      matched memory's own decision is exposed so a caller can weigh it.
 *   4. allowed — none of the above.
 *
 * No LLM call and no network. Everything is a function of stored rows plus the
 * injected clock/thresholds.
 *
 * @param {string} agentId
 * @param {string|object} candidate a topic string, or a Phase 7 candidate `{title,...}`
 * @param {{
 *   now?: number, rejectionWindowDays?: number, similarityWindowDays?: number,
 *   similarityThreshold?: number, containmentThreshold?: number, minSharedTokens?: number,
 *   similarityScanLimit?: number,
 * }} [options]
 * @returns {Promise<{status:string, reason:string|null, repeated:boolean, normalizedTopic:string, similarity:number, matchedMemory:object|null, windowDays:number, threshold:number}>}
 * @throws {MemoryInputError}
 */
export async function checkRepetition(agentId, candidate, options = {}) {
  const id = requireAgentId(agentId);
  const { normalizedTopic } = resolveTopic(candidate, { field: 'candidate' });

  const {
    now = Date.now(),
    rejectionWindowDays = config.memory.rejectionWindowDays,
    similarityWindowDays = config.memory.similarityWindowDays,
    similarityThreshold = config.memory.similarityThreshold,
    containmentThreshold = DEFAULT_CONTAINMENT_THRESHOLD,
    minSharedTokens = DEFAULT_MIN_SHARED_TOKENS,
    similarityScanLimit = MAX_RECENT_LIMIT,
  } = options;

  try {
    // 1. Already published — exact topic. Prefer the published memory row (it
    //    carries editorial metadata); fall back to the Post, which is the true
    //    feed record and the ultimate published guarantee.
    const publishedMemory = await TopicMemory.findOne({ agentId: id, normalizedTopic, decision: 'published' }).lean();
    const matchedPublished = publishedMemory
      ?? await Post.findOne({ agentId: id, normalizedTopic })
        .select('topic normalizedTopic postId sources createdAt')
        .lean()
        .then((post) => (post ? { ...post, decision: 'published', sourceUrls: post.sources } : null));

    if (matchedPublished) {
      return repetitionResult({
        status: REPETITION_STATUS.BLOCKED,
        reason: REPETITION_REASON.ALREADY_PUBLISHED,
        normalizedTopic,
        similarity: 1,
        matched: matchedPublished,
        windowDays: null,
        threshold: similarityThreshold,
      });
    }

    // 2. Recently rejected — exact topic within the rejection window.
    const rejectedSince = new Date(now - rejectionWindowDays * DAY_MS);
    const recentRejection = await TopicMemory.findOne({
      agentId: id,
      normalizedTopic,
      decision: { $in: ['rejected', 'deferred'] },
      createdAt: { $gte: rejectedSince },
    }).sort({ createdAt: -1, _id: -1 }).lean();

    if (recentRejection) {
      return repetitionResult({
        status: REPETITION_STATUS.DISCOURAGED,
        reason: REPETITION_REASON.RECENTLY_REJECTED,
        normalizedTopic,
        similarity: 1,
        matched: recentRejection,
        windowDays: rejectionWindowDays,
        threshold: similarityThreshold,
      });
    }

    // 3. Similar recent topic — fuzzy pass over decisions within the similarity
    //    window. Bounded scan; the strongest match at or above threshold wins.
    const similarSince = new Date(now - similarityWindowDays * DAY_MS);
    const recent = await TopicMemory.find({ agentId: id, createdAt: { $gte: similarSince } })
      .select('topic normalizedTopic decision score rejectionCategory postId cycleId sourceUrls createdAt')
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(similarityScanLimit, MAX_RECENT_LIMIT))
      .lean();

    const candidateTokens = topicTokens(normalizedTopic);
    let best = null;
    for (const row of recent) {
      if (row.normalizedTopic === normalizedTopic) continue; // exact handled above
      const { matched, similarity } = scoreSimilarity(candidateTokens, topicTokens(row.normalizedTopic), {
        similarityThreshold, containmentThreshold, minSharedTokens,
      });
      if (matched && (!best || similarity > best.similarity)) best = { row, similarity };
    }

    if (best) {
      return repetitionResult({
        status: REPETITION_STATUS.DISCOURAGED,
        reason: REPETITION_REASON.SIMILAR_RECENT_TOPIC,
        normalizedTopic,
        similarity: best.similarity,
        matched: best.row,
        windowDays: similarityWindowDays,
        threshold: similarityThreshold,
      });
    }

    // 4. Nothing on record.
    return repetitionResult({
      status: REPETITION_STATUS.ALLOWED,
      reason: null,
      normalizedTopic,
      similarity: 0,
      matched: null,
      windowDays: similarityWindowDays,
      threshold: similarityThreshold,
    });
  } catch (err) {
    if (err instanceof MemoryInputError) throw err;
    throw persistenceFailure(err, 'repetition check');
  }
}
/**
 * Record an audit decision — 'rejected' or 'deferred' — as a TopicMemory row.
 *
 * Deliberately NOT for 'published': the publisher (Phase 10B) is the sole author
 * of the published Post and its published memory row, and duplicating that
 * post-first idempotent upsert here would both risk divergence and require a
 * memory -> publisher import cycle. A 'published' decision is therefore rejected
 * with a clear code directing the caller to publishFinalPost.
 *
 * Audit rows are intentionally append-only: the partial unique index constrains
 * only *published* rows, so an agent may accumulate many rejected/deferred
 * entries for one topic (the repetition history this phase relies on).
 *
 * @param {string} agentId
 * @param {{
 *   decision?: string, topic?: string, candidate?: object, reason?: string,
 *   rejectionCategory?: string, keywords?: string[], sources?: string[],
 *   sourceUrls?: string[], score?: number, cycleId?: string,
 * }} decision the decision to record (accepts a Phase 9 result shape)
 * @param {{cycleId?: string, keywords?: string[], sources?: string[], score?: number}} [context]
 * @returns {Promise<{recorded: true, decision: string, normalizedTopic: string, memory: object}>}
 * @throws {MemoryInputError} for invalid input (nothing is written)
 * @throws {MemoryError} for an unexpected persistence failure
 */
export async function recordDecision(agentId, decision, context = {}) {
  const id = requireAgentId(agentId);
  if (!decision || typeof decision !== 'object') {
    throw new MemoryInputError('A decision object is required.', 'invalid_decision');
  }

  const kind = String(decision.decision ?? '').trim().toLowerCase();
  if (kind === 'published') {
    throw new MemoryInputError(
      'Published memory is written by the publisher; call publishFinalPost instead.',
      'published_requires_publisher'
    );
  }
  if (kind !== 'rejected' && kind !== 'deferred') {
    throw new MemoryInputError(
      "decision.decision must be 'rejected' or 'deferred'.",
      'invalid_decision',
      [kind || '(empty)']
    );
  }

  const { topic, normalizedTopic } = resolveTopic(
    decision.topic ?? decision.candidate ?? null,
    { field: 'decision' }
  );

  const reason = String(decision.reason ?? context.reason ?? '').trim();
  if (!reason) {
    throw new MemoryInputError('A decision requires a reason.', 'missing_reason');
  }

  const rejectionCategory = decision.rejectionCategory ?? null;
  if (rejectionCategory !== null && !REJECTION_REASONS.includes(rejectionCategory)) {
    throw new MemoryInputError(
      `rejectionCategory must be one of ${REJECTION_REASONS.join(', ')}.`,
      'invalid_rejection_category',
      [String(rejectionCategory)]
    );
  }

  const keywords = Array.isArray(decision.keywords) ? decision.keywords.map(String)
    : (Array.isArray(context.keywords) ? context.keywords.map(String) : []);
  const sourceUrls = Array.isArray(decision.sourceUrls) ? decision.sourceUrls.map(String)
    : (Array.isArray(decision.sources) ? decision.sources.map(String)
      : (Array.isArray(context.sources) ? context.sources.map(String) : []));
  const score = Number.isFinite(decision.score) ? decision.score
    : (Number.isFinite(context.score) ? context.score : null);
  const cycleId = decision.cycleId ?? context.cycleId ?? null;

  try {
    // normalizedTopic is derived by TopicMemory's pre('validate') hook, so it is
    // provably the same value used for lookups above.
    const row = await TopicMemory.create({
      agentId: id,
      topic,
      decision: kind,
      reason,
      rejectionCategory,
      keywords,
      sourceUrls,
      score,
      cycleId,
    });
    log.info('Recorded a decision', { agentId: id, decision: kind, normalizedTopic });
    return { recorded: true, decision: kind, normalizedTopic, memory: toMemoryView(row) };
  } catch (err) {
    if (err?.name === 'ValidationError') {
      throw new MemoryInputError(
        'The decision failed schema validation and was not stored.',
        'invalid_memory',
        Object.keys(err.errors || {})
      );
    }
    throw persistenceFailure(err, 'record');
  }
}
