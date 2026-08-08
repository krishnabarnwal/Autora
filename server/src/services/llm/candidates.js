/**
 * Bounded candidate payloads.
 *
 * The economics of this project live in this file. Phase 6-7 narrows ~2000 raw
 * articles to ~8 ranked candidates without spending a token; this module is the
 * gate that keeps it that way, capping what any later phase is able to put in a
 * prompt regardless of what it passes in.
 *
 * Nothing here judges a candidate. Selection is Phase 9's job — this only
 * decides how much of an already-selected candidate the model gets to see.
 */

/** Hard ceiling on candidates per call. Phase 7 returns 8; this is the backstop. */
export const MAX_CANDIDATES = 10;
/** Summaries are the bulk of the payload, and the tail of one is rarely load-bearing. */
export const MAX_SUMMARY_CHARS = 400;
export const MAX_TITLE_CHARS = 200;

/** Cut on a word boundary so a truncated summary still reads as a sentence. */
function truncate(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Reduce Phase 7 candidates to the smallest shape a model needs to judge them.
 *
 * Drops the scoring internals (`score`, `relevance`, `normalizedTopic`): they
 * are how *we* ranked, not evidence a model should reason from, and including
 * them both costs tokens and invites the model to defer to our arithmetic.
 *
 * @param {object[]} candidates
 * @param {{limit?: number, summaryChars?: number, includeUrl?: boolean}} [options]
 * @returns {Array<{id:number, title:string, summary:string, source:string, publishedAt:string|null, corroboration:number, url?:string}>}
 */
export function compactCandidates(candidates = [], options = {}) {
  const {
    limit = MAX_CANDIDATES,
    summaryChars = MAX_SUMMARY_CHARS,
    includeUrl = true,
  } = options;

  const capped = Math.max(1, Math.min(limit, MAX_CANDIDATES));

  return (Array.isArray(candidates) ? candidates : [])
    .slice(0, capped)
    .map((candidate, index) => ({
      // A short positional id lets a model refer to a candidate without
      // echoing the whole title back, which halves the output tokens.
      id: index + 1,
      title: truncate(candidate.title, MAX_TITLE_CHARS),
      summary: truncate(candidate.summary, summaryChars),
      source: String(candidate.source ?? 'unknown'),
      publishedAt: candidate.publishedAt ?? null,
      corroboration: candidate.corroboration ?? 1,
      ...(includeUrl && candidate.url ? { url: String(candidate.url) } : {}),
    }));
}

/**
 * Assert a payload is small enough to send.
 *
 * A guard rather than a silent trim: if a later phase manages to assemble an
 * oversized prompt, the right outcome is a loud failure in tests, not a
 * surprise invoice.
 *
 * @param {object[]} compacted
 * @param {{maxChars?: number, maxCandidates?: number}} [limits]
 */
export function assertBounded(compacted, limits = {}) {
  const { maxChars = 12_000, maxCandidates = MAX_CANDIDATES } = limits;
  const serialized = JSON.stringify(compacted);

  if (compacted.length > maxCandidates) {
    throw new Error(`Candidate payload has ${compacted.length} entries, above the ${maxCandidates} cap`);
  }
  if (serialized.length > maxChars) {
    throw new Error(`Candidate payload is ${serialized.length} chars, above the ${maxChars} cap`);
  }
  return { candidates: compacted.length, chars: serialized.length };
}
