import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidates } from '../../src/services/editorial/index.js';
import { createMockProvider } from '../../src/services/llm/mockProvider.js';
import { UsageTracker } from '../../src/services/llm/usage.js';
import { MAX_CANDIDATES, MAX_SUMMARY_CHARS } from '../../src/services/llm/candidates.js';
import { discoverTopics } from '../../src/services/topics/index.js';
import { createRssSource } from '../../src/services/sources/rssAdapter.js';
import { createHackerNewsSource } from '../../src/services/sources/hackerNewsAdapter.js';
import {
  RSS_SECURITY, ATOM_RESEARCH, RSS_DUPLICATES, NOT_A_FEED, HN_JSON, NOW, fakeFetch,
} from '../fixtures/feeds.js';
import {
  PERSONA, STRONG, PROMOTIONAL, THIN, OFF_DOMAIN, manyCandidates, publishDecision, skipDecision,
} from '../fixtures/editorial.js';

/**
 * Cost control.
 *
 * The project's economics rest on one number: a cycle that has candidates costs
 * exactly one LLM call, and a cycle that does not costs zero. At demo cadence
 * over a 48-hour evaluation that is the difference between a working budget and
 * an exhausted one, so it is tested directly rather than assumed from the code
 * reading as if it only calls once.
 */

/** Records every generateJSON invocation so call count is measured, not inferred. */
function countingProvider(script, options = {}) {
  const usage = new UsageTracker();
  const provider = createMockProvider({ script, usage, retries: 0, ...options });
  return { provider, usage, get calls() { return provider.calls.length; } };
}

const evaluate = (candidates, options = {}) =>
  evaluateCandidates(candidates, { persona: PERSONA, now: NOW, ...options });

test('cost: a normal cycle with candidates makes exactly one LLM invocation', async () => {
  const { provider, usage } = countingProvider([{ json: publishDecision() }]);

  const result = await evaluate([STRONG, PROMOTIONAL, THIN], { provider });

  assert.equal(provider.calls.length, 1, 'the provider must be invoked exactly once');
  assert.equal(usage.calls, 1);
  assert.equal(result.llmCalls, 1);
});

test('cost: eight candidates still make exactly one invocation, not eight', async () => {
  // The failure this guards against is the obvious refactor — scoring each
  // candidate individually — which would multiply the bill by the shortlist size.
  const { provider } = countingProvider([{ json: publishDecision() }]);

  await evaluate(manyCandidates(8), { provider, maxCandidates: 8 });

  assert.equal(provider.calls.length, 1);
});

test('cost: the single call carries the whole shortlist, proving it was not split', async () => {
  const { provider } = countingProvider([{ json: publishDecision() }]);

  await evaluate(manyCandidates(8), { provider, maxCandidates: 8 });

  const [{ prompt }] = provider.calls;
  for (let index = 1; index <= 8; index += 1) {
    assert.ok(prompt.includes(`disclosure-${index}`), `candidate ${index} must be in the one prompt`);
  }
});

test('cost: a zero-candidate cycle spends nothing', async () => {
  const { provider, usage } = countingProvider([{ json: skipDecision() }]);

  const result = await evaluate([], { provider });

  assert.equal(provider.calls.length, 0);
  assert.equal(usage.calls, 0);
  assert.equal(result.llmCalls, 0);
  assert.equal(result.decision, 'skip');
});

test('cost: a cycle whose candidates are all unusable spends nothing', async () => {
  const { provider } = countingProvider([{ json: skipDecision() }]);

  const result = await evaluate([{ title: 'no url' }, { summary: 'no title' }], { provider });

  assert.equal(provider.calls.length, 0);
  assert.equal(result.llmCalls, 0);
});

test('cost: a cycle whose candidates are all locally irrelevant spends nothing', async () => {
  const { provider } = countingProvider([{ json: skipDecision() }]);

  const result = await evaluate(
    [{ ...STRONG, relevance: 0 }, { ...THIN, relevance: 0 }],
    { provider }
  );

  assert.equal(provider.calls.length, 0);
  assert.equal(result.llmCalls, 0);
  assert.equal(result.decision, 'skip');
});

test('cost: an over-limit cycle fails before spending anything', async () => {
  const { provider } = countingProvider([{ json: publishDecision() }]);

  await assert.rejects(() => evaluate(manyCandidates(11), { provider, maxCandidates: 8 }));

  assert.equal(provider.calls.length, 0);
});

