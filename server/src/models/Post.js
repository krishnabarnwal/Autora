import mongoose from 'mongoose';
import { newPostId } from '../utils/ids.js';
import { normalizeTopic } from '../utils/text.js';

const { Schema, model } = mongoose;

/**
 * A published post. This is the durable record behind GET /api/agent/feed,
 * so its fields map directly onto the required response contract.
 */
const postSchema = new Schema(
  {
    postId: { type: String, required: true, unique: true, index: true, default: newPostId },
    agentId: { type: String, required: true, index: true },

    topic: { type: String, required: true, trim: true, maxlength: 300 },
    // Sorted-token form used by repetition detection.
    normalizedTopic: { type: String, required: true, index: true },

    text: { type: String, required: true, trim: true, maxlength: 5000 },
    rationale: { type: String, required: true, trim: true, maxlength: 2000 },

    // Contract requires at least one source on every post.
    sources: {
      type: [String],
      required: true,
      validate: {
        validator: (value) => Array.isArray(value) && value.length > 0,
        message: 'A post must cite at least one source URL',
      },
    },

    keywords: { type: [String], default: [], index: true },

    metadata: {
      score: { type: Number, min: 0, max: 100, default: null },
      model: { type: String, default: null },
      provider: { type: String, default: null },
      cycleId: { type: String, default: null, index: true },
      candidateCount: { type: Number, default: null },
      rejectedCount: { type: Number, default: null },
      generationMs: { type: Number, default: null },
    },
  },
  { timestamps: true, versionKey: false }
);

// Feed query: newest-first within one agent. Covers the hot path exactly.
postSchema.index({ agentId: 1, createdAt: -1 });

// Repetition check: "has this agent already published this topic?"
postSchema.index({ agentId: 1, normalizedTopic: 1 }, { unique: true });

/**
 * Keep normalizedTopic in sync so callers cannot forget to set it.
 * Mongoose 9 document middleware is promise-based: declaring no `next`
 * parameter tells it to await the return value instead.
 */
postSchema.pre('validate', function normalize() {
  if (this.topic && (!this.normalizedTopic || this.isModified('topic'))) {
    this.normalizedTopic = normalizeTopic(this.topic);
  }
});

/**
 * Exact shape required by GET /api/agent/feed.
 * createdAt must be ISO 8601 UTC.
 */
postSchema.methods.toFeedJSON = function toFeedJSON() {
  return {
    id: this.postId,
    createdAt: this.createdAt.toISOString(),
    text: this.text,
    rationale: this.rationale,
    sources: [...this.sources],
  };
};

/** Feed payload plus dashboard-only context. */
postSchema.methods.toDetailJSON = function toDetailJSON() {
  return {
    ...this.toFeedJSON(),
    agentId: this.agentId,
    topic: this.topic,
    keywords: [...this.keywords],
    metadata: this.metadata?.toObject ? this.metadata.toObject() : this.metadata,
  };
};

/** Newest-first page of posts for one agent. */
postSchema.statics.feedFor = function feedFor(agentId, { limit = 50, before } = {}) {
  const query = { agentId };
  if (before) query.createdAt = { $lt: before };
  return this.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit);
};

/** Recent posts used as the repetition window. */
postSchema.statics.recentFor = function recentFor(agentId, limit = 25) {
  return this.find({ agentId })
    .select('topic normalizedTopic keywords createdAt')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

export const Post = model('Post', postSchema);
