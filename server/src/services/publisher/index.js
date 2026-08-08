/**
 * Phase 10B — verified publishing + topic memory.
 *
 * One job: take an already-verified, in-memory FinalPost (the Phase 10 generator's
 * output) and persist it as a durable Post, then record the decision in
 * TopicMemory. It is the last link in the chain and the only one that writes the
 * feed:
 *
 *   candidates -> Phase 9 decision -> Phase 10 FinalPost -> [ Phase 10B publish ]
 *
 * What this layer must never do, by construction:
 *   - call the LLM (no provider, no prompt, no generateJSON)
 *   - fetch an external source or collect feeds
 *   - re-run editorial judgement or rewrite the post's content
 *   - accept arbitrary caller text as a post (it persists a verified FinalPost)
 *
 * FinalPost carries only what the writer produced — text, hook, hashtags,
 * sourceUrls, characterCount, platform. It has no topic and no rationale, so
 * those come from `context` (the Phase 9 decision and its candidate). The
 * publisher maps, it does not invent.
 *
 * Consistency without a transaction. The store is MongoDB; in production Atlas is
 * a replica set (transactions available), but the test harness is a standalone
 * in-memory server (transactions unavailable), and adding a replica-set test
 * server just for this would be unnecessary infrastructure. So instead of a
 * transaction this layer is *ordered and idempotent*:
 *
 *   1. Create the Post first. Its unique (agentId, normalizedTopic) index is the
 *      atomic duplicate gate and the source of truth for the feed. A duplicate
 *      insert fails with E11000, which is a controlled "already published"
 *      outcome, never a 500.
 *   2. Only after the Post is durably stored, upsert the published TopicMemory
 *      row with a single atomic findOneAndUpdate.
 *
 * Post-first ordering means a crash between the two steps leaves the *safe*
 * inconsistency: the feed is correct, and the next publish attempt for the same
 * topic hits E11000 and self-heals the memory. The reverse order could leave a
 * "published" memory pointing at a post that does not exist, which is the lie
 * this layer most needs to avoid.
 */
import { Agent, Post, TopicMemory } from '../../models/index.js';
import { normalizeTopic, extractKeywords } from '../../utils/text.js';
import { logger } from '../../utils/logger.js';

const log = logger('PUBLISH');
const mem = logger('MEMORY');

/** MongoDB duplicate-key error code. The one Mongo error this layer expects. */
const DUPLICATE_KEY = 11000;

// Store limits, mirrored from the schemas so we fail in the publisher with a
// precise code rather than letting Mongoose throw a generic ValidationError.
const MAX_TOPIC = 300;
const MAX_TEXT = 5000;
const MAX_RATIONALE = 2000;
const MAX_REASON = 1000;
const MAX_KEYWORDS = 12;

/** Coarse outcome a caller branches on. */
export const PUBLISH_STATUS = {
  /** A new Post was created this call. */
  PUBLISHED: 'published',
  /** The topic was already published; the existing Post is returned unchanged. */
  DUPLICATE: 'duplicate',
};

/**
 * A caller/validation error: the FinalPost or context was unfit to publish, and
 * nothing was written. Thrown (not returned) so a bug surfaces loudly, mirroring
 * the editorial and generation input-error boundaries.
 */
export class PublisherInputError extends Error {
  constructor(message, code, details = []) {
    super(message);
    this.name = 'PublisherInputError';
    this.code = code;
    this.details = details;
  }
}

/**
 * An unexpected persistence failure. Its message is fixed and safe: it never
 * carries a raw driver string, which can contain host or topology detail. The
 * taxonomy code is what a caller branches on.
 */
export class PublisherError extends Error {
  constructor(message, code = 'persistence_failed', details = []) {
    super(message);
    this.name = 'PublisherError';
    this.code = code;
    this.details = details;
  }
}

/** True only for an absolute http(s) URL. Kept local so the layer imports nothing extra. */
function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Map a confidence/score signal onto the 0..100 the schemas store.
 *
 * The editorial layer's confidence has appeared as both a 0..1 fraction and a
 * 0..100 score across the codebase, so a fraction is scaled up and anything is
 * clamped into range. Returns null when no usable number is present, which the
 * schemas accept.
 */
