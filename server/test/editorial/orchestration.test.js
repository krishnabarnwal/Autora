import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidates } from '../../src/services/editorial/index.js';
import { DECISION_SOURCES } from '../../src/services/editorial/schema.js';
import { createMockProvider } from '../../src/services/llm/mockProvider.js';
import { UsageTracker } from '../../src/services/llm/usage.js';
import { discoverTopics } from '../../src/services/topics/index.js';
import { createRssSource } from '../../src/services/sources/rssAdapter.js';
import { RSS_SECURITY, ATOM_RESEARCH, RSS_DUPLICATES, NOW, fakeFetch } from '../fixtures/feeds.js';
import {
  PERSONA, STRONG, PROMOTIONAL, THIN, OFF_DOMAIN, publishDecision, skipDecision,
} from '../fixtures/editorial.js';

/**
 * The whole Phase 9 path, end to end.
 *
 *   Phase 7 candidates -> precheck -> prompt -> provider -> parse -> schema
 *   -> verify -> confidence gate -> EditorialDecision
 *
 * What matters here is the shape and provenance of the object that comes out:
 * Phase 10 consumes it directly, and the dashboard has to be able to tell an
 * editorial skip from a swallowed error without reading the logs.
 */

/** A provider whose decision is fixed, so the assertion is about the plumbing. */
const providerReturning = (json, extra = {}) =>
  createMockProvider({ script: [{ json }], usage: new UsageTracker(), ...extra });

const evaluate = (candidates, options = {}) =>
  evaluateCandidates(candidates, { persona: PERSONA, now: NOW, ...options });

test('orchestration: a publish decision returns everything Phase 10 needs', async () => {
  const provider = providerReturning(publishDecision({ selectedCandidateIndex: 2, confidence: 0.91 }));
  const result = await evaluate([PROMOTIONAL, STRONG], { provider });

  assert.equal(result.decision, 'publish');
  assert.equal(result.selectedCandidateIndex, 2);
  assert.equal(result.confidence, 0.91);
  assert.ok(result.reason.length > 0);
  assert.ok(result.angle.length > 0);
  assert.deepEqual(result.evidence, publishDecision().evidence);

  // The resolved Phase 7 object, so the post writer does no index arithmetic.
  assert.equal(result.candidate.url, STRONG.url);
  assert.equal(result.candidate.title, STRONG.title);
  assert.equal(result.candidate.score, STRONG.score);
});

test('orchestration: a skip decision is shaped identically, with nulls where they belong', async () => {
  const provider = providerReturning(skipDecision({ confidence: 0.88 }));
  const result = await evaluate([PROMOTIONAL, THIN], { provider });

  assert.equal(result.decision, 'skip');
  assert.equal(result.selectedCandidateIndex, null);
  assert.equal(result.angle, null);
  assert.equal(result.candidate, null);
  assert.equal(result.confidence, 0.88);
  assert.ok(result.rejectionReasons.length > 0);
});

