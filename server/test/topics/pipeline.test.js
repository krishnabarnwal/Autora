import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverTopics, SENTINEL_PERSONA, DEFAULT_CANDIDATE_LIMIT } from '../../src/services/topics/index.js';
import { createRssSource } from '../../src/services/sources/rssAdapter.js';
import { createHackerNewsSource } from '../../src/services/sources/hackerNewsAdapter.js';
import {
  RSS_SECURITY, ATOM_RESEARCH, RSS_DUPLICATES, NOT_A_FEED, HN_JSON, NOW, fakeFetch,
} from '../fixtures/feeds.js';

const ROUTES = {
  'https://security.example.com/feed': RSS_SECURITY,
  'https://research.example.org/atom.xml': ATOM_RESEARCH,
  'https://wire.example.net/feed': RSS_DUPLICATES,
  'https://hn.algolia.com/api/v1/search_by_date': { body: HN_JSON, contentType: 'application/json' },
  'https://dead.example.com/feed': { status: 500, body: 'boom' },
  'https://html.example.com/feed': { body: NOT_A_FEED, contentType: 'text/html' },
};

function sources() {
  return [
    createRssSource({ id: 'sec', name: 'Example Security News', url: 'https://security.example.com/feed', tier: 'secondary', tags: ['security', 'ai security'] }),
    createRssSource({ id: 'res', name: 'Example Research Feed', url: 'https://research.example.org/atom.xml', tier: 'primary', tags: ['research', 'ai security'] }),
    createRssSource({ id: 'wire', name: 'Second Wire', url: 'https://wire.example.net/feed', tier: 'secondary', tags: ['security'] }),
    createRssSource({ id: 'dead', name: 'Dead Feed', url: 'https://dead.example.com/feed', tier: 'secondary', tags: ['security'] }),
    createRssSource({ id: 'html', name: 'Login Page', url: 'https://html.example.com/feed', tier: 'secondary', tags: ['security'] }),
    createHackerNewsSource({ id: 'hn', name: 'Hacker News (AI security)', query: 'AI security', tags: ['community'] }),
  ];
}

const run = (options = {}) => discoverTopics({
  sources: sources(), now: NOW, fetchImpl: fakeFetch(ROUTES), ...options,
});

test('pipeline: collect -> filter -> dedupe -> rank produces a small candidate set', async () => {
  const { candidates, stats } = await run();

  assert.equal(stats.collection.sourcesAttempted, 6);
  assert.equal(stats.collection.sourcesSucceeded, 4, 'two broken sources are skipped, not fatal');
  assert.ok(stats.collected > candidates.length, `${stats.collected} raw items narrowed to ${candidates.length}`);

  // Phase 9 wants a handful, not a haystack.
  assert.ok(candidates.length >= 1 && candidates.length <= DEFAULT_CANDIDATE_LIMIT, `got ${candidates.length}`);
  assert.equal(stats.llmCalls, 0, 'phases 6-7 spend no tokens');

  // Each stage narrowed the set.
  assert.ok(stats.filter.kept < stats.filter.received);
  assert.ok(stats.dedupe.unique <= stats.dedupe.received);
});

test('pipeline: the candidate shape is exactly what Phase 9 consumes', async () => {
  const { candidates } = await run();
  const candidate = candidates[0];

  assert.deepEqual(Object.keys(candidate).sort(), [
    'corroboration', 'normalizedTopic', 'publishedAt', 'relevance', 'score', 'source', 'sources', 'summary', 'title', 'url',
  ]);
  assert.equal(typeof candidate.title, 'string');
  assert.match(candidate.url, /^https:\/\//);
  assert.ok(candidate.publishedAt === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate.publishedAt));
  assert.ok(candidate.score > 0 && candidate.score <= 1);
  assert.ok(Array.isArray(candidate.sources) && candidate.sources.length >= 1);
  assert.ok(candidate.normalizedTopic.length > 0);
});

