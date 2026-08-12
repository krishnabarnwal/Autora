import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { startTestServer, stopTestServer, get, post, withFetchSpy } from '../helpers/http.js';
import { Agent, Post, TopicMemory } from '../../src/models/index.js';
import { logger, clearActivity } from '../../src/utils/logger.js';

/**
 * Phase 14 — the four read-only dashboard endpoints.
 *
 * These exist so the UI can show what the autonomous agent actually did. Every
 * test here therefore asserts two things: the shape the dashboard consumes, and
 * that reading it changes nothing — no post created, no agent touched, no
 * outbound request. A dashboard that could mutate the agent would invalidate the
 * autonomy claim the whole project rests on.
 */

const ADA = { persona: { name: 'Ada', domain: 'AI Security' } };

async function initAgent(persona = ADA) {
  const res = await post('/api/agent/init', persona);
  return res.body.agentId;
}

async function publish(agentId, topic) {
  return Post.create({
    agentId,
    topic,
    text: `Analysis of ${topic}.`,
    rationale: `${topic} is material to practitioners.`,
    sources: [`https://example.com/${encodeURIComponent(topic)}`],
  });
}

async function remember(agentId, topic, decision, overrides = {}) {
  return TopicMemory.create({
    agentId,
    topic,
    decision,
    reason: `${decision} because the editor said so`,
    ...overrides,
  });
}

test.before(async () => {
  await startTestDb();
  await startTestServer();
});
test.after(async () => {
  await stopTestServer();
  await stopTestDb();
});
test.beforeEach(async () => {
  await clearTestDb();
  clearActivity();
});

// --- GET /api/agent (list) --------------------------------------------------

test('list: returns every agent newest-first in the public shape', async () => {
  const adaId = await initAgent();
  const sentinelId = await initAgent({ persona: { name: 'Sentinel', domain: 'AI Security' } });

  const res = await get('/api/agent');

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['agents']);
  assert.equal(res.body.agents.length, 2);
  assert.deepEqual(
    res.body.agents.map((a) => a.agentId),
    [sentinelId, adaId],
    'newest agent must come first'
  );

  const [agent] = res.body.agents;
  assert.equal(agent._id, undefined);
  assert.equal(agent.personaKey, undefined, 'internal identity key must not be exposed');
  assert.equal(typeof agent.status, 'string');
  assert.equal(typeof agent.stats.cyclesRun, 'number');
});

test('list: an empty database returns an empty array, never null', async () => {
  const res = await get('/api/agent');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { agents: [] });
});

test('list: rejects an out-of-range limit', async () => {
  for (const limit of ['0', '101', 'abc', '-1', '2.5']) {
    const res = await get(`/api/agent?limit=${limit}`);
    assert.equal(res.status, 400, `limit=${limit} should be rejected`);
    assert.equal(res.body.error, 'limit_invalid');
  }
});

// --- GET /api/agent/:agentId (detail) --------------------------------------

test('detail: returns the agent plus on-disk counts', async () => {
  const agentId = await initAgent();
  await publish(agentId, 'Prompt injection in autonomous agents');
  await remember(agentId, 'Prompt injection in autonomous agents', 'published');
  await remember(agentId, 'Some weak promotional topic', 'rejected');

  const res = await get(`/api/agent/${agentId}`);

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['agent', 'counts', 'lastError']);
  assert.equal(res.body.agent.agentId, agentId);
  assert.equal(res.body.counts.posts, 1);
  assert.equal(res.body.counts.memories, 2);
  assert.equal(res.body.lastError, null, 'a healthy agent reports no last error');
});

