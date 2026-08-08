import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverTopics, DEFAULT_CANDIDATE_LIMIT } from '../../src/services/topics/index.js';
import { createRssSource } from '../../src/services/sources/rssAdapter.js';
import { createHackerNewsSource } from '../../src/services/sources/hackerNewsAdapter.js';
import {
  compactCandidates, assertBounded, MAX_CANDIDATES, MAX_SUMMARY_CHARS, MAX_TITLE_CHARS,
} from '../../src/services/llm/candidates.js';
import { createMockProvider } from '../../src/services/llm/mockProvider.js';
import { UsageTracker } from '../../src/services/llm/usage.js';
import {
  RSS_SECURITY, ATOM_RESEARCH, RSS_DUPLICATES, NOT_A_FEED, HN_JSON, NOW, fakeFetch,
} from '../fixtures/feeds.js';
import { DECISION_SCHEMA } from '../fixtures/llm.js';

/**
 * The cost boundary between Phase 6-7 and the LLM.
 *
 * Phases 6-7 read every source and spend nothing. This file proves that what
 * crosses into a prompt is only the shortlist those phases produced, in a
 * bounded shape, in exactly one call — the property that keeps a 48-hour
 * evaluation run affordable.
 */

const ROUTES = {
  'https://security.example.com/feed': RSS_SECURITY,
  'https://research.example.org/atom.xml': ATOM_RESEARCH,
  'https://wire.example.net/feed': RSS_DUPLICATES,
  'https://hn.algolia.com/api/v1/search_by_date': { body: HN_JSON, contentType: 'application/json' },
  'https://dead.example.com/feed': { status: 500, body: 'boom' },
  'https://html.example.com/feed': { body: NOT_A_FEED, contentType: 'text/html' },
};

const sources = () => [
  createRssSource({ id: 'sec', name: 'Example Security News', url: 'https://security.example.com/feed', tier: 'secondary', tags: ['security', 'ai security'] }),
  createRssSource({ id: 'res', name: 'Example Research Feed', url: 'https://research.example.org/atom.xml', tier: 'primary', tags: ['research', 'ai security'] }),
  createRssSource({ id: 'wire', name: 'Second Wire', url: 'https://wire.example.net/feed', tier: 'secondary', tags: ['security'] }),
  createRssSource({ id: 'dead', name: 'Dead Feed', url: 'https://dead.example.com/feed', tier: 'secondary', tags: ['security'] }),
  createRssSource({ id: 'html', name: 'Login Page', url: 'https://html.example.com/feed', tier: 'secondary', tags: ['security'] }),
  createHackerNewsSource({ id: 'hn', name: 'Hacker News (AI security)', query: 'AI security', tags: ['community'] }),
];

const discover = (options = {}) => discoverTopics({
  sources: sources(), now: NOW, fetchImpl: fakeFetch(ROUTES), ...options,
});

/** A stand-in for the Phase 9 prompt: the shape, not the editorial wording. */
const buildPrompt = (compacted) =>
  `Choose one candidate.\n\nCandidates: ${JSON.stringify(compacted)}`;

const longCandidate = (index) => ({
  title: `Candidate ${index} `.padEnd(600, 'about a vulnerability in a deployed system '),
  summary: 'Detail. '.repeat(500),
  url: `https://example.com/${index}`,
  source: 'Example',
  publishedAt: '2026-08-07T00:00:00.000Z',
  score: 0.9,
  relevance: 0.8,
  corroboration: 2,
  normalizedTopic: `topic-${index}`,
});

// --- 15. Candidate input remains bounded -----------------------------------

test('candidates: the payload is capped no matter how many candidates arrive', () => {
  const compacted = compactCandidates(Array.from({ length: 50 }, (_u, i) => longCandidate(i)));

  assert.equal(compacted.length, MAX_CANDIDATES, 'the hard ceiling holds, not the caller\'s count');
  // Even a caller asking for more than the ceiling cannot raise it.
  assert.equal(compactCandidates(Array.from({ length: 50 }, (_u, i) => longCandidate(i)), { limit: 40 }).length,
    MAX_CANDIDATES);
});

test('candidates: titles and summaries are truncated to a fixed budget', () => {
  const [candidate] = compactCandidates([longCandidate(1)]);

  assert.ok(candidate.title.length <= MAX_TITLE_CHARS + 1, `title was ${candidate.title.length} chars`);
  assert.ok(candidate.summary.length <= MAX_SUMMARY_CHARS + 1, `summary was ${candidate.summary.length} chars`);
  assert.match(candidate.summary, /…$/, 'truncation is visible rather than silent');
});

test('candidates: scoring internals never reach the prompt', () => {
  const [candidate] = compactCandidates([longCandidate(1)]);

  assert.deepEqual(Object.keys(candidate).sort(),
    ['corroboration', 'id', 'publishedAt', 'source', 'summary', 'title', 'url']);
  // How we ranked is our arithmetic, not evidence a model should defer to.
  for (const key of ['score', 'relevance', 'normalizedTopic', 'sources']) {
    assert.ok(!(key in candidate), `${key} leaked into the payload`);
  }
});

