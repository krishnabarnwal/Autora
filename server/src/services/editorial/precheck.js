/**
 * Deterministic checks that run before the model does.
 *
 * Purpose is narrow: don't pay for a call whose answer is already known, and
 * don't hand the model input it cannot judge. This is not a second filtering
 * pipeline — Phase 7 owns relevance, freshness, quality and deduplication, and
 * duplicating any of that here would mean two places to fix when it changes.
 *
 * A cycle that skips here costs zero tokens, which over a 48-hour run at demo
 * cadence is the difference between a working budget and an exhausted one.
 */
import { DECISIONS, DECISION_SOURCES, localDecision } from './schema.js';

/** Thrown for conditions that indicate a caller bug rather than a quiet news day. */
export class EditorialInputError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'EditorialInputError';
    this.code = code;
    this.details = details;
  }
}

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/** A usable URL, not just a non-empty string: Phase 10 has to link to this. */
function hasUsableUrl(candidate) {
  if (!isNonEmptyString(candidate.url)) return false;
  try {
    const parsed = new URL(candidate.url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Inspect one candidate.
 *
 * Title and URL are load-bearing: without a title there is nothing to judge,
 * and without a URL a published post could not cite its source, which the feed
 * contract requires. A missing summary is survivable — the model can still
 * weigh a headline, source and date — so it is flagged, not fatal.
 *
 * @returns {{usable: boolean, issues: string[]}}
 */
export function inspectCandidate(candidate, position) {
  const issues = [];

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { usable: false, issues: [`candidate ${position}: not an object`] };
  }
  if (!isNonEmptyString(candidate.title)) issues.push(`candidate ${position}: missing title`);
  if (!hasUsableUrl(candidate)) issues.push(`candidate ${position}: missing or invalid url`);

  const fatal = issues.length > 0;
  if (!isNonEmptyString(candidate.summary)) {
    issues.push(`candidate ${position}: missing summary (judged on title and metadata alone)`);
  }

  return { usable: !fatal, issues };
}

/**
 * Decide whether the model needs to be consulted at all.
 *
 * @param {object[]} candidates raw Phase 7 candidates, before compaction
 * @param {{maxCandidates?: number, minRelevance?: number}} [options]
 * @returns {{
 *   candidates: object[], issues: string[], dropped: number,
 *   decision: object|null
 * }} `decision` non-null means stop here and do not call the model.
 * @throws {EditorialInputError} when the input itself is malformed
 */
export function precheckCandidates(candidates, options = {}) {
  const { maxCandidates = 8, minRelevance = 0 } = options;

  if (!Array.isArray(candidates)) {
    throw new EditorialInputError(
      `Editorial input must be an array of candidates, received ${candidates === null ? 'null' : typeof candidates}`,
      'invalid_input'
    );
  }

  // Over the cap means an upstream limit was bypassed. Failing loudly beats
  // silently truncating, which would hide the regression that caused it.
  if (candidates.length > maxCandidates) {
    throw new EditorialInputError(
      `Received ${candidates.length} candidates, above the configured maximum of ${maxCandidates}. `
        + 'Lower the Phase 7 limit or raise EDITORIAL_MAX_CANDIDATES; the editorial prompt is sized for this bound.',
      'too_many_candidates',
      { received: candidates.length, maxCandidates }
    );
  }

  if (candidates.length === 0) {
    return {
      candidates: [],
      issues: [],
      dropped: 0,
      decision: localDecision({
        reason: 'No candidates survived local filtering this cycle, so there is nothing to judge.',
        rejectionReasons: ['Empty candidate list'],
        source: DECISION_SOURCES.PRECHECK,
      }),
    };
  }

  const issues = [];
  const usable = [];
  for (const [position, candidate] of candidates.entries()) {
    const inspection = inspectCandidate(candidate, position + 1);
    issues.push(...inspection.issues);
    if (inspection.usable) usable.push(candidate);
  }

  const dropped = candidates.length - usable.length;

  if (usable.length === 0) {
    return {
      candidates: [],
      issues,
      dropped,
      decision: localDecision({
        reason: 'Every candidate was structurally unusable: none carried both a title and a valid source URL.',
        rejectionReasons: issues.slice(0, 10),
        source: DECISION_SOURCES.PRECHECK,
      }),
    };
  }

  // Phase 7 already applied a relevance floor, so this only fires when its
  // scoring says nothing is on the persona's beat at all. Default floor is 0,
  // which means "genuinely zero relevance" rather than a second opinion on
  // Phase 7's threshold.
  const scored = usable.filter((candidate) => typeof candidate.relevance === 'number');
  if (scored.length === usable.length && usable.every((candidate) => candidate.relevance <= minRelevance)) {
    return {
      candidates: usable,
      issues,
      dropped,
      decision: localDecision({
        reason: `No candidate scored above ${minRelevance} for persona relevance, so none is on this agent's beat.`,
        rejectionReasons: ['No candidate is relevant to the persona'],
        source: DECISION_SOURCES.PRECHECK,
      }),
    };
  }

  return { candidates: usable, issues, dropped, decision: null };
}

export { DECISIONS };
