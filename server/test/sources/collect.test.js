import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTopics, listSources, buildSources, SOURCE_DEFINITIONS } from '../../src/services/sources/index.js';
import { createRssSource } from '../../src/services/sources/rssAdapter.js';
import { createHackerNewsSource } from '../../src/services/sources/hackerNewsAdapter.js';
import { fetchText, runPooled } from '../../src/services/sources/http.js';
import {
  RSS_SECURITY, ATOM_RESEARCH, RSS_DUPLICATES, MALFORMED_XML, NOT_A_FEED, EMPTY_FEED, HN_JSON, NOW, fakeFetch,
} from '../fixtures/feeds.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(here, '..', '..', 'src');

const ROUTES = {
  'https://security.example.com/feed': RSS_SECURITY,
  'https://research.example.org/atom.xml': ATOM_RESEARCH,
  'https://wire.example.net/feed': RSS_DUPLICATES,
  'https://hn.algolia.com/api/v1/search_by_date': { body: HN_JSON, contentType: 'application/json' },
};

function testSources(extra = []) {
  return [
    createRssSource({ id: 'sec', name: 'Example Security News', url: 'https://security.example.com/feed', tier: 'secondary', tags: ['security'] }),
    createRssSource({ id: 'res', name: 'Example Research Feed', url: 'https://research.example.org/atom.xml', tier: 'primary', tags: ['research'] }),
    ...extra,
  ];
}

