import mongoose from 'mongoose';
import { normalizeTopic } from '../utils/text.js';

const { Schema, model } = mongoose;

export const TOPIC_DECISIONS = ['published', 'rejected', 'deferred'];

/**
 * Why a candidate was turned down. Kept as an enum so the dashboard can group
 * rejections and judges can see the editorial standard actually being applied.
 */
export const REJECTION_REASONS = [
  'repetitive',
  'low_novelty',
  'outside_domain',
  'weak_sources',
  'low_significance',
  'stale',
  'promotional',
  'insufficient_information',
  'below_threshold',
  'other',
];

/**
 * Bounds for the structured reason list.
 *
 * These mirror the editorial schema's own limits (`buildDecisionSchema` allows
 * at most 10 rejectionReasons / 5 evidence items, 300 characters each), so
 * nothing the editor can legitimately produce is truncated on the way in. They
 * exist to bound a malformed or hostile payload, not to reshape a valid one.
 */
export const MAX_REASONS = 10;
export const MAX_REASON_LENGTH = 300;

/**
 * Normalize a structured reason list into what the schema should store.
 *
 * Returns `undefined` — not `[]` — when there is nothing real to keep, so an
 * absent field stays absent and the dashboard can distinguish a cycle whose
 * reasons were never recorded from one that recorded an empty list. Both writers
 * (the memory service and the publisher) go through this, so neither can put a
 * non-string, an empty string, or an unbounded blob into the audit trail.
 */
export function sanitizeReasons(value) {
  if (!Array.isArray(value)) return undefined;
  const cleaned = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const text = entry.trim().slice(0, MAX_REASON_LENGTH);
    if (text) cleaned.push(text);
    if (cleaned.length === MAX_REASONS) break;
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Every editorial decision, published or not.
 *
 * This is the agent's memory: it powers repetition detection and it is the
 * evidence that the agent genuinely rejects weak topics rather than
 * publishing everything it finds.
 */
const topicMemorySchema = new Schema(
  {
    agentId: { type: String, required: true, index: true },

    topic: { type: String, required: true, trim: true, maxlength: 300 },
    normalizedTopic: { type: String, required: true, index: true },
    keywords: { type: [String], default: [] },
    sourceUrls: { type: [String], default: [] },

    decision: { type: String, enum: TOPIC_DECISIONS, required: true, index: true },
    score: { type: Number, min: 0, max: 100, default: null },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    /**
     * The structured form of the same "why", when the pipeline actually produced
     * one. Never a paraphrase of `reason` — these are the editor's own bullet
     * points, carried through verbatim.
     *
     * Optional, and `default: undefined` rather than `[]` deliberately. An
     * empty-array default would materialise on every row written before this
     * field existed, and the API could then no longer distinguish an editor that
     * listed no reasons from a cycle that predates structured reasoning. The
     * dashboard would have to guess which it was looking at, and a guess about
     * an agent's own reasoning is a fabricated audit trail. Absent means absent,
     * and the UI says so in as many words.
     */
    reasons: { type: [String], default: undefined },
    rejectionCategory: { type: String, enum: REJECTION_REASONS, default: null },

    // Set only when decision === 'published'.
    postId: { type: String, default: null, index: true },
    cycleId: { type: String, default: null, index: true },
  },
  { timestamps: true, versionKey: false }
);

// Dashboard: this agent's decisions, newest first.
topicMemorySchema.index({ agentId: 1, createdAt: -1 });

// Repetition lookup: has this agent seen this topic, and what did it decide?
topicMemorySchema.index({ agentId: 1, normalizedTopic: 1, createdAt: -1 });

// Filter by outcome, e.g. the "rejected topics" view.
topicMemorySchema.index({ agentId: 1, decision: 1, createdAt: -1 });

// At most one *published* memory per topic per agent. This is what makes the
// publisher's post-publication upsert concurrency-safe: two cycles racing to
// record the same published topic cannot both insert — one wins, the other's
// insert fails with a duplicate-key error the publisher treats as an idempotent
// success. The partialFilterExpression scopes the constraint to published rows
// only, so the audit log may still hold many 'rejected'/'deferred' entries for
// the same topic (repetition history the memory phase relies on).
topicMemorySchema.index(
  { agentId: 1, normalizedTopic: 1 },
  { unique: true, partialFilterExpression: { decision: 'published' } }
);

// Mongoose 9 document middleware is promise-based: no `next` parameter.
topicMemorySchema.pre('validate', function normalize() {
  if (this.topic && (!this.normalizedTopic || this.isModified('topic'))) {
    this.normalizedTopic = normalizeTopic(this.topic);
  }
});

topicMemorySchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    topic: this.topic,
    decision: this.decision,
    score: this.score,
    reason: this.reason,
    // Absent stays absent: a row written before structured reasoning existed
    // reports null, never an empty list that would read as "the editor gave no
    // reasons" when the truth is that none were ever captured.
    reasons: this.reasons?.length ? [...this.reasons] : null,
    rejectionCategory: this.rejectionCategory,
    sources: [...this.sourceUrls],
    postId: this.postId,
    createdAt: this.createdAt.toISOString(),
  };
};

/** Memory window for repetition checks. */
topicMemorySchema.statics.recentFor = function recentFor(agentId, { limit = 50, decision } = {}) {
  const query = { agentId };
  if (decision) query.decision = decision;
  return this.find(query)
    .select('topic normalizedTopic keywords decision score createdAt')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

/** Has this agent already decided on this exact topic? */
topicMemorySchema.statics.findByTopic = function findByTopic(agentId, topic) {
  return this.findOne({ agentId, normalizedTopic: normalizeTopic(topic) })
    .sort({ createdAt: -1 })
    .lean();
};

export const TopicMemory = model('TopicMemory', topicMemorySchema);
