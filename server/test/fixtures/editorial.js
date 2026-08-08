/**
 * Candidate fixtures for the editorial tests.
 *
 * Shaped exactly like Phase 7 output — the same field names discoverTopics()
 * produces — so a test that passes here is evidence about the real pipeline
 * rather than about a convenient shape invented for testing.
 */

export const PERSONA = Object.freeze({
  name: 'Sentinel',
  domain: 'AI Security',
  description: 'Tracks how AI systems fail under adversarial pressure.',
  voice: 'Precise, sceptical, no hype.',
  interests: ['prompt injection', 'model supply chain', 'agent sandboxing'],
  editorialStandards: ['Prefer primary technical disclosures', 'Never speculate beyond the evidence'],
});

/** A detailed primary technical disclosure. The one a real editor should want. */
export const STRONG = Object.freeze({
  title: 'Prompt injection via indirect tool output bypasses agent sandbox in production frameworks',
  summary:
    'Researchers describe a reproducible technique in which untrusted tool output is treated as '
    + 'instructions by an agent loop, escaping the sandbox boundary. The writeup includes a proof-of-concept '
    + 'and affected version ranges, with a vendor advisory and patch published alongside the analysis.',
  url: 'https://research.example.org/prompt-injection-sandbox-escape',
  source: 'Example Research Feed',
  publishedAt: '2026-08-07T09:00:00.000Z',
  corroboration: 2,
  relevance: 0.91,
  score: 8.4,
  tier: 'primary',
});

/** Vendor marketing wearing a headline. Three copies of it prove nothing. */
export const PROMOTIONAL = Object.freeze({
  title: 'Acme announces industry-leading AI security platform, named a leader in new report',
  summary:
    'Acme today announced the general availability of its AI security platform, which the company '
    + 'says is now available to all customers. A webinar is scheduled to introduce the launch.',
  url: 'https://wire.example.net/acme-announces-platform',
  source: 'Second Wire',
  publishedAt: '2026-08-07T11:00:00.000Z',
  corroboration: 3,
  relevance: 0.44,
  score: 6.9,
  tier: 'secondary',
});

/** On-domain but too thin to write about responsibly. */
export const THIN = Object.freeze({
  title: 'AI security remains a growing concern for enterprises',
  summary: 'Analysts note continued interest in the space.',
  url: 'https://security.example.com/ai-security-concern',
  source: 'Example Security News',
  publishedAt: '2026-08-06T08:00:00.000Z',
  corroboration: 1,
  relevance: 0.31,
  score: 4.2,
  tier: 'secondary',
});

/** Shares vocabulary with the beat without belonging to it. */
export const OFF_DOMAIN = Object.freeze({
  title: 'City council approves security upgrades for municipal parking system',
  summary: 'The council voted to fund new hardware for parking enforcement across three districts.',
  url: 'https://security.example.com/parking-security-upgrade',
  source: 'Example Security News',
  publishedAt: '2026-08-07T07:00:00.000Z',
  corroboration: 1,
  relevance: 0.05,
  score: 2.1,
  tier: 'secondary',
});

/** Build a shortlist of n plausible candidates with distinct titles and urls. */
export function manyCandidates(count, overrides = {}) {
  return Array.from({ length: count }, (_unused, index) => ({
    title: `Reproducible sandbox escape ${index + 1} disclosed with proof-of-concept and advisory`,
    summary:
      `Detailed technical analysis number ${index + 1} describing an exploit path, the affected `
      + 'version range, and the vendor patch, with enough detail to verify the claim independently.',
    url: `https://research.example.org/disclosure-${index + 1}`,
    source: 'Example Research Feed',
    publishedAt: '2026-08-07T09:00:00.000Z',
    corroboration: 1,
    relevance: 0.8,
    score: 8 - index * 0.1,
    tier: 'primary',
    ...overrides,
  }));
}

/** A schema-valid publish decision, for tests that drive the mock directly. */
export function publishDecision(overrides = {}) {
  return {
    decision: 'publish',
    selectedCandidateIndex: 1,
    confidence: 0.86,
    reason: 'The disclosure is specific, reproducible, and squarely on this agent\'s beat.',
    angle: 'What the sandbox escape means for teams running agent loops in production.',
    evidence: ['Proof-of-concept and affected versions are described in the summary.'],
    rejectionReasons: ['The other item is a vendor announcement.'],
    ...overrides,
  };
}

/** A schema-valid skip decision. */
export function skipDecision(overrides = {}) {
  return {
    decision: 'skip',
    selectedCandidateIndex: null,
    confidence: 0.79,
    reason: 'Nothing in this cycle is specific enough to write about without speculating.',
    angle: null,
    evidence: [],
    rejectionReasons: ['Only promotional and generic items were available.'],
    ...overrides,
  };
}