test('cost: a retried transport failure stays one editorial call', async () => {
  // usage.calls counts attempts, so a retried 429 reads as two there. The
  // editorial count must stay 1, or the one-call test would be measuring the
  // transport layer instead of the cycle.
  const { provider, usage } = countingProvider(
    [{ error: 'rate_limited' }, { json: publishDecision() }],
    { retries: 1 }
  );

  const result = await evaluate([STRONG, PROMOTIONAL], { provider });

  assert.equal(result.decision, 'publish');
  assert.equal(provider.calls.length, 1, 'one editorial invocation');
  assert.equal(result.llmCalls, 1, 'one editorial call');
  assert.equal(usage.calls, 2, 'two transport attempts');
  assert.equal(result.llmAttempts, 2, 'the retry stays visible rather than averaging out');
});

test('cost: a failed cycle does not retry with a different prompt', async () => {
  // Re-asking after a rejected decision would double the cost and give the
  // model a second chance at output we already decided not to trust.
  const { provider } = countingProvider([{ json: skipDecision({ selectedCandidateIndex: 1 }) }]);

  const result = await evaluate([STRONG, PROMOTIONAL], { provider });

  assert.equal(result.decision, 'skip');
  assert.equal(provider.calls.length, 1);
});

test('cost: usage counters advance for a spent cycle and stand still for a free one', async () => {
  const { provider, usage } = countingProvider([{ json: publishDecision() }]);

  await evaluate([], { provider });
  assert.equal(usage.snapshot().calls, 0);
  assert.equal(usage.snapshot().totalTokens, 0);

  const result = await evaluate([STRONG, PROMOTIONAL], { provider });
  const snapshot = usage.snapshot();

  assert.equal(snapshot.calls, 1);
  assert.equal(snapshot.successful, 1);
  assert.ok(snapshot.inputTokens > 0);
  assert.ok(snapshot.outputTokens > 0);
  assert.equal(result.usage.totalTokens, snapshot.totalTokens);
});

test('bounded: the prompt carries the compacted payload, never the Phase 7 originals', async () => {
  const { provider } = countingProvider([{ json: publishDecision() }]);

  await evaluate([STRONG, PROMOTIONAL, THIN, OFF_DOMAIN], { provider });

  const [{ prompt }] = provider.calls;

  // Scoring internals are how we ranked; sending them costs tokens and invites
  // the model to ratify our arithmetic instead of judging.
  assert.doesNotMatch(prompt, /"score"/);
  assert.doesNotMatch(prompt, /"relevance"/);
  assert.doesNotMatch(prompt, /"tier"/);
  assert.doesNotMatch(prompt, /"normalizedTopic"/);
});

test('bounded: exactly the compacted field set reaches the model', async () => {
  const { provider } = countingProvider([{ json: publishDecision() }]);

  await evaluate([STRONG, PROMOTIONAL], { provider });

  const payload = JSON.parse(provider.calls[0].prompt.match(/^\[.*\]$/m)[0]);
  assert.deepEqual(
    Object.keys(payload[0]).sort(),
    ['corroboration', 'id', 'publishedAt', 'source', 'summary', 'title', 'url']
  );
});

test('bounded: long summaries are truncated before they reach the prompt', async () => {
  const { provider } = countingProvider([{ json: publishDecision() }]);
  const bloated = { ...STRONG, summary: 'x'.repeat(5_000) };

  await evaluate([bloated, PROMOTIONAL], { provider });

  const payload = JSON.parse(provider.calls[0].prompt.match(/^\[.*\]$/m)[0]);
  assert.ok(payload[0].summary.length <= MAX_SUMMARY_CHARS + 1, 'summary must be capped');
  assert.ok(provider.calls[0].prompt.length < 8_000);
});

test('bounded: the configured maximum bounds the payload end to end', async () => {
  // Going over the cap is a caller bug and throws (covered above), so the cap
  // is exercised at its boundary: a full shortlist compacts to exactly that
  // many entries and no more.
  const { provider } = countingProvider([{ json: publishDecision() }]);

  await evaluate(manyCandidates(3), { provider, maxCandidates: 3 });

  const payload = JSON.parse(provider.calls[0].prompt.match(/^\[.*\]$/m)[0]);
  assert.equal(payload.length, 3);
  assert.deepEqual(payload.map((entry) => entry.id), [1, 2, 3]);
  assert.ok(payload.length <= MAX_CANDIDATES);
});

