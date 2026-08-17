import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/**
 * One durable record per cycle execution — the agent's persistent work history.
 *
 * The activity buffer (utils/logger.js) already traces a cycle in detail, but it
 * is in-memory, capped at 300 entries, and cleared on restart. At a 90-minute
 * cadence that means the evidence an agent ran at all disappears with the
 * process. This collection is the opposite trade: no trace, but permanent.
 *
 * What that division of labour implies, and why it is enforced here:
 *
 *   - Aggregate only. Counts, timings, the decision, the outcome. There is no
 *     stage-by-stage narrative in a row of this collection, and the API and the
 *     dashboard must never present one as though there were.
 *   - No payloads. Prompts, article bodies, provider responses and source text
 *     live in Post / TopicMemory / the log, each of which already has a
 *     considered exposure story. Duplicating them here would create a second
 *     copy to secure and a second copy to keep consistent, so this schema has no
 *     field that can hold one.
 *   - Absence is a value. Every metric defaults to `null`, never `0`. A cycle
 *     that exited before discovery genuinely has no topic count, and a zero
 *     would claim it looked and found nothing. The read API passes the null
 *     through and the dashboard renders it as "Not available".
 */

/**
 * Lifecycle of the record itself — deliberately not the same thing as `outcome`.
 *
 *   running     — the row was opened; the cycle is in flight (or its process died)
 *   completed   — the cycle finished its work, whatever it decided to do
 *   failed      — the cycle could not complete its work
 *   interrupted — opened, never closed, and the process that owned it is gone
 *
 * `completed` covers a cycle that published and a cycle that deliberately chose
 * not to. Whether work happened is `status`; what came of it is `outcome`.
 */
export const CYCLE_RUN_STATUS = ['running', 'completed', 'failed', 'interrupted'];

/**
 * Outcome vocabulary, mirroring OUTCOME in services/agent/runCycle.js. Declared
 * here rather than imported because a model must not depend on a service; the
 * test suite asserts the two lists stay in step, so the copy cannot drift
 * silently.
 */
export const CYCLE_RUN_OUTCOMES = ['published', 'duplicate', 'idle', 'failed', 'paused'];

/** Editorial verdict vocabulary, mirroring DECISIONS in services/editorial/schema.js. */
export const CYCLE_RUN_DECISIONS = ['publish', 'skip'];

/** A metric field: a real count when one was measured, null when none was. */
const metric = { type: Number, min: 0, default: null };

const cycleRunSchema = new Schema(
  {
    agentId: { type: String, required: true, index: true },

    /**
     * The cycle's own id — the same value on `Cycle started` / `Cycle complete`
     * in the activity log, on the cycle's TopicMemory row, and on the Post it
     * published. Unique, which is what makes the write path idempotent: one
     * execution can only ever produce one row, so a retry cannot double-count a
     * cycle in the history.
     */
    cycleId: { type: String, required: true, unique: true },

    status: { type: String, enum: CYCLE_RUN_STATUS, required: true, default: 'running', index: true },
    outcome: { type: String, enum: CYCLE_RUN_OUTCOMES, default: null },

    /**
     * Real execution timestamps, taken from the worker's clock at the moment the
     * cycle actually began and ended — not createdAt/updatedAt, which record
     * when this bookkeeping row was touched. They coincide in production and
     * diverge under a test clock; the distinction matters because durationMs is
     * derived from these two and must describe the cycle, not the write.
     */
    startedAt: { type: Date, required: true, index: true },
    completedAt: { type: Date, default: null },
    durationMs: { type: Number, min: 0, default: null },

    // Pipeline counts for this cycle, using the same field names as Agent.stats
    // so a per-cycle figure and the cumulative tally are directly comparable.
    topicsDiscovered: metric,
    topicsAfterFilter: metric,
    topicsRejected: metric,
    topicsSelected: metric,
    postsPublished: metric,
    llmCalls: metric,

    decision: { type: String, enum: CYCLE_RUN_DECISIONS, default: null },
    /**
     * The editor's confidence in that decision, stored exactly as the editorial
     * layer reported it and deliberately left unbounded.
     *
     * That confidence has appeared as both a 0..1 fraction and a 0..100 score
     * across this codebase (see publisher/index.js toScore, which documents the
     * same dual scale). Normalizing here would invent precision this row cannot
     * justify, and a min/max validator would reject the write and strand the
     * record as `running`. So it is recorded raw, and any consumer that needs a
     * percentage has to reckon with the scale itself.
     */
    decisionScore: { type: Number, default: null },

    // Which provider actually served the cycle. Model/provider *names* are
    // configuration, not credentials; no key, endpoint or prompt is stored.
    provider: { type: String, default: null, maxlength: 60 },
    model: { type: String, default: null, maxlength: 120 },

    /** Set only when the cycle published, so history can link to the output. */
    postId: { type: String, default: null },

    // Failure detail, built solely from the pipeline's own {stage, code} enums —
    // never a raw error message, which could carry a URI or a key.
    failureCode: { type: String, default: null, maxlength: 60 },
    failureMessage: { type: String, default: null, maxlength: 300 },

    /**
     * A provider failure this cycle actually hit, including one the pipeline
     * absorbed on purpose.
     *
     * A 429 during the editorial call is converted into a local skip: the cycle
     * ends `completed` / `idle` and is *not* a scheduler failure, which is
     * existing, deliberate behaviour that this collection does not get to
     * relitigate. But without somewhere honest to put it, a rate-limited agent
     * would look perfectly healthy in its own history. This field is that place,
     * and it is written only from a code a service itself reported.
     */
    providerFailureCode: { type: String, default: null, maxlength: 60 },
  },
  { timestamps: true, versionKey: false }
);