test('collect: fetches every source and returns one normalized list', async () => {
  const calls = [];
  const { items, results, stats } = await collectTopics({
    sources: testSources(),
    now: NOW,
    fetchImpl: fakeFetch(ROUTES, { calls }),
  });

  assert.equal(calls.length, 2, 'one request per source');
  assert.equal(stats.sourcesAttempted, 2);
  assert.equal(stats.sourcesSucceeded, 2);
  assert.equal(stats.sourcesFailed, 0);
  assert.equal(items.length, 9, '6 usable security items + 3 research entries');
  assert.ok(results.every((result) => result.ok));

  // Every item carries the contract fields, whichever adapter produced it.
  for (const item of items) {
    assert.equal(typeof item.title, 'string');
    assert.match(item.url, /^https:\/\//);
    assert.equal(typeof item.summary, 'string');
    assert.ok(item.publishedAt === null || /^\d{4}-\d{2}-\d{2}T/.test(item.publishedAt));
    assert.ok(item.source.length > 0);
  }
});

test('collect: a failing source does not stop the others', async () => {
  const sources = testSources([
    createRssSource({ id: 'dead', name: 'Dead Feed', url: 'https://dead.example.com/feed' }),
    createRssSource({ id: 'html', name: 'Login Page', url: 'https://html.example.com/feed' }),
    createRssSource({ id: 'boom', name: 'DNS Failure', url: 'https://boom.example.com/feed' }),
  ]);

  const { items, results, stats } = await collectTopics({
    sources,
    now: NOW,
    fetchImpl: fakeFetch({
      ...ROUTES,
      'https://dead.example.com/feed': { status: 503, body: 'service unavailable' },
      'https://html.example.com/feed': { body: NOT_A_FEED, contentType: 'text/html' },
      'https://boom.example.com/feed': { networkError: 'getaddrinfo ENOTFOUND boom.example.com' },
    }),
  });

  assert.equal(stats.sourcesAttempted, 5);
  assert.equal(stats.sourcesSucceeded, 2);
  assert.equal(stats.sourcesFailed, 3);
  assert.equal(items.length, 9, 'the healthy sources still deliver everything');

  const byId = Object.fromEntries(results.map((result) => [result.sourceId, result]));
  assert.equal(byId.dead.error, 'http_error');
  assert.equal(byId.html.error, 'feed_unrecognized');
  assert.equal(byId.boom.error, 'network_error');
  assert.match(byId.boom.message, /ENOTFOUND/, 'the underlying cause survives for the logs');
  assert.ok(results.every((result) => Array.isArray(result.items)));
});

test('collect: a hanging source is abandoned at the timeout, not waited on', async () => {
  const started = Date.now();
  const { items, results, stats } = await collectTopics({
    sources: testSources([createRssSource({ id: 'slow', name: 'Slow Feed', url: 'https://slow.example.com/feed' })]),
    now: NOW,
    timeoutMs: 150,
    fetchImpl: fakeFetch({ ...ROUTES, 'https://slow.example.com/feed': { hang: true } }),
  });

  assert.equal(stats.sourcesFailed, 1);
  assert.equal(results.find((result) => result.sourceId === 'slow').error, 'timeout');
  assert.equal(items.length, 9);
  // One retry, so roughly two timeouts plus backoff - but bounded, not hung.
  assert.ok(Date.now() - started < 5_000, 'collection must not block on a dead source');
});

test('collect: every source failing is reported, not thrown', async () => {
  const { items, stats } = await collectTopics({
    sources: testSources(),
    now: NOW,
    fetchImpl: fakeFetch({}),
  });
  assert.deepEqual(items, []);
  assert.equal(stats.sourcesSucceeded, 0);
  assert.equal(stats.sourcesFailed, 2);
});

test('collect: a malformed feed yields nothing without taking the cycle down', async () => {
  const { items, results } = await collectTopics({
    sources: [createRssSource({ id: 'broken', name: 'Broken Feed', url: 'https://broken.example.com/feed' })],
    now: NOW,
    fetchImpl: fakeFetch({ 'https://broken.example.com/feed': MALFORMED_XML }),
  });
  assert.equal(results[0].ok, true, 'a truncated feed parses to zero entries rather than failing');
  assert.deepEqual(items, []);
});

test('collect: an empty feed is a success with zero items', async () => {
  const { items, results } = await collectTopics({
    sources: [createRssSource({ id: 'quiet', name: 'Quiet Feed', url: 'https://quiet.example.com/feed' })],
    now: NOW,
    fetchImpl: fakeFetch({ 'https://quiet.example.com/feed': EMPTY_FEED }),
  });
  assert.equal(results[0].ok, true);
  assert.equal(items.length, 0);
});

test('collect: per-source limit stops one feed dominating the batch', async () => {
  const { items } = await collectTopics({
    sources: testSources(),
    now: NOW,
    perSourceLimit: 2,
    fetchImpl: fakeFetch(ROUTES),
  });
  assert.equal(items.length, 4);
});

test('collect: sources are fetched concurrently, not one after another', async () => {
  let inFlight = 0;
  let peak = 0;
  const slowFetch = async (url) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inFlight -= 1;
    return fakeFetch(ROUTES)(url);
  };

  const sources = Array.from({ length: 6 }, (_unused, index) =>
    createRssSource({ id: `s${index}`, name: `Feed ${index}`, url: 'https://security.example.com/feed' })
  );
  await collectTopics({ sources, now: NOW, concurrency: 4, fetchImpl: slowFetch });

  assert.ok(peak > 1, `expected concurrent requests, peak was ${peak}`);
  assert.ok(peak <= 4, `concurrency cap exceeded, peak was ${peak}`);
});

test('collect: the Hacker News adapter normalizes JSON into the same shape', async () => {
  const source = createHackerNewsSource({
    id: 'hn', name: 'Hacker News (AI security)', query: 'AI security', tags: ['community'],
  });
  const { items, results } = await collectTopics({
    sources: [source], now: NOW, fetchImpl: fakeFetch(ROUTES),
  });

  assert.equal(results[0].ok, true);
  assert.equal(items.length, 2, 'the too-short title is dropped');
  assert.equal(items[0].url, 'https://tools.example.dev/rag-injection-scanner');
  // A text post with no external URL still gets a citable permalink.
  assert.equal(items[1].url, 'https://news.ycombinator.com/item?id=44100002');
  assert.equal(items[1].source, 'Hacker News (AI security)');
});