function toScore(...candidates) {
  for (const value of candidates) {
    if (typeof value !== 'number' || Number.isNaN(value)) continue;
    let n = value > 0 && value <= 1 ? value * 100 : value;
    n = Math.round(n);
    if (n < 0) n = 0;
    if (n > 100) n = 100;
    return n;
  }
  return null;
}

/**
 * Validate the FinalPost's persistable content before any database call.
 *
 * This is the "reject invalid input before touching MongoDB" boundary. The
 * generator already verified the post against its platform; here we only re-check
 * the invariants the *store* depends on, so a malformed object never reaches a
 * write.
 *
 * @param {object} finalPost
 * @returns {{text: string, sources: string[]}}
 * @throws {PublisherInputError}
 */
function readFinalPost(finalPost) {
  if (!finalPost || typeof finalPost !== 'object') {
    throw new PublisherInputError('A FinalPost object is required to publish.', 'invalid_final_post');
  }

  const text = String(finalPost.text ?? '').trim();
  if (!text) {
    throw new PublisherInputError('FinalPost has an empty body.', 'empty_text', ['text is empty']);
  }
  if (text.length > MAX_TEXT) {
    throw new PublisherInputError(
      `FinalPost body is ${text.length} characters, over the ${MAX_TEXT}-character store limit.`,
      'text_too_long',
      [`length ${text.length} exceeds ${MAX_TEXT}`]
    );
  }

  const raw = Array.isArray(finalPost.sourceUrls)
    ? finalPost.sourceUrls.map((url) => String(url).trim()).filter(Boolean)
    : [];
  if (raw.length === 0) {
    throw new PublisherInputError('FinalPost cites no source URL.', 'missing_sources', ['sourceUrls is empty']);
  }
  const invalid = raw.filter((url) => !isHttpUrl(url));
  if (invalid.length) {
    throw new PublisherInputError(
      'FinalPost cites a value that is not a URL.',
      'invalid_source',
      invalid.map((url) => `not a URL: ${url}`)
    );
  }

  // De-duplicate while preserving cited order; the generator already resolved
  // these to the candidate's own URLs, so they are stored verbatim.
  return { text, sources: [...new Set(raw)] };
}

/**
 * Resolve the publishing context into the fields the two schemas need.
 *
 * `context` provides the agent and the editorial decision the FinalPost was
 * written from. Topic and rationale live here, not on the FinalPost, so this is
 * where they are pulled and bounded. Nothing here is invented: a missing topic
 * or rationale is a rejection, not a synthesized default.
 *
 * @throws {PublisherInputError}
 */
function readContext(context) {
  const agentId = String(context.agent?.agentId ?? context.agentId ?? '').trim();
  if (!agentId) {
    throw new PublisherInputError('A publishing context must identify the agent.', 'missing_agent');
  }

  const decision = context.decision && typeof context.decision === 'object' ? context.decision : {};
  const candidate = decision.candidate && typeof decision.candidate === 'object'
    ? decision.candidate
    : (context.candidate && typeof context.candidate === 'object' ? context.candidate : {});

  const topicSource = String(context.topic ?? candidate.title ?? '').trim();
  if (!topicSource) {
    throw new PublisherInputError('A publishing context must supply a topic.', 'missing_topic');
  }
  const topic = topicSource.slice(0, MAX_TOPIC);

  // Computed the same way Post's pre('validate') hook computes it, so the value
  // used for the duplicate lookup and the memory key is provably identical to
  // what the Post stores.
  const normalizedTopic = normalizeTopic(topic);
  if (!normalizedTopic) {
    throw new PublisherInputError(
      'The topic has no indexable content after normalization.',
      'missing_normalized_topic',
      [topicSource]
    );
  }

  const rationaleSource = String(
    context.rationale ?? [decision.angle, decision.reason].filter(Boolean).join(' — ')
  ).trim();
  if (!rationaleSource) {
    throw new PublisherInputError('A published post requires a rationale.', 'missing_rationale');
  }
  const rationale = rationaleSource.slice(0, MAX_RATIONALE);

  const reasonSource = String(context.reason ?? decision.reason ?? rationaleSource).trim();
  const reason = (reasonSource || rationaleSource).slice(0, MAX_REASON);

  const keywords = pickKeywords(context, candidate, `${topic} ${reason}`);

  return {
    agentId,
    // Whether an Agent document (not just an id) was supplied. When it was, the
    // agent provably exists and we skip the existence read on the hot path.
    agentProvided: Boolean(context.agent?.agentId),
    topic,
    normalizedTopic,
    rationale,
    reason,
    keywords,
    score: toScore(context.score, decision.score, decision.confidence),
    cycleId: context.cycleId ? String(context.cycleId) : null,
    provider: decision.provider ?? context.provider ?? null,
    model: decision.model ?? context.model ?? null,
    candidateCount: Number.isFinite(decision.candidatesConsidered) ? decision.candidatesConsidered : null,
    generationMs: Number.isFinite(context.generationMs) ? context.generationMs : null,
  };
}

