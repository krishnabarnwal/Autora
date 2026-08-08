/**
 * Deterministic editorial behaviour for LLM_PROVIDER=mock.
 *
 * The generic mock synthesizes a response field by field from the schema, which
 * cannot satisfy a cross-field rule: it would happily emit `decision: "skip"`
 * alongside a non-null `selectedCandidateIndex`, and verify.js would rightly
 * reject roughly half of all demo cycles. So the editorial module supplies its
 * own script and keeps that knowledge here rather than in the provider.
 *
 * What this is: a stand-in that exercises the real code path end to end on zero
 * quota — precheck, prompt, parse, schema validation, verification, confidence
 * gate. What it is not: editorial judgement. The heuristics below are a fixture,
 * deliberately crude, and no production decision should ever depend on them.
 */
import { DECISIONS } from './schema.js';

/** Signals that a story is specific and technical rather than announcement-shaped. */
const SPECIFIC = /\b(CVE-\d{4}-\d{4,7}|proof[- ]of[- ]concept|advisory|patch|exploit|vulnerabilit|disclosure|writeup|technical|analysis|research)\b/i;
/** Signals that a story is vendor marketing wearing a headline. */
const PROMOTIONAL = /\b(announce[sd]?|launch(e[sd])?|unveil(s|ed)?|introduc(es|ing)|partner(ship|s)?|award|leader in|press release|now available|webinar|sponsored)\b/i;

/** URLs inside echoed prose would look fabricated to the verifier. Strip them. */
const stripUrls = (text) => String(text || '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();

const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`);

/**
 * Recover the candidate array from the prompt.
 *
 * The script sees only what the model sees, on purpose: if this reached around
 * the prompt for richer data, mock mode would stop proving that the prompt
 * carries enough to decide on.
 *
 * @returns {object[]} empty when the prompt carries no parsable array
 */
export function extractCandidates(prompt) {
  for (const line of String(prompt).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not the line we wanted; keep looking.
    }
  }
  return [];
}

/**
 * Crude editorial strength, from the visible fields only.
 *
 * Note what it does *not* do: reward corroboration on its own. Three outlets
 * reprinting one announcement stay promotional here, which keeps mock mode
 * consistent with what the system prompt asks a real model to do.
 */
function strength(candidate) {
  const text = `${candidate.title || ''} ${candidate.summary || ''}`;
  let score = 0;

  if (SPECIFIC.test(text)) score += 3;
  if (PROMOTIONAL.test(text)) score -= 3;
  if (String(candidate.summary || '').trim().length >= 120) score += 1;
  if (candidate.publishedAt) score += 1;
  // Corroboration is a tiebreak, never a substitute for substance.
  if ((candidate.corroboration ?? 1) > 1 && score > 0) score += 1;

  return score;
}

/** The bar a candidate must clear to be worth publishing about. */
const PUBLISH_THRESHOLD = 3;

/**
 * Produce one editorial decision for the mock provider.
 *
 * Deterministic by construction: same prompt in, same decision out, with no
 * clock, no randomness and no network.
 *
 * @param {string} prompt the built editorial prompt
 * @returns {{json: object}} a mock provider script entry
 */
export function editorialMockScript(prompt) {
  const candidates = extractCandidates(prompt);
  // The prompt says this plainly when the operator has disabled declining.
  const mustPublish = /configured to publish every cycle/i.test(String(prompt));

  if (!candidates.length) {
    return {
      json: {
        decision: DECISIONS.SKIP,
        selectedCandidateIndex: null,
        confidence: 1,
        reason: 'No candidates were supplied in this cycle, so there is nothing to evaluate.',
        angle: null,
        evidence: [],
        rejectionReasons: ['Empty candidate list'],
      },
    };
  }

  const ranked = candidates
    .map((candidate, index) => ({ candidate, id: candidate.id ?? index + 1, score: strength(candidate) }))
    // Stable: ties fall back to the id, so ordering never depends on sort internals.
    .sort((a, b) => (b.score - a.score) || (a.id - b.id));

  const best = ranked[0];
  const rejected = ranked.slice(1, 6).map(({ candidate, score }) =>
    clip(`${clip(stripUrls(candidate.title) || 'untitled', 90)} — ${
      score <= 0 ? 'reads as promotional or non-specific' : 'weaker evidence than the selection'}`, 300));

  if (best.score < PUBLISH_THRESHOLD && !mustPublish) {
    return {
      json: {
        decision: DECISIONS.SKIP,
        selectedCandidateIndex: null,
        confidence: 0.8,
        reason: clip(
          'Nothing here clears the bar: the strongest candidate is announcement-shaped or too '
            + 'thinly evidenced to write about responsibly, and publishing it would only restate a headline.',
          600
        ),
        angle: null,
        evidence: [],
        rejectionReasons: ranked.slice(0, 5).map(({ candidate, score }) =>
          clip(`${clip(stripUrls(candidate.title) || 'untitled', 90)} — ${
            score <= 0 ? 'promotional or non-specific' : 'insufficient technical detail'}`, 300)),
      },
    };
  }

  // Confidence tracks how far past the bar the winner sits, capped below 1: a
  // mock claiming certainty would be the wrong thing to teach the pipeline.
  const confidence = mustPublish && best.score < PUBLISH_THRESHOLD
    ? 0.45
    : Math.min(0.92, 0.62 + best.score * 0.05);

  const title = clip(stripUrls(best.candidate.title) || 'the selected story', 120);

  return {
    json: {
      decision: DECISIONS.PUBLISH,
      selectedCandidateIndex: best.id,
      confidence: Number(confidence.toFixed(2)),
      reason: clip(
        `"${title}" is the most specific and best-evidenced item on this agent's beat in this cycle.`,
        600
      ),
      angle: clip(`What ${title} actually changes for practitioners, and what the evidence does not yet show.`, 300),
      evidence: [
        clip(`Reported by ${clip(String(best.candidate.source || 'an unnamed source'), 80)}${
          best.candidate.publishedAt ? ` on ${String(best.candidate.publishedAt).slice(0, 10)}` : ''}.`, 300),
        clip(`Corroboration count in the supplied material: ${best.candidate.corroboration ?? 1}.`, 300),
      ],
      rejectionReasons: rejected,
    },
  };
}
