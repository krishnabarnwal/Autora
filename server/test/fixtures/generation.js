/**
 * Fixtures for the Phase 10 generation tests.
 *
 * Shaped exactly like the real inputs the generator sees at runtime: a candidate
 * in Phase 7's `toCandidate` shape, and an editorial decision in the shape
 * evaluateCandidates() returns. A test that passes here is evidence about the
 * real pipeline, not about a convenient shape invented for testing.
 */
import { PERSONA } from './editorial.js';

export { PERSONA };

/**
 * A strong, primary technical candidate — the Phase 7 `toCandidate` shape,
 * including `sources` (source *names*, not URLs) and a single real `url`.
 */
export const CANDIDATE = Object.freeze({
  title: 'Prompt injection via indirect tool output bypasses agent sandbox in production frameworks',
  url: 'https://research.example.org/prompt-injection-sandbox-escape',
  summary:
    'Researchers describe a reproducible technique in which untrusted tool output is treated as '
    + 'instructions by an agent loop, escaping the sandbox boundary. The writeup includes a proof-of-concept '
    + 'and affected version ranges, with a vendor advisory and patch published alongside the analysis.',
  publishedAt: '2026-08-07T09:00:00.000Z',
  source: 'Example Research Feed',
  score: 8.4,
  relevance: 0.91,
  corroboration: 2,
  sources: ['Example Research Feed', 'Second Outlet'],
  normalizedTopic: 'agent bypass injection output prompt sandbox tool',
});

/** The same candidate carrying a real corroborating URL in `sources`, for the multi-source path. */
export const CANDIDATE_MULTI_URL = Object.freeze({
  ...CANDIDATE,
  sources: ['https://research.example.org/prompt-injection-sandbox-escape', 'https://mirror.example.net/poc-writeup'],
});

/**
 * A publish decision in the shape evaluateCandidates() returns. Only the fields
 * the generator reads are load-bearing; the rest mirror the real object so a
 * test never accidentally depends on their absence.
 *
 * @param {object} [overrides] merged over the defaults; pass `candidate: X` to swap the story
 */
export function publishDecisionResult(overrides = {}) {
  const candidate = overrides.candidate ?? CANDIDATE;
  return {
    decision: 'publish',
    selectedCandidateIndex: 1,
    candidate,
    confidence: 0.86,
    reason: 'The disclosure is specific, reproducible, and squarely on this agent\'s beat.',
    angle: 'What the sandbox escape means for teams running agent loops in production, and what the evidence does not yet show.',
    evidence: ['Proof-of-concept and affected versions are described in the summary.'],
    rejectionReasons: ['The other item is a vendor announcement.'],
    source: 'llm',
    llmCalls: 1,
    llmAttempts: 1,
    usage: null,
    provider: 'mock',
    model: 'mock-1',
    ...overrides,
  };
}

/** A skip decision in the same shape; the generator must produce zero calls for it. */
export function skipDecisionResult(overrides = {}) {
  return {
    decision: 'skip',
    selectedCandidateIndex: null,
    candidate: null,
    confidence: 0.79,
    reason: 'Nothing in this cycle is specific enough to write about without speculating.',
    angle: null,
    evidence: [],
    rejectionReasons: ['Only promotional and generic items were available.'],
    source: 'llm',
    llmCalls: 1,
    ...overrides,
  };
}

/**
 * A valid four-field model response, sized for the given platform so it clears
 * the content floor without breaching the ceiling.
 *
 * @param {object} [options]
 * @param {object} [options.candidate] the candidate whose URL is the only source
 * @param {number} [options.minChars] pad the body to at least this length
 * @param {object} [options.overrides] merged over the produced fields
 */
export function validGeneration({ candidate = CANDIDATE, minChars = 220, overrides = {} } = {}) {
  let text =
    'A reproducible prompt-injection technique lets untrusted tool output escape an agent sandbox. '
    + 'The writeup includes a proof-of-concept and affected versions, with a vendor patch alongside it. '
    + 'If you run agent loops in production, treat tool output as untrusted input, not as instructions.';
  while (text.length < minChars) {
    text += ' Review where your agent trusts tool output, and gate it behind an explicit allow list.';
  }
  return {
    text,
    hook: 'Untrusted tool output just became an agent sandbox escape.',
    hashtags: ['#AISecurity', '#PromptInjection', '#AgentSecurity'],
    sourceUrls: [candidate.url],
    ...overrides,
  };
}

/** Build an over-limit body of the given length; used for the too-long path. */
export const oversizedText = (length) => 'x'.repeat(length);