/** Prefer explicit keywords, then the candidate's, then derive from the text. */
function pickKeywords(context, candidate, fallbackText) {
  if (Array.isArray(context.keywords) && context.keywords.length) {
    return context.keywords.slice(0, MAX_KEYWORDS).map(String);
  }
  if (Array.isArray(candidate.keywords) && candidate.keywords.length) {
    return candidate.keywords.slice(0, MAX_KEYWORDS).map(String);
  }
  return extractKeywords(fallbackText, MAX_KEYWORDS);
}

/**
 * Publish a verified FinalPost: persist the Post, then record TopicMemory.
 *
 * Idempotent and safe to call twice with the same FinalPost/topic. The second
 * call — and any concurrent duplicate — returns the already-stored Post with
 * status 'duplicate' and creates no second row, because the Post's unique
 * (agentId, normalizedTopic) index is the single arbiter.
 *
 * @param {object} finalPost the Phase 10 generator output {text, hook, hashtags, sourceUrls, characterCount, platform}
 * @param {{
 *   agent?: object, agentId?: string,
 *   decision?: object, candidate?: object,
 *   topic?: string, rationale?: string, reason?: string,
 *   keywords?: string[], score?: number, cycleId?: string,
 *   provider?: string, model?: string, generationMs?: number,
 * }} context the agent + editorial decision the post was written from
 * @returns {Promise<{status: string, created: boolean, duplicate: boolean, post: object, postId: string, agentId: string, normalizedTopic: string}>}
 * @throws {PublisherInputError} for invalid input (nothing is written)
 * @throws {PublisherError} for an unexpected persistence failure (safe message)
 */
export async function publishFinalPost(finalPost, context = {}) {
  // 1. Validate everything the store depends on, before any database call.
  const { text, sources } = readFinalPost(finalPost);
  const ctx = readContext(context);

  // 2. Reject an unknown agent so a typo cannot create an orphan post. Skipped
  //    when a full Agent document was supplied — it provably exists already.
  if (!ctx.agentProvided) {
    const exists = await Agent.exists({ agentId: ctx.agentId });
    if (!exists) {
      throw new PublisherInputError('No agent exists with that agentId.', 'unknown_agent', [ctx.agentId]);
    }
  }

  // 3. Persist the Post. The unique index is the atomic duplicate gate.
  const { post, created } = await persistPost({ ctx, text, sources });

  // 4. Record the decision in the agent's memory. A memory failure after the
  //    post is stored is surfaced as its own controlled error, never swallowed.
  await recordPublishedMemory({ ctx, sources, postId: post.postId, created });

  return {
    status: created ? PUBLISH_STATUS.PUBLISHED : PUBLISH_STATUS.DUPLICATE,
    created,
    duplicate: !created,
    post,
    postId: post.postId,
    agentId: ctx.agentId,
    normalizedTopic: ctx.normalizedTopic,
  };
}

/**
 * Insert the Post, or resolve the existing one on a duplicate topic.
 *
 * @returns {Promise<{post: object, created: boolean}>}
 */
