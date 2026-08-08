/**
 * The editorial decision contract.
 *
 * Two layers of enforcement, because they catch different failures:
 *
 *  - The JSON Schema (validated by Phase 8's validator) covers shape: types,
 *    the closed decision enum, ranges, and no unexpected fields.
 *  - The cross-field rules in verify.js cover coherence: "publish implies an
 *    angle and a real index", "skip implies null". A schema in the subset this
 *    project supports cannot express those, and getting them wrong is exactly
 *    how a half-formed decision would reach Phase 10.
 *
 * `selectedCandidateIndex` is the 1-based `id` that compactCandidates() puts on
 * each candidate and the prompt shows to the model — not a 0-based array
 * offset. Stated explicitly here because "index" reads as 0-based to most
 * people, and an off-by-one would publish the wrong story.
 */

/** The only two outcomes. Anything else is invalid model output. */
export const DECISIONS = Object.freeze({ PUBLISH: 'publish', SKIP: 'skip' });
export const DECISION_VALUES = Object.freeze([DECISIONS.PUBLISH, DECISIONS.SKIP]);

/**
 * Where a decision came from. Phase 10 and the dashboard need to tell an
 * editorial judgement apart from a local shortcut or an operator override.
 */
export const DECISION_SOURCES = Object.freeze({
  /** The model judged the shortlist. */
  LLM: 'llm',
  /** A deterministic local check settled it without spending a call. */
  PRECHECK: 'precheck',
  /** The model chose publish, but below the configured confidence floor. */
  CONFIDENCE_GATE: 'confidence-gate',
  /** EDITORIAL_ALLOW_SKIP=false converted a skip into a forced publish. */
  FORCED_PUBLISH: 'forced-publish',
});

/**
 * Generous string bounds. They exist to keep a runaway response out of the
 * database, not to police wording: a decision rejected for being twenty
 * characters long would cost a whole autonomous cycle. The prompt asks for
 * something much shorter than these limits allow.
 */
const LIMITS = { reason: 600, angle: 300, evidence: 300, rejection: 300 };

/**
 * Build the response schema for a specific shortlist.
 *
 * The candidate count is baked into `maximum` so an out-of-range index is
 * caught by the validator, before any of our own verification runs.
 *
 * @param {number} candidateCount
 * @returns {object}
 */
export function buildDecisionSchema(candidateCount) {
  const count = Number.isInteger(candidateCount) && candidateCount > 0 ? candidateCount : 1;

  return {
    type: 'object',
    required: ['decision', 'selectedCandidateIndex', 'confidence', 'reason', 'angle', 'evidence', 'rejectionReasons'],
    additionalProperties: false,
    properties: {
      decision: { type: 'string', enum: [...DECISION_VALUES] },
      selectedCandidateIndex: { type: 'integer', nullable: true, minimum: 1, maximum: count },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string', minLength: 10, maxLength: LIMITS.reason },
      angle: { type: 'string', nullable: true, maxLength: LIMITS.angle },
      evidence: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: LIMITS.evidence } },
      rejectionReasons: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: LIMITS.rejection } },
    },
  };
}

export { LIMITS as DECISION_LIMITS };

/** A decision the application produced locally, in the same shape as a judged one. */
export function localDecision({ reason, rejectionReasons = [], confidence = 1, source }) {
  return {
    decision: DECISIONS.SKIP,
    selectedCandidateIndex: null,
    confidence,
    reason,
    angle: null,
    evidence: [],
    rejectionReasons,
    source,
  };
}