// The history query: this agent's cycles, newest first. Every read the API
// performs is covered by this one index.
cycleRunSchema.index({ agentId: 1, startedAt: -1 });

// The startup recovery sweep: rows still marked `running` from a dead process.
cycleRunSchema.index({ status: 1, startedAt: 1 });

/**
 * The single source of truth for how a cycle run is exposed.
 *
 * Nulls are passed through rather than coerced, because a caller cannot tell a
 * measured zero from a missing measurement once they are the same value.
 */
cycleRunSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    cycleId: this.cycleId,
    status: this.status,
    outcome: this.outcome,
    startedAt: this.startedAt ? this.startedAt.toISOString() : null,
    completedAt: this.completedAt ? this.completedAt.toISOString() : null,
    durationMs: this.durationMs,
    topicsDiscovered: this.topicsDiscovered,
    topicsAfterFilter: this.topicsAfterFilter,
    topicsRejected: this.topicsRejected,
    topicsSelected: this.topicsSelected,
    postsPublished: this.postsPublished,
    llmCalls: this.llmCalls,
    decision: this.decision,
    decisionScore: this.decisionScore,
    provider: this.provider,
    model: this.model,
    postId: this.postId,
    failureCode: this.failureCode,
    failureMessage: this.failureMessage,
    providerFailureCode: this.providerFailureCode,
  };
};

/**
 * One page of an agent's execution history, newest first.
 *
 * Cursor-paginated on startedAt, the same shape as Post.feedFor, so a page
 * boundary stays stable while new cycles are being written above it. Two rows
 * sharing an exact startedAt could straddle that boundary and one be skipped —
 * impossible at a 90-minute cadence, and the alternative (offset paging) skips
 * rows on every insert instead, which is the worse trade.
 */
cycleRunSchema.statics.historyFor = function historyFor(agentId, { limit = 20, before } = {}) {
  const query = { agentId };
  if (before) query.startedAt = { $lt: before };
  return this.find(query).sort({ startedAt: -1, _id: -1 }).limit(limit);
};

/**
 * Close out rows left `running` by a process that no longer exists.
 *
 * Called once at startup, before any worker is resumed. `startedBefore` scopes
 * the sweep to rows that predate this boot so a cycle opened by the current
 * process can never be caught by its own recovery pass.
 *
 * Deliberately does not set completedAt or durationMs: the cycle's real end time
 * is unknown, and writing the recovery time there would fabricate a duration for
 * work that may have died a second in. `updatedAt` records when recovery ran,
 * which is the only honest timestamp available.
 */
cycleRunSchema.statics.markInterrupted = function markInterrupted({ startedBefore } = {}) {
  const query = { status: 'running' };
  if (startedBefore) query.startedAt = { $lt: startedBefore };
  return this.updateMany(query, { $set: { status: 'interrupted', failureCode: 'process_restart' } });
};

export const CycleRun = model('CycleRun', cycleRunSchema);