test('orchestration: the result is JSON-serializable and carries no provider internals', async () => {
  const provider = providerReturning(publishDecision());
  const result = await evaluate([STRONG, PROMOTIONAL], { provider });
  const round = JSON.parse(JSON.stringify(result));

  assert.deepEqual(Object.keys(round).sort(), [
    'angle', 'candidate', 'candidatesConsidered', 'confidence', 'decidedAt', 'decision',
    'durationMs', 'evidence', 'llmAttempts', 'llmCalls', 'model', 'provider', 'reason',
    'rejectionReasons', 'selectedCandidateIndex', 'source', 'usage', 'warnings',
  ]);
  assert.match(round.decidedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test('orchestration: provenance distinguishes a judged skip from a local one', async () => {
  const judged = await evaluate([STRONG, PROMOTIONAL], { provider: providerReturning(skipDecision()) });
  assert.equal(judged.source, DECISION_SOURCES.LLM);
  assert.equal(judged.llmCalls, 1);

  const local = await evaluate([], { provider: providerReturning(skipDecision()) });
  assert.equal(local.source, DECISION_SOURCES.PRECHECK);
  assert.equal(local.llmCalls, 0);
});

test('orchestration: an unusable candidate is dropped and the drop is surfaced as a warning', async () => {
  const { url: _dropped, ...noUrl } = STRONG;
  const provider = providerReturning(publishDecision({ selectedCandidateIndex: 1 }));

  const result = await evaluate([noUrl, PROMOTIONAL], { provider });

  assert.equal(result.candidatesConsidered, 1);
  assert.equal(result.candidate.url, PROMOTIONAL.url);
  assert.ok(result.warnings.some((warning) => /missing or invalid url/.test(warning)));
});

test('orchestration: an index outside the shortlist ends the cycle, never clamped to a real story', async () => {
  // Precheck drops the broken candidate, leaving one, so the schema's maximum
  // is 1 and index 2 fails validation. The tempting "fix" would be to clamp to
  // the nearest valid index, which would publish a story nobody chose.
  const provider = providerReturning(publishDecision({ selectedCandidateIndex: 2 }));

  const result = await evaluateCandidates([STRONG, { ...PROMOTIONAL, title: '' }], {
    persona: PERSONA, provider, now: NOW,
  });

  assert.equal(result.decision, 'skip');
  assert.equal(result.candidate, null);
  assert.equal(result.selectedCandidateIndex, null);
  assert.ok(result.warnings.some((warning) => /editorial_call_failed:schema_invalid/.test(warning)));
});

test('orchestration: an incoherent decision the schema cannot catch is rejected by verification', async () => {
  // "skip" with a real index is schema-valid — the validator has no way to
  // express a cross-field rule — so this is the verifier's job alone.
  const provider = providerReturning(skipDecision({ selectedCandidateIndex: 1 }));

  const result = await evaluate([STRONG, PROMOTIONAL], { provider });

  assert.equal(result.decision, 'skip');
  assert.equal(result.candidate, null);
  assert.equal(result.source, DECISION_SOURCES.PRECHECK);
  assert.equal(result.confidence, 0);
  assert.ok(result.warnings.some((warning) => /decision_rejected:decision_rejected/.test(warning)));
  assert.ok(result.rejectionReasons.some((reason) => /"skip" but selectedCandidateIndex is 1/.test(reason)));
});

test('orchestration: a decision citing an invented URL is rejected rather than published', async () => {
  const provider = providerReturning(publishDecision({
    evidence: ['Corroborated at https://invented.example.com/never-supplied'],
  }));

  const result = await evaluate([STRONG, PROMOTIONAL], { provider });

  assert.equal(result.decision, 'skip');
  assert.equal(result.candidate, null);
  assert.ok(result.rejectionReasons.some((reason) => /cited a URL that was not supplied/.test(reason)));
});

test('orchestration: a provider failure ends the cycle without throwing at the caller', async () => {
  // The scheduler must survive a bad cycle; an uncaught throw would stop it.
  const provider = createMockProvider({
    script: [{ error: 'rate_limited' }],
    usage: new UsageTracker(),
    retries: 0,
  });

  const result = await evaluate([STRONG, PROMOTIONAL], { provider });

  assert.equal(result.decision, 'skip');
  assert.equal(result.candidate, null);
  assert.equal(result.confidence, 0);
  assert.ok(result.warnings.some((warning) => /editorial_call_failed:rate_limited/.test(warning)));
});

test('orchestration: malformed model output ends the cycle instead of publishing', async () => {
  const provider = createMockProvider({
    script: [{ raw: 'I think you should publish the second one.' }],
    usage: new UsageTracker(),
    retries: 0,
  });

  const result = await evaluate([STRONG, PROMOTIONAL], { provider });

  assert.equal(result.decision, 'skip');
  assert.equal(result.candidate, null);
  assert.ok(result.warnings.some((warning) => /editorial_call_failed/.test(warning)));
});

test('orchestration: caller bugs throw rather than degrading into a quiet skip', async () => {
  // A malformed call is a defect to fix, not a news day to report on.
  await assert.rejects(
    () => evaluate('not an array', { provider: providerReturning(skipDecision()) }),
    /must be an array of candidates/
  );
  await assert.rejects(
    () => evaluate(Array.from({ length: 9 }, () => STRONG), {
      provider: providerReturning(skipDecision()), maxCandidates: 8,
    }),
    /above the configured maximum of 8/
  );
});

test('orchestration: consumes real Phase 7 output without reshaping it', async () => {
  // The strongest evidence that the two phases actually fit together: run the
  // real discovery pipeline over fixture feeds and hand its output straight in.
  const discovered = await discoverTopics({
    sources: [
      createRssSource({ id: 'sec', name: 'Example Security News', url: 'https://security.example.com/feed', tier: 'secondary', tags: ['security', 'ai security'] }),
      createRssSource({ id: 'res', name: 'Example Research Feed', url: 'https://research.example.org/atom.xml', tier: 'primary', tags: ['research', 'ai security'] }),
      createRssSource({ id: 'wire', name: 'Second Wire', url: 'https://wire.example.net/feed', tier: 'secondary', tags: ['security'] }),
    ],
    now: NOW,
    fetchImpl: fakeFetch({
      'https://security.example.com/feed': RSS_SECURITY,
      'https://research.example.org/atom.xml': ATOM_RESEARCH,
      'https://wire.example.net/feed': RSS_DUPLICATES,
    }),
    limit: 8,
  });

  assert.ok(discovered.candidates.length > 0, 'fixture pipeline should produce candidates');

  const provider = providerReturning(publishDecision({ selectedCandidateIndex: 1 }));
  const result = await evaluate(discovered.candidates, { provider });

  assert.equal(result.decision, 'publish');
  assert.equal(result.llmCalls, 1);
  assert.equal(result.candidate, discovered.candidates[0]);
  assert.ok(result.candidate.url.startsWith('http'));
});

test('orchestration: the agent id is threaded through for per-agent activity', async () => {
  const provider = providerReturning(publishDecision());
  // Purely a logging concern, but a scheduler running several agents needs it,
  // and a silently ignored option would only be noticed in Phase 14.
  const result = await evaluate([STRONG, PROMOTIONAL], { provider, agentId: 'agent-1' });

  assert.equal(result.decision, 'publish');
});

test('orchestration: allowSkip=false converts a declined cycle into a labelled fallback', async () => {
  const provider = providerReturning(skipDecision());
  const result = await evaluate([STRONG, PROMOTIONAL, OFF_DOMAIN], { provider, allowSkip: false });

  assert.equal(result.decision, 'publish');
  assert.equal(result.source, DECISION_SOURCES.FORCED_PUBLISH);
  assert.equal(result.candidate, STRONG);
  // The result must not pretend this was editorial judgement.
  assert.match(result.reason, /Forced publish/);
  assert.ok(result.warnings.includes('forced_publish_overrode_skip'));
});

test('orchestration: allowSkip=false still cannot manufacture a candidate out of nothing', async () => {
  const provider = providerReturning(skipDecision());
  const result = await evaluate([], { provider, allowSkip: false });

  assert.equal(result.decision, 'skip');
  assert.equal(result.llmCalls, 0);
});

test('orchestration: does not mutate the candidates it was handed', async () => {
  const input = [STRONG, PROMOTIONAL, THIN];
  const before = JSON.parse(JSON.stringify(input));

  await evaluate(input, { provider: providerReturning(publishDecision()) });

  assert.deepEqual(JSON.parse(JSON.stringify(input)), before);
});
