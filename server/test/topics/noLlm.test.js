import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverTopics } from '../../src/services/topics/index.js';
import { createRssSource } from '../../src/services/sources/rssAdapter.js';
import { RSS_SECURITY, NOW } from '../fixtures/feeds.js';

const DIRS = ['src/services/sources', 'src/services/topics'];

async function filesIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.js')).map((entry) => join(dir, entry.name));
}

test('no-llm: the source and topic layers do not import an LLM client', async () => {
  const forbidden = /(from|import)\s*\(?\s*['"][^'"]*(services\/llm|@google\/gen|generative-?ai|openai|anthropic)/i;

  for (const dir of DIRS) {
    for (const file of await filesIn(dir)) {
      const source = await readFile(file, 'utf8');
      assert.ok(!forbidden.test(source), `${file} must not import an LLM client`);
      // Nor reach a provider endpoint by hand.
      assert.ok(
        !/generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com/i.test(source),
        `${file} must not call a model endpoint`
      );
    }
  }
});

test('no-llm: a full discovery cycle makes no request outside its own sources', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return new Response(RSS_SECURITY, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  };

  const { candidates, stats } = await discoverTopics({
    sources: [createRssSource({ id: 'sec', name: 'Example Security News', url: 'https://security.example.com/feed', tier: 'secondary', tags: ['security'] })],
    now: NOW,
    fetchImpl,
  });

  assert.ok(candidates.length > 0, 'the cycle did real work');
  assert.equal(stats.llmCalls, 0);
  assert.deepEqual(requested, ['https://security.example.com/feed']);
});

test('no-llm: discovery neither reads nor writes the database', async () => {
  // Phase 6-7 is pure: it takes sources and returns candidates. Nothing here
  // opens a connection, so a cycle can run before Mongo is even reachable.
  for (const dir of DIRS) {
    for (const file of await filesIn(dir)) {
      const source = await readFile(file, 'utf8');
      assert.ok(!/from\s+['"][^'"]*models\//.test(source), `${file} must not import a model`);
      assert.ok(!/mongoose/i.test(source), `${file} must not touch mongoose`);
    }
  }
});