test('collect: invalid JSON from Hacker News is a source failure, not a crash', async () => {
  const source = createHackerNewsSource({ id: 'hn', name: 'HN', query: 'AI security' });
  const { results, items } = await collectTopics({
    sources: [source], now: NOW,
    fetchImpl: fakeFetch({ 'https://hn.algolia.com': { body: '<html>rate limited</html>', contentType: 'text/html' } }),
  });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error, 'invalid_json');
  assert.deepEqual(items, []);
});

test('http: a 4xx is not retried, a 5xx is', async () => {
  let notFoundCalls = 0;
  let serverErrorCalls = 0;

  await assert.rejects(
    () => fetchText('https://a.example.com/x', {
      retries: 2,
      fetchImpl: async () => {
        notFoundCalls += 1;
        return { ok: false, status: 404, url: 'x', headers: new Map(), text: async () => '' };
      },
    }),
    (err) => err.code === 'http_error' && err.status === 404
  );
  assert.equal(notFoundCalls, 1, '404 will not change on a retry');

  await assert.rejects(
    () => fetchText('https://b.example.com/x', {
      retries: 2,
      fetchImpl: async () => {
        serverErrorCalls += 1;
        return { ok: false, status: 500, url: 'x', headers: new Map(), text: async () => '' };
      },
    }),
    (err) => err.code === 'http_error'
  );
  assert.equal(serverErrorCalls, 3, '500 is retried up to the limit');
});

test('http: runPooled captures rejections instead of propagating them', async () => {
  const results = await runPooled([
    async () => 'ok',
    async () => { throw new Error('nope'); },
    async () => 'also ok',
  ], 2);

  assert.deepEqual(results.map((result) => result.ok), [true, false, true]);
  assert.equal(results[1].error.message, 'nope');
});

test('registry: every configured source builds and is uniquely identified', () => {
  const sources = buildSources();
  assert.equal(sources.length, SOURCE_DEFINITIONS.length);
  assert.ok(sources.length >= 10, 'breadth matters: no single feed can be a dependency');

  const ids = sources.map((source) => source.id);
  assert.equal(new Set(ids).size, ids.length, 'source ids must be unique');

  for (const source of sources) {
    assert.equal(typeof source.collect, 'function');
    assert.ok(['primary', 'secondary', 'aggregator'].includes(source.tier), `${source.id} tier`);
    assert.ok(source.tags.length > 0, `${source.id} needs tags for persona matching`);
    assert.match(source.url, /^https:\/\//, `${source.id} must be https`);
  }

  assert.ok(new Set(sources.map((source) => source.kind)).size > 1, 'the layer is not RSS-only');
  assert.deepEqual(listSources().length, SOURCE_DEFINITIONS.length);
});

test('registry: only/exclude select subsets', () => {
  assert.deepEqual(buildSources({ only: ['schneier'] }).map((source) => source.id), ['schneier']);
  const excluded = buildSources({ exclude: ['schneier'] });
  assert.equal(excluded.length, SOURCE_DEFINITIONS.length - 1);
  assert.ok(!excluded.some((source) => source.id === 'schneier'));
});

test('phase 6-7 make no LLM call: no module reaches the llm layer or an API key', async () => {
  const dirs = ['services/sources', 'services/topics'];
  const files = [];
  for (const dir of dirs) {
    const full = path.join(serverSrc, dir);
    for (const name of await readdir(full)) {
      if (name.endsWith('.js')) files.push(path.join(full, name));
    }
  }
  assert.ok(files.length >= 9, `expected the phase 6-7 modules, found ${files.length}`);

  // Publisher names are fine (OpenAI runs a news feed); calling a model is not.
  const forbidden = [
    /services\/llm/, /generativelanguage/i, /generateContent/, /apiKey/, /LLM_API_KEY/,
    /api\.openai\.com/i, /api\.anthropic\.com/i, /completions/i, /\bprompt\s*=/,
  ];
  for (const file of files) {
    const contents = await readFile(file, 'utf8');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(contents), `${path.basename(file)} must not reference ${pattern}`);
    }
  }
});