test('pipeline: candidates are ordered by score, highest first', async () => {
  const { candidates } = await run();
  const scores = candidates.map((candidate) => candidate.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('pipeline: cross-source duplicates collapse into one corroborated candidate', async () => {
  const { candidates, duplicates } = await run();

  // Three outlets carried the exfiltration story: one identical URL, one
  // reworded headline. A different prompt-injection story (the HN scanner) is
  // not the same topic and must survive separately.
  const exfiltration = candidates.filter((candidate) => /exfiltrate/i.test(candidate.title));
  assert.equal(exfiltration.length, 1, 'the same story from two outlets must not appear twice');
  assert.ok(exfiltration[0].corroboration >= 2, `corroboration was ${exfiltration[0].corroboration}`);
  assert.ok(exfiltration[0].sources.length >= 2);
  assert.ok(duplicates.length >= 2, 'duplicates are recorded, not silently dropped');

  const urls = candidates.map((candidate) => candidate.url);
  assert.equal(new Set(urls).size, urls.length, 'no duplicate URLs survive');
  const topics = candidates.map((candidate) => candidate.normalizedTopic);
  assert.equal(new Set(topics).size, topics.length, 'no duplicate topics survive');
});

test('pipeline: rejections are reported with reasons', async () => {
  const { rejected } = await run();
  assert.ok(rejected.length > 0);
  const reasons = new Set(rejected.map((entry) => entry.reason));
  assert.ok(reasons.has('irrelevant'));
  assert.ok(reasons.has('stale'));
  assert.ok(reasons.has('low_value_title'));
  for (const entry of rejected) {
    assert.equal(typeof entry.title, 'string');
    assert.equal(typeof entry.reason, 'string');
  }
});

test('pipeline: the same input always produces the same output', async () => {
  const [first, second] = await Promise.all([run(), run()]);
  assert.deepEqual(first.candidates, second.candidates);
  assert.deepEqual(first.stats.filter, second.stats.filter);
});

test('pipeline: the persona drives selection', async () => {
  const sentinel = await run({ persona: SENTINEL_PERSONA });
  const pastryChef = await run({ persona: { name: 'Baker', domain: 'Artisan Baking' } });

  assert.ok(sentinel.candidates.length >= 3);
  assert.equal(pastryChef.candidates.length, 0, 'a baking persona finds nothing in a security feed');
  assert.ok(sentinel.candidates.every((candidate) => candidate.relevance > 0));
});

test('pipeline: an explicit limit is honoured', async () => {
  const { candidates } = await run({ limit: 2 });
  assert.equal(candidates.length, 2);
});

test('pipeline: every source failing yields no candidates and no crash', async () => {
  const { candidates, stats } = await discoverTopics({
    sources: sources(), now: NOW, fetchImpl: fakeFetch({}),
  });
  assert.deepEqual(candidates, []);
  assert.equal(stats.collection.sourcesSucceeded, 0);
  assert.equal(stats.candidates, 0);
});

test('pipeline: accepts pre-collected items, so later phases can replay a cycle', async () => {
  const items = [
    { title: 'Prompt injection bypasses a production agent guardrail', url: 'https://a.example.com/1', summary: 'Mechanism described in detail by the reporting researchers.', publishedAt: new Date(NOW - 3600_000).toISOString(), source: 'A', sourceTier: 'primary', sourceTags: ['ai security'] },
    { title: 'Local bakery wins county pastry award again', url: 'https://a.example.com/2', summary: 'Not security.', publishedAt: new Date(NOW - 3600_000).toISOString(), source: 'A', sourceTier: 'primary', sourceTags: [] },
  ];
  const { candidates, stats } = await discoverTopics({ items, now: NOW, persona: SENTINEL_PERSONA });

  assert.equal(stats.collection, null, 'no collection ran');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, 'Prompt injection bypasses a production agent guardrail');
});

test('pipeline: the default persona is a default, not a hard-coding', () => {
  assert.equal(SENTINEL_PERSONA.name, 'Sentinel');
  assert.equal(SENTINEL_PERSONA.domain, 'AI Security');
  assert.ok(SENTINEL_PERSONA.interests.includes('prompt injection'));
});
