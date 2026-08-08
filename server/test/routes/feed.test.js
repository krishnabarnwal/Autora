import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { startTestServer, stopTestServer, get, post, withFetchSpy } from '../helpers/http.js';
import { Agent, Post } from '../../src/models/index.js';

const ADA = { persona: { name: 'Ada', domain: 'AI Security' } };

/** Create a post directly, the way the Phase 12 worker eventually will. */
async function publish(agentId, topic, overrides = {}) {
  return Post.create({
    agentId,
    topic,
    text: `Analysis of ${topic}.`,
    rationale: `${topic} is material to practitioners.`,
    sources: [`https://example.com/${encodeURIComponent(topic)}`],
    ...overrides,
  });
}

async function initAgent(persona = ADA) {
  const res = await post('/api/agent/init', persona);
  return res.body.agentId;
}

test.before(async () => {
  await startTestDb();
  await startTestServer();
});
test.after(async () => {
  await stopTestServer();
  await stopTestDb();
});
test.beforeEach(async () => clearTestDb());

// --- 6. Feed for a valid agent --------------------------------------------

test('feed: returns the exact contract shape for a valid agent', async () => {
  const agentId = await initAgent();
  await publish(agentId, 'Prompt injection in autonomous agents');

  const res = await get(`/api/agent/feed?agentId=${agentId}`);

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['posts']);
  assert.equal(res.body.posts.length, 1);

  const [item] = res.body.posts;
  assert.deepEqual(
    Object.keys(item).sort(),
    ['createdAt', 'id', 'rationale', 'sources', 'text'],
    'post must expose exactly the contract fields'
  );
  assert.equal(typeof item.id, 'string');
  assert.equal(typeof item.text, 'string');
  assert.equal(typeof item.rationale, 'string');
  assert.ok(Array.isArray(item.sources) && item.sources.length > 0);
});

test('feed: createdAt is ISO 8601 UTC', async () => {
  const agentId = await initAgent();
  await publish(agentId, 'Model supply chain risk');

  const res = await get(`/api/agent/feed?agentId=${agentId}`);
  const { createdAt } = res.body.posts[0];

  assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(createdAt.endsWith('Z'), 'must be UTC');
  assert.ok(!Number.isNaN(new Date(createdAt).getTime()), 'must parse as a date');
});

// --- 7. Empty feed ---------------------------------------------------------

test('feed: an initialized agent with no posts returns an empty array', async () => {
  const agentId = await initAgent();

  const res = await get(`/api/agent/feed?agentId=${agentId}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { posts: [] });
  assert.ok(Array.isArray(res.body.posts), 'posts must be an array, never null');
});

// --- 8. Newest first -------------------------------------------------------

test('feed: multiple posts come back newest-first', async () => {
  const agentId = await initAgent();
  const base = Date.parse('2026-08-01T00:00:00.000Z');

  // Explicit timestamps so ordering is asserted, not inferred from write speed.
  const topics = ['Oldest topic here', 'Middle topic here', 'Newest topic here'];
  for (const [index, topic] of topics.entries()) {
    const doc = await publish(agentId, topic);
    await Post.updateOne(
      { postId: doc.postId },
      { $set: { createdAt: new Date(base + index * 60_000) } }
    );
  }

  const res = await get(`/api/agent/feed?agentId=${agentId}`);
  const texts = res.body.posts.map((p) => p.text);

  assert.deepEqual(texts, [
    'Analysis of Newest topic here.',
    'Analysis of Middle topic here.',
    'Analysis of Oldest topic here.',
  ]);

  const times = res.body.posts.map((p) => Date.parse(p.createdAt));
  assert.deepEqual([...times].sort((a, b) => b - a), times, 'must be descending by createdAt');
});

// --- 9. Cross-agent isolation ---------------------------------------------

test('feed: never exposes another agent\'s posts', async () => {
  const adaId = await initAgent();
  const sentinelId = await initAgent({ persona: { name: 'Sentinel', domain: 'AI Security' } });

  await publish(adaId, 'Ada private topic alpha');
  await publish(adaId, 'Ada private topic beta');
  await publish(sentinelId, 'Sentinel private topic gamma');

  const ada = await get(`/api/agent/feed?agentId=${adaId}`);
  const sentinel = await get(`/api/agent/feed?agentId=${sentinelId}`);

  assert.equal(ada.body.posts.length, 2);
  assert.equal(sentinel.body.posts.length, 1);

  const sentinelText = JSON.stringify(sentinel.body);
  assert.ok(!sentinelText.includes('Ada private'), 'leaked another agent\'s content');
  assert.ok(sentinelText.includes('gamma'));
});

// --- 10. Invalid / nonexistent agentId ------------------------------------

test('feed: a nonexistent agentId is a 404, distinct from an empty feed', async () => {
  const res = await get('/api/agent/feed?agentId=agt_0000000000000000');

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'agent_not_found');
  assert.equal(res.body.posts, undefined);
});

test('feed: rejects a missing or malformed agentId', async () => {
  const cases = [
    ['/api/agent/feed', 400, 'agent_id_required'],
    ['/api/agent/feed?agentId=', 400, 'agent_id_required'],
    ['/api/agent/feed?agentId=%20%20', 400, 'agent_id_required'],
    ['/api/agent/feed?agentId=has%20space', 400, 'agent_id_invalid'],
    ['/api/agent/feed?agentId=drop%3Btable', 400, 'agent_id_invalid'],
    [`/api/agent/feed?agentId=${'x'.repeat(65)}`, 400, 'agent_id_invalid'],
    ['/api/agent/feed?agentId=a&agentId=b', 400, 'agent_id_invalid'],
  ];

  for (const [path, status, code] of cases) {
    const res = await get(path);
    assert.equal(res.status, status, `wrong status for ${path}`);
    assert.equal(res.body.error, code, `wrong code for ${path}`);
  }
});

// --- 11/12. The feed is a pure read --------------------------------------

test('feed: never creates a post or mutates the agent', async () => {
  const agentId = await initAgent();
  await publish(agentId, 'Existing topic remains stable');

  const before = await Post.countDocuments({});
  const agentBefore = await Agent.findOne({ agentId }).lean();

  for (let i = 0; i < 5; i += 1) {
    const res = await get(`/api/agent/feed?agentId=${agentId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.posts.length, 1, 'feed must not generate content');
  }

  assert.equal(await Post.countDocuments({}), before, 'post count changed');

  const agentAfter = await Agent.findOne({ agentId }).lean();
  assert.equal(agentAfter.stats.postsPublished, agentBefore.stats.postsPublished);
  assert.equal(agentAfter.stats.llmCalls, agentBefore.stats.llmCalls);
  assert.equal(
    agentAfter.updatedAt.getTime(),
    agentBefore.updatedAt.getTime(),
    'reading the feed must not touch the agent record'
  );
});