test('detail: surfaces a sanitized lastError once a cycle has failed', async () => {
  const agentId = await initAgent();
  await Agent.updateOne(
    { agentId },
    {
      $set: {
        status: 'error',
        'lastError.message': 'Cycle failed [generation:rate_limited]',
        'lastError.at': new Date(),
      },
    }
  );

  const res = await get(`/api/agent/${agentId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.lastError.message, 'Cycle failed [generation:rate_limited]');
  assert.match(res.body.lastError.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('detail: counts are scoped to the requested agent', async () => {
  const adaId = await initAgent();
  const sentinelId = await initAgent({ persona: { name: 'Sentinel', domain: 'AI Security' } });

  await publish(adaId, 'Ada private topic alpha');
  await publish(sentinelId, 'Sentinel private topic gamma');
  await remember(sentinelId, 'Sentinel private topic gamma', 'published');

  const ada = await get(`/api/agent/${adaId}`);
  assert.equal(ada.body.counts.posts, 1);
  assert.equal(ada.body.counts.memories, 0);

  const serialized = JSON.stringify(ada.body);
  assert.ok(!serialized.includes('Sentinel'), 'leaked another agent\'s data');
});

test('detail: an unknown agentId is 404 and a malformed one is 400', async () => {
  const missing = await get('/api/agent/agt_0000000000000000');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'agent_not_found');

  const malformed = await get('/api/agent/has%20space');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'agent_id_invalid');
});

// --- GET /api/agent/:agentId/activity --------------------------------------

test('activity: returns this agent\'s buffered events newest-first', async () => {
  const agentId = await initAgent();
  const log = logger('TEST');
  log.info('First cycle event', { agentId });
  log.warn('Second cycle event', { agentId });

  const res = await get(`/api/agent/${agentId}/activity`);

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['events', 'persistent', 'scope']);
  assert.equal(res.body.scope, 'agent');
  assert.equal(res.body.persistent, false, 'the buffer is process-local; say so');

  const messages = res.body.events.map((e) => e.message);
  assert.ok(messages.indexOf('Second cycle event') < messages.indexOf('First cycle event'));

  const [newest] = res.body.events;
  assert.equal(newest.level, 'warn');
  assert.equal(newest.tag, 'TEST');
  assert.match(newest.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('activity: scope=agent hides other agents, scope=all shows system events', async () => {
  const adaId = await initAgent();
  const sentinelId = await initAgent({ persona: { name: 'Sentinel', domain: 'AI Security' } });
  const log = logger('TEST');

  log.info('Ada only event', { agentId: adaId });
  log.info('Sentinel only event', { agentId: sentinelId });
  log.info('Untagged system event');

  const scoped = await get(`/api/agent/${adaId}/activity`);
  const scopedText = JSON.stringify(scoped.body);
  assert.ok(scopedText.includes('Ada only event'));
  assert.ok(!scopedText.includes('Sentinel only event'), 'scope=agent leaked another agent');
  assert.ok(!scopedText.includes('Untagged system event'));

  const all = await get(`/api/agent/${adaId}/activity?scope=all`);
  assert.equal(all.body.scope, 'all');
  const allText = JSON.stringify(all.body);
  assert.ok(allText.includes('Untagged system event'), 'scope=all must include system events');
});

test('activity: an agent with no buffered events returns an empty array', async () => {
  const agentId = await initAgent();
  // POST /init logs its own agent-tagged event, so the buffer is only genuinely
  // empty after a restart — which clearActivity simulates.
  clearActivity();

  const res = await get(`/api/agent/${agentId}/activity`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.events, []);
  assert.ok(Array.isArray(res.body.events), 'events must be an array, never null');
});

test('activity: honours limit and rejects an invalid limit or scope', async () => {
  const agentId = await initAgent();
  const log = logger('TEST');
  for (let i = 0; i < 5; i += 1) log.info(`Event number ${i}`, { agentId });

  const limited = await get(`/api/agent/${agentId}/activity?limit=2`);
  assert.equal(limited.body.events.length, 2);

  const badLimit = await get(`/api/agent/${agentId}/activity?limit=301`);
  assert.equal(badLimit.status, 400);
  assert.equal(badLimit.body.error, 'limit_invalid');

  const badScope = await get(`/api/agent/${agentId}/activity?scope=everything`);
  assert.equal(badScope.status, 400);
  assert.equal(badScope.body.error, 'scope_invalid');
});

test('activity: an unknown agentId is a 404', async () => {
  const res = await get('/api/agent/agt_0000000000000000/activity');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'agent_not_found');
});

test('activity: credential-shaped log fields are redacted before they reach the client', async () => {
  const agentId = await initAgent();
  logger('TEST').warn('Provider call failed', {
    agentId,
    apiKey: 'sk-live-must-never-appear',
    mongoUri: 'mongodb+srv://user:pw@cluster.example.net',
    status: 429,
  });

  const res = await get(`/api/agent/${agentId}/activity`);
  const serialized = JSON.stringify(res.body);

  assert.ok(!serialized.includes('sk-live-must-never-appear'), 'activity leaked an API key');
  assert.ok(!serialized.includes('cluster.example.net'), 'activity leaked a connection string');
  assert.ok(serialized.includes('[redacted]'), 'the scrubber should have marked the fields');
  assert.equal(res.body.events[0].data.status, 429, 'non-secret fields must survive');
});

// --- GET /api/agent/:agentId/memory ----------------------------------------

test('memory: returns the compact decision view plus totals by outcome', async () => {
  const agentId = await initAgent();
  await remember(agentId, 'Published topic alpha', 'published', { score: 82, postId: 'pst_1' });
  await remember(agentId, 'Rejected topic beta', 'rejected', { rejectionCategory: 'low_novelty' });
  await remember(agentId, 'Deferred topic gamma', 'deferred');

  const res = await get(`/api/agent/${agentId}/memory`);

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['memory', 'totals']);
  assert.deepEqual(res.body.totals, { published: 1, rejected: 1, deferred: 1 });
  assert.equal(res.body.memory.length, 3);

  const published = res.body.memory.find((m) => m.decision === 'published');
  assert.deepEqual(
    Object.keys(published).sort(),
    ['createdAt', 'cycleId', 'decision', 'normalizedTopic', 'postId', 'reason', 'reasons', 'rejectionCategory', 'score', 'sources', 'topic'],
    'memory rows must be the memory service view, not raw documents'
  );
  assert.equal(published.score, 82);
  assert.equal(published._id, undefined);
});

test('memory: filters by decision and rejects an unknown one', async () => {
  const agentId = await initAgent();
  await remember(agentId, 'Published topic alpha', 'published');
  await remember(agentId, 'Rejected topic beta', 'rejected');

  const filtered = await get(`/api/agent/${agentId}/memory?decision=rejected`);
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.memory.length, 1);
  assert.equal(filtered.body.memory[0].decision, 'rejected');
  assert.deepEqual(filtered.body.totals, { published: 1, rejected: 1, deferred: 0 },
    'totals describe the whole history, not the filtered page');

  const unknown = await get(`/api/agent/${agentId}/memory?decision=exploded`);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'memory_invalid_decision');
});

test('memory: an agent that has decided nothing returns empty memory and zero totals', async () => {
  const agentId = await initAgent();
  const res = await get(`/api/agent/${agentId}/memory`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.memory, []);
  assert.deepEqual(res.body.totals, { published: 0, rejected: 0, deferred: 0 });
});

test('memory: never returns another agent\'s decisions', async () => {
  const adaId = await initAgent();
  const sentinelId = await initAgent({ persona: { name: 'Sentinel', domain: 'AI Security' } });
  await remember(adaId, 'Ada private decision alpha', 'published');
  await remember(sentinelId, 'Sentinel private decision gamma', 'published');

  const res = await get(`/api/agent/${adaId}/memory`);
  const serialized = JSON.stringify(res.body);

  assert.equal(res.body.memory.length, 1);
  assert.ok(!serialized.includes('Sentinel private'), 'leaked another agent\'s memory');
});

test('memory: rejects invalid limit and days', async () => {
  const agentId = await initAgent();

  const badLimit = await get(`/api/agent/${agentId}/memory?limit=201`);
  assert.equal(badLimit.status, 400);
  assert.equal(badLimit.body.error, 'limit_invalid');

  const badDays = await get(`/api/agent/${agentId}/memory?days=0`);
  assert.equal(badDays.status, 400);
  assert.equal(badDays.body.error, 'days_invalid');
});

test('memory: an unknown agentId is a 404', async () => {
  const res = await get('/api/agent/agt_0000000000000000/memory');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'agent_not_found');
});

// --- The dashboard is a pure read ------------------------------------------

test('dashboard: reading every endpoint mutates nothing', async () => {
  const agentId = await initAgent();
  await publish(agentId, 'Stable topic that must not change');
  await remember(agentId, 'Stable topic that must not change', 'published');

  const postsBefore = await Post.countDocuments({});
  const memoryBefore = await TopicMemory.countDocuments({});
  const agentBefore = await Agent.findOne({ agentId }).lean();

  for (let i = 0; i < 3; i += 1) {
    for (const path of [
      '/api/agent',
      `/api/agent/${agentId}`,
      `/api/agent/${agentId}/activity`,
      `/api/agent/${agentId}/memory`,
    ]) {
      const res = await get(path);
      assert.equal(res.status, 200, `${path} failed`);
    }
  }

  assert.equal(await Post.countDocuments({}), postsBefore, 'post count changed');
  assert.equal(await TopicMemory.countDocuments({}), memoryBefore, 'memory count changed');

  const agentAfter = await Agent.findOne({ agentId }).lean();
  assert.equal(agentAfter.stats.cyclesRun, agentBefore.stats.cyclesRun);
  assert.equal(agentAfter.stats.llmCalls, agentBefore.stats.llmCalls);
  assert.equal(
    agentAfter.updatedAt.getTime(),
    agentBefore.updatedAt.getTime(),
    'reading the dashboard must not touch the agent record'
  );
});

test('dashboard: no endpoint makes an outbound network call', async () => {
  const agentId = await initAgent();
  await remember(agentId, 'Topic that must not trigger generation', 'published');

  const { calls } = await withFetchSpy(async () => {
    await get('/api/agent');
    await get(`/api/agent/${agentId}`);
    await get(`/api/agent/${agentId}/activity?scope=all`);
    await get(`/api/agent/${agentId}/memory`);
  });

  assert.deepEqual(calls, [], `dashboard reached out to: ${calls.join(', ')}`);
});

test('dashboard: the route module still imports no LLM, source, or scheduler code', async () => {
  const source = await readFile(new URL('../../src/routes/agent.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import[^;]+from\s+'([^']+)';/gm)].map((m) => m[1]);

  for (const specifier of imports) {
    assert.ok(
      !/llm|gemini|openai|sources?\/|scheduler|cron|agentLoop|breeth/i.test(specifier),
      `dashboard route must not import ${specifier}`
    );
  }
  assert.ok(!/generatePost|runCycle|collectArticles/.test(source), 'no generation call in the route');
});

test('dashboard: responses leak no configuration or secrets', async () => {
  const agentId = await initAgent();
  await publish(agentId, 'Secret hygiene dashboard topic');
  await remember(agentId, 'Secret hygiene dashboard topic', 'published');

  for (const path of [
    '/api/agent',
    `/api/agent/${agentId}`,
    `/api/agent/${agentId}/activity`,
    `/api/agent/${agentId}/memory`,
  ]) {
    const res = await get(path);
    const serialized = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ['mongodb', '@cluster', 'apikey', 'api_key', 'password', 'bearer', 'authorization']) {
      assert.ok(!serialized.includes(forbidden), `${path} leaked ${forbidden}`);
    }
  }
});