async function persistPost({ ctx, text, sources }) {
  try {
    const post = await Post.create({
      agentId: ctx.agentId,
      topic: ctx.topic, // normalizedTopic is derived by Post's pre('validate') hook
      text,
      rationale: ctx.rationale,
      sources,
      keywords: ctx.keywords,
      metadata: {
        score: ctx.score,
        model: ctx.model,
        provider: ctx.provider,
        cycleId: ctx.cycleId,
        candidateCount: ctx.candidateCount,
        rejectedCount: null,
        generationMs: ctx.generationMs,
      },
    });
    log.info('Published a post', {
      agentId: ctx.agentId,
      postId: post.postId,
      normalizedTopic: ctx.normalizedTopic,
      sources: sources.length,
    });
    return { post, created: true };
  } catch (err) {
    // The one expected failure: this agent already published this topic.
    if (err?.code === DUPLICATE_KEY) {
      const existing = await Post.findOne({ agentId: ctx.agentId, normalizedTopic: ctx.normalizedTopic });
      if (existing) {
        log.info('Duplicate topic; returning the existing post', {
          agentId: ctx.agentId,
          postId: existing.postId,
          normalizedTopic: ctx.normalizedTopic,
        });
        return { post: existing, created: false };
      }
      // The unique index fired but the row is not readable back — a rare race
      // (e.g. a concurrent delete). Controlled failure, never a raw 500.
      throw new PublisherError('The post could not be persisted this cycle.', 'persistence_failed');
    }

    // Our pre-checks should have caught bad content; if the schema still
    // rejected it, name it precisely without leaking the raw validator text.
    if (err?.name === 'ValidationError') {
      throw new PublisherInputError(
        'The post failed schema validation and was not stored.',
        'invalid_post',
        Object.keys(err.errors || {})
      );
    }

    // Anything else is an infrastructure failure. Log only non-sensitive fields
    // (a raw driver message can carry host/topology detail) and surface a fixed
    // safe message.
    log.error('Post persistence failed', { agentId: ctx.agentId, name: err?.name, code: err?.code });
    throw new PublisherError('The post could not be persisted this cycle.', 'persistence_failed');
  }
}

/**
 * Record (or reconcile) the published TopicMemory row with one atomic upsert.
 *
 * The row is keyed on the published-topic identity (agentId, normalizedTopic,
 * decision:'published'), which a partial unique index keeps singular. Two paths:
 *
 *   - created:true  (this call wrote the Post): author the memory with $set, so
 *     a minimal row a concurrent reconcile may have inserted is filled in.
 *   - created:false (duplicate topic): reconcile with $setOnInsert only, so a
 *     re-publish never overwrites the original memory — it only creates one if a
 *     crash left the post without its memory.
 *
 * A duplicate-key error from the partial index means a concurrent writer won the
 * race; the row exists, so that is an idempotent success, not a failure.
 */
async function recordPublishedMemory({ ctx, sources, postId, created }) {
  const filter = { agentId: ctx.agentId, normalizedTopic: ctx.normalizedTopic, decision: 'published' };
  // Authored fields only — the three identity fields live in the filter and are
  // applied to the document on insert, so repeating them here is avoided.
  const authored = {
    topic: ctx.topic,
    keywords: ctx.keywords,
    sourceUrls: sources,
    score: ctx.score,
    reason: ctx.reason,
    rejectionCategory: null,
    postId,
    cycleId: ctx.cycleId,
  };
  const update = created ? { $set: authored } : { $setOnInsert: authored };

  try {
    // The updated document is intentionally not read back: this write's only job
    // is to make the row exist. Omitting `new`/`returnDocument` avoids an unused
    // round-trip and the associated deprecation warning.
    await TopicMemory.findOneAndUpdate(filter, update, {
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    });
    mem.info('Recorded topic memory', {
      agentId: ctx.agentId,
      normalizedTopic: ctx.normalizedTopic,
      decision: 'published',
      postId,
    });
  } catch (err) {
    if (err?.code === DUPLICATE_KEY) {
      // The partial unique index caught a concurrent insert. The row exists,
      // which is exactly the state we wanted, so treat it as success.
      mem.info('Topic memory already recorded by a concurrent publish', {
        agentId: ctx.agentId,
        normalizedTopic: ctx.normalizedTopic,
      });
      return;
    }
    mem.error('Topic memory upsert failed', { agentId: ctx.agentId, name: err?.name, code: err?.code });
    throw new PublisherError(
      'The post was published but its topic memory could not be recorded.',
      'memory_failed'
    );
  }
}