test('bounded: the orchestrator never re-fetches sources', async () => {
  // Phase 9 judges what Phase 7 found. A network call here would mean the two
  // phases had drifted into doing each other's work.
  const { provider } = countingProvider([{ json: publishDecision() }]);
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetches += 1;
    return originalFetch(...args);
  };

  try {
    await evaluate([STRONG, PROMOTIONAL], { provider });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetches, 0, 'editorial judgement must make no network request of its own');
});

test('bounded: raw feed bodies never reach the prompt', async () => {
  // The full path, from fixture feeds through discovery into one editorial call.
  const discovered = await discoverTopics({
    sources: [
      createRssSource({ id: 'sec', name: 'Example Security News', url: 'https://security.example.com/feed', tier: 'secondary', tags: ['security', 'ai security'] }),
      createRssSource({ id: 'res', name: 'Example Research Feed', url: 'https://research.example.org/atom.xml', tier: 'primary', tags: ['research', 'ai security'] }),
      createRssSource({ id: 'wire', name: 'Second Wire', url: 'https://wire.example.net/feed', tier: 'secondary', tags: ['security'] }),
      createRssSource({ id: 'html', name: 'Login Page', url: 'https://html.example.com/feed', tier: 'secondary', tags: ['security'] }),
      createHackerNewsSource({ id: 'hn', name: 'Hacker News (AI security)', query: 'AI security', tags: ['community'] }),
    ],
    now: NOW,
    fetchImpl: fakeFetch({
      'https://security.example.com/feed': RSS_SECURITY,
      'https://research.example.org/atom.xml': ATOM_RESEARCH,
      'https://wire.example.net/feed': RSS_DUPLICATES,
      'https://html.example.com/feed': { body: NOT_A_FEED, contentType: 'text/html' },
      'https://hn.algolia.com/api/v1/search_by_date': { body: HN_JSON, contentType: 'application/json' },
    }),
    limit: 8,
  });

  const { provider } = countingProvider([{ json: publishDecision() }]);
  const result = await evaluate(discovered.candidates, { provider, maxCandidates: 8 });

  const [{ prompt }] = provider.calls;
  assert.doesNotMatch(prompt, /<rss|<feed|<\?xml|<item>|<entry>/i);
  assert.doesNotMatch(prompt, /<!DOCTYPE|<html/i);

  // The economics, stated as an assertion: local phases reduce, and whatever
  // survives crosses into exactly one small call. The fixture corpus is tiny
  // next to production (~1,700 raw items), so the ratio asserted here is
  // deliberately modest — the shape is what matters.
  assert.ok(discovered.stats.collected > discovered.candidates.length,
    `expected local reduction, saw ${discovered.stats.collected} collected `
      + `and ${discovered.candidates.length} candidates`);
  assert.equal(provider.calls.length, 1);
  assert.equal(result.llmCalls, 1);
  assert.ok(prompt.length < 8_000, `prompt is ${prompt.length} chars`);
});

test('bounded: rejected and duplicate items never appear in the prompt', async () => {
  const discovered = await discoverTopics({
    sources: [
      createRssSource({ id: 'sec', name: 'Example Security News', url: 'https://security.example.com/feed', tier: 'secondary', tags: ['security', 'ai security'] }),
      createRssSource({ id: 'wire', name: 'Second Wire', url: 'https://wire.example.net/feed', tier: 'secondary', tags: ['security'] }),
    ],
    now: NOW,
    fetchImpl: fakeFetch({
      'https://security.example.com/feed': RSS_SECURITY,
      'https://wire.example.net/feed': RSS_DUPLICATES,
    }),
    limit: 4,
  });

  const { provider } = countingProvider([{ json: publishDecision() }]);
  await evaluate(discovered.candidates, { provider, maxCandidates: 4 });

  const [{ prompt }] = provider.calls;
  const shortlisted = new Set(discovered.candidates.map((candidate) => candidate.url));
  const excluded = [...discovered.rejected, ...discovered.duplicates]
    .map((item) => item.url)
    .filter((url) => url && !shortlisted.has(url));

  assert.ok(excluded.length > 0, 'fixture should exclude something worth asserting on');
  for (const url of excluded) {
    assert.ok(!prompt.includes(url), `excluded item ${url} must not reach the prompt`);
  }
});