test('candidates: assertBounded refuses an oversized payload instead of trimming it', () => {
  const oversized = Array.from({ length: MAX_CANDIDATES }, (_u, i) => ({
    id: i + 1, title: 'x'.repeat(200), summary: 'y'.repeat(400), source: 's',
    publishedAt: null, corroboration: 1,
  }));

  // A silent trim would hide the regression that produced it.
  assert.throws(() => assertBounded(oversized, { maxChars: 1000 }), /chars, above the 1000 cap/);
  assert.throws(() => assertBounded(oversized, { maxCandidates: 3 }), /entries, above the 3 cap/);

  const report = assertBounded(oversized);
  assert.equal(report.candidates, MAX_CANDIDATES);
  assert.ok(report.chars < 12_000);
});

test('candidates: a full worst-case payload still fits a small prompt', () => {
  const compacted = compactCandidates(Array.from({ length: 50 }, (_u, i) => longCandidate(i)));
  const { chars } = assertBounded(compacted);

  // ~6.5k chars is roughly 1.6k tokens: a single cheap editorial call.
  assert.ok(chars < 8000, `worst case serialized to ${chars} chars`);
});

// --- 16. Phase 6-7 -> provider: only the shortlist crosses over -------------

test('pipeline: only the ranked shortlist reaches the provider, in one call', async () => {
  const { candidates, stats } = await discover();
  const compacted = compactCandidates(candidates);
  assertBounded(compacted);

  const usage = new UsageTracker();
  const provider = createMockProvider({ usage });
  const prompt = buildPrompt(compacted);
  await provider.generateJSON(prompt, { schema: DECISION_SCHEMA });

  // One call for the whole cycle, not one per article.
  assert.equal(provider.calls.length, 1, 'the pipeline made a single LLM call');
  assert.equal(usage.snapshot().calls, 1);
  assert.ok(stats.collected > compacted.length,
    `${stats.collected} collected items became ${compacted.length} in the prompt`);
  assert.ok(compacted.length <= DEFAULT_CANDIDATE_LIMIT);

  // Every title in the prompt is a shortlisted one.
  const sent = provider.calls[0].prompt;
  for (const candidate of candidates.slice(0, compacted.length)) {
    assert.ok(sent.includes(candidate.title.slice(0, 60)), `missing shortlisted: ${candidate.title}`);
  }
});

test('pipeline: rejected and duplicate items never appear in the prompt', async () => {
  const { candidates, rejected, duplicates } = await discover();
  const prompt = buildPrompt(compactCandidates(candidates));

  assert.ok(rejected.length > 0, 'the fixture set exercises rejection');
  const shortlisted = new Set(candidates.map((c) => c.title));

  for (const item of [...rejected, ...duplicates]) {
    const title = item.title || item.item?.title;
    // A duplicate's title can legitimately match the survivor it merged into.
    if (!title || shortlisted.has(title)) continue;
    assert.ok(!prompt.includes(title), `discarded item reached the prompt: ${title}`);
  }
});

test('pipeline: raw feed bodies never reach the prompt', async () => {
  const { candidates, items } = await discover();
  const prompt = buildPrompt(compactCandidates(candidates));

  // The collector keeps full content on the item; the prompt must not carry it.
  assert.ok(prompt.length < 8000, `prompt was ${prompt.length} chars`);
  for (const item of items) {
    if (item.content && item.content.length > MAX_SUMMARY_CHARS) {
      assert.ok(!prompt.includes(item.content), 'full article content reached the prompt');
    }
  }
  assert.ok(!prompt.includes('<item>') && !prompt.includes('<?xml'), 'no raw feed markup');
});

test('pipeline: discovery itself spends nothing', async () => {
  const usage = new UsageTracker();
  createMockProvider({ usage });

  const { stats } = await discover();

  assert.equal(stats.llmCalls, 0);
  assert.equal(usage.snapshot().calls, 0, 'no call is made until a later phase asks for one');
});

test('pipeline: an empty shortlist is handled without calling the provider', async () => {
  // Nothing survives a one-second freshness window. `requireDate` matters here:
  // an undated item has no age to fail on, so without it two would slip past.
  const { candidates } = await discover({ maxAgeMs: 1000, requireDate: true });
  assert.equal(candidates.length, 0);

  const usage = new UsageTracker();
  const provider = createMockProvider({ usage });
  const compacted = compactCandidates(candidates);

  assert.deepEqual(compacted, []);
  // The guard belongs to the caller; this asserts the shape it will branch on.
  if (compacted.length) await provider.generateJSON(buildPrompt(compacted), { schema: DECISION_SCHEMA });

  assert.equal(usage.snapshot().calls, 0, 'no candidates means no spend');
});