test('feed: makes no outbound network call, so no LLM or live source is reached', async () => {
  const agentId = await initAgent();
  await publish(agentId, 'Topic that must not trigger generation');

  const { result, calls } = await withFetchSpy(async () => {
    return get(`/api/agent/feed?agentId=${agentId}`);
  });

  assert.equal(result.status, 200);
  assert.deepEqual(calls, [], `feed reached out to: ${calls.join(', ')}`);
});

test('feed: route module imports no LLM, source, or scheduler code', async () => {
  const source = await readFile(new URL('../../src/routes/agent.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import[^;]+from\s+'([^']+)';/gm)].map((m) => m[1]);

  for (const specifier of imports) {
    assert.ok(
      !/llm|gemini|openai|sources?\/|scheduler|cron|agentLoop/i.test(specifier),
      `feed route must not import ${specifier}`
    );
  }
  assert.ok(!/generatePost|runCycle|collectArticles/.test(source), 'no generation call in the route');
});

// --- Persistence + paging -------------------------------------------------

test('feed: previously returned posts remain available across requests', async () => {
  const agentId = await initAgent();
  await publish(agentId, 'First durable topic');

  const first = await get(`/api/agent/feed?agentId=${agentId}`);
  const firstId = first.body.posts[0].id;

  await publish(agentId, 'Second durable topic');

  const second = await get(`/api/agent/feed?agentId=${agentId}`);
  const ids = second.body.posts.map((p) => p.id);

  assert.equal(second.body.posts.length, 2);
  assert.ok(ids.includes(firstId), 'an earlier post disappeared from the feed');
});

test('feed: limit and before keep older posts reachable', async () => {
  const agentId = await initAgent();
  const base = Date.parse('2026-08-01T00:00:00.000Z');

  // Distinct words, not trailing digits: normalizeTopic drops tokens of two
  // characters or fewer, so "topic 1".."topic 5" would collide on the unique
  // (agentId, normalizedTopic) index.
  const topics = [
    'Prompt injection defenses',
    'Model weight exfiltration',
    'Agent sandbox escapes',
    'Retrieval poisoning attacks',
    'Inference endpoint abuse',
  ];

  for (const [index, topic] of topics.entries()) {
    const doc = await publish(agentId, topic);
    await Post.updateOne(
      { postId: doc.postId },
      { $set: { createdAt: new Date(base + index * 60_000) } }
    );
  }

  const page1 = await get(`/api/agent/feed?agentId=${agentId}&limit=2`);
  assert.equal(page1.body.posts.length, 2);

  const oldest = page1.body.posts[page1.body.posts.length - 1].createdAt;
  const page2 = await get(`/api/agent/feed?agentId=${agentId}&limit=2&before=${oldest}`);

  assert.equal(page2.body.posts.length, 2);
  const overlap = page2.body.posts.filter((p) => page1.body.posts.some((q) => q.id === p.id));
  assert.deepEqual(overlap, [], 'pages must not overlap');
});

test('feed: rejects an invalid limit', async () => {
  const agentId = await initAgent();
  for (const limit of ['0', '501', 'abc', '-5', '1.5']) {
    const res = await get(`/api/agent/feed?agentId=${agentId}&limit=${limit}`);
    assert.equal(res.status, 400, `limit=${limit} should be rejected`);
    assert.equal(res.body.error, 'limit_invalid');
  }
});

test('feed: response leaks no secrets', async () => {
  const agentId = await initAgent();
  await publish(agentId, 'Secret hygiene topic');

  const res = await get(`/api/agent/feed?agentId=${agentId}`);
  const serialized = JSON.stringify(res.body).toLowerCase();

  for (const forbidden of ['mongodb', '@cluster', 'apikey', 'password', 'agt_']) {
    assert.ok(!serialized.includes(forbidden), `feed leaked ${forbidden}`);
  }
});
