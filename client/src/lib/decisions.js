/**
 * The vocabulary for an editorial decision.
 *
 * The backend stores three decisions — published, rejected, deferred
 * (TOPIC_DECISIONS in models/TopicMemory.js) — and the dashboard's job is to make
 * each one read as a choice the agent made, not as a row status. So every
 * decision carries three redundant signals:
 *
 *   glyph      a mark, decorative and aria-hidden — never the only signal
 *   label      the decision as an action ("Chose to publish")
 *   statement  one plain sentence saying what the agent did
 *
 * Colour is a fourth signal on top (DECISION_TONE in tones.js), which is what
 * keeps the list legible for anyone who cannot separate amber from red.
 *
 * IMPORTANT — none of these strings is an explanation of *why*. They describe
 * the decision itself. The "why" is separate, comes from the backend, and is
 * only ever rendered when the backend actually sent one: `reason`, the prose the
 * pipeline recorded at decision time, and `reasons`, the editor's own bullet
 * points on the cycles that produced them. Neither is synthesised here, and a
 * decision with neither says so (NO_REASONING_RECORDED) rather than borrowing a
 * plausible sentence from this file.
 */

export const DECISION_META = {
  published: {
    glyph: '✓',
    label: 'Chose to publish',
    statement: 'The agent judged this strong enough to publish.',
  },
  rejected: {
    glyph: '✕',
    label: 'Rejected',
    statement: 'The agent judged this not worth publishing.',
  },
  deferred: {
    glyph: '⏸',
    label: 'Deferred',
    statement: 'The agent chose not to publish this in that cycle.',
  },
};

/** Unknown decisions render honestly rather than crashing or being recoloured. */
export const UNKNOWN_DECISION = {
  glyph: '·',
  label: 'Recorded',
  statement: 'The agent recorded a decision of an unrecognised kind.',
};

export function decisionMeta(decision) {
  return DECISION_META[decision] || UNKNOWN_DECISION;
}

/**
 * Shown when a decision carries neither structured reasons nor recorded prose.
 *
 * Its job is to report a gap in the audit trail, not to paper over one. Rows
 * written before the agent captured structured reasoning are the common case,
 * and they must not be made to look like rows whose reasoning was captured.
 */
export const NO_REASONING_RECORDED = 'Decision reasoning was not recorded for this cycle.';

/**
 * The reasoning a decision actually carries, in the order it should be trusted.
 *
 * `reasons` is the editor's own enumerated grounds; `reason` is the prose the
 * pipeline recorded at decision time. Both come from the backend verbatim. When
 * neither is present the caller gets `recorded: false`, which is the signal to
 * render NO_REASONING_RECORDED — never a substitute drawn from DECISION_META.
 */
export function decisionReasoning(row) {
  const reasons = Array.isArray(row?.reasons)
    ? row.reasons.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];
  const prose = typeof row?.reason === 'string' ? row.reason.trim() : '';
  return { reasons, prose, recorded: reasons.length > 0 || Boolean(prose) };
}

/**
 * Readable renderings of REJECTION_REASONS (models/TopicMemory.js).
 *
 * Each entry is the same enum value in prose — `weak_sources` really does mean
 * the sourcing was too weak — so this adds legibility, not information. The raw
 * value is rendered alongside it, so nothing the backend said is hidden or
 * paraphrased away. An unmapped value falls back to its own text.
 */
export const REJECTION_LABEL = {
  repetitive: 'too close to something already covered',
  low_novelty: 'added nothing new',
  outside_domain: "outside the agent's domain",
  weak_sources: 'sourcing too weak',
  low_significance: 'not significant enough',
  stale: 'no longer timely',
  promotional: 'promotional rather than editorial',
  insufficient_information: 'not enough information to work with',
  below_threshold: 'scored below the publish threshold',
  other: 'another editorial reason',
};

export function rejectionLabel(category) {
  if (!category) return null;
  return REJECTION_LABEL[category] || String(category).replace(/_/g, ' ');
}
