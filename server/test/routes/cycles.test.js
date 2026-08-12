import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { startTestServer, stopTestServer, get, post } from '../helpers/http.js';
import { CycleRun } from '../../src/models/index.js';

/**
 * GET /api/agent/:agentId/cycles — the persistent execution history.
 *
 * A read-only endpoint over rows the scheduler wrote, so these tests hold it to
 * the three properties that matter for a public API over durable data: it is
 * bounded (no request can ask for unlimited history), it is scoped (one agent
 * cannot read another's cycles), and it exposes only what the row is allowed to
 * carry — counts, timings and codes, never a prompt or a generated body.
 */

const ADA = { persona: { name: 'Ada', domain: 'AI Security' } };

async function initAgent(persona = ADA) {
  const res = await post('/api/agent/init', persona);
  return res.body.agentId;
}

/** One recorded cycle, `minutesAgo` before a fixed reference time. */
async function recordCycle(agentId, cycleId, minutesAgo, overrides = {}) {
  const base = Date.UTC(2026, 7, 11, 12, 0, 0);
  const startedAt = new Date(base - minutesAgo * 60_000);
  return CycleRun.create({
    agentId,
    cycleId,
    status: 'completed',
    outcome: 'published',
    startedAt,
    completedAt: new Date(startedAt.getTime() + 30_000),
    durationMs: 30_000,
    topicsDiscovered: 15,
    topicsAfterFilter: 6,
    topicsSelected: 1,
    postsPublished: 1,
    llmCalls: 2,
    decision: 'publish',
    decisionScore: 78,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
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
test.beforeEach(async () => clearTestDb());

test('cycles: returns the agent history newest-first in the documented shape', async () => {
  const agentId = await initAgent();
  await recordCycle(agentId, 'c_old', 180);
  await recordCycle(agentId, 'c_mid', 90);
  await recordCycle(agentId, 'c_new', 5);

  const res = await get(`/api/agent/${agentId}/cycles`);

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['data', 'pagination']);
  assert.deepEqual(
    res.body.data.map((row) => row.cycleId),
    ['c_new', 'c_mid', 'c_old']
  );
  assert.deepEqual(res.body.pagination, { limit: 20, hasMore: false, nextCursor: null });

  const [newest] = res.body.data;
  assert.equal(newest.status, 'completed');
  assert.equal(newest.outcome, 'published');
  assert.equal(newest.durationMs, 30_000);
  assert.equal(newest.llmCalls, 2);
  assert.equal(newest.provider, 'gemini');
  assert.equal(newest.startedAt, '2026-08-11T11:55:00.000Z');
});

test('cycles: an empty history is an empty page, not an error', async () => {
  const agentId = await initAgent();

  const res = await get(`/api/agent/${agentId}/cycles`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, []);
  assert.equal(res.body.pagination.hasMore, false);
  assert.equal(res.body.pagination.nextCursor, null);
});

test('cycles: pagination walks the whole history without repeating a row', async () => {
  const agentId = await initAgent();
  for (let i = 1; i <= 7; i += 1) await recordCycle(agentId, `c${i}`, i * 10);

  const first = await get(`/api/agent/${agentId}/cycles?limit=3`);
  assert.equal(first.body.data.length, 3);
  assert.equal(first.body.pagination.hasMore, true);
  assert.equal(first.body.pagination.limit, 3);
  assert.ok(first.body.pagination.nextCursor, 'a further page needs a cursor');

  const second = await get(
    `/api/agent/${agentId}/cycles?limit=3&before=${encodeURIComponent(first.body.pagination.nextCursor)}`
  );
  const third = await get(
    `/api/agent/${agentId}/cycles?limit=3&before=${encodeURIComponent(second.body.pagination.nextCursor)}`
  );

  assert.equal(third.body.data.length, 1);
  assert.equal(third.body.pagination.hasMore, false);
  assert.equal(third.body.pagination.nextCursor, null);

  const ids = [...first.body.data, ...second.body.data, ...third.body.data].map((r) => r.cycleId);
  assert.deepEqual(ids, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'], 'newest first, each row once');
  assert.equal(new Set(ids).size, 7);
});

test('cycles: hasMore is false on an exactly-full page', async () => {
  // The off-by-one that would show a "load older cycles" button leading nowhere:
  // the handler over-fetches by one to answer this without a second query.
  const agentId = await initAgent();
  for (let i = 1; i <= 3; i += 1) await recordCycle(agentId, `c${i}`, i * 10);

  const res = await get(`/api/agent/${agentId}/cycles?limit=3`);

  assert.equal(res.body.data.length, 3);
  assert.equal(res.body.pagination.hasMore, false);
  assert.equal(res.body.pagination.nextCursor, null);
});

test('cycles: history is bounded — an unlimited or malformed limit is rejected', async () => {
  const agentId = await initAgent();
  await recordCycle(agentId, 'c1', 10);

  for (const limit of ['0', '-1', '1000', 'all', '1.5', '']) {
    const res = await get(`/api/agent/${agentId}/cycles?limit=${limit}`);
    assert.equal(res.status, 400, `limit=${limit} should be rejected`);
    assert.equal(res.body.error, 'limit_invalid');
  }
});

test('cycles: a malformed before cursor is rejected rather than ignored', async () => {
  // Silently dropping it would return page one again, which reads to the client
  // as "the history repeats" instead of "that cursor is not a timestamp".
  const agentId = await initAgent();

  const res = await get(`/api/agent/${agentId}/cycles?before=yesterday`);

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'before_invalid');
});

test('cycles: an unknown agent is 404 and a malformed id is 400', async () => {
  const missing = await get('/api/agent/agt_doesnotexist00/cycles');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'agent_not_found');

  const malformed = await get('/api/agent/not%20an%20id/cycles');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'agent_id_invalid');
});

test('cycles: one agent never sees another agent history', async () => {
  const ada = await initAgent();
  const sentinel = await initAgent({ persona: { name: 'Sentinel', domain: 'AI Security' } });
  await recordCycle(ada, 'ada_1', 20);
  await recordCycle(sentinel, 'sentinel_1', 10);
  await recordCycle(sentinel, 'sentinel_2', 5);

  const adaRes = await get(`/api/agent/${ada}/cycles`);
  const sentinelRes = await get(`/api/agent/${sentinel}/cycles`);

  assert.deepEqual(adaRes.body.data.map((r) => r.cycleId), ['ada_1']);
  assert.deepEqual(sentinelRes.body.data.map((r) => r.cycleId), ['sentinel_2', 'sentinel_1']);
});

test('cycles: a cursor cannot be used to read across agents', async () => {
  // The cursor is a timestamp, so it must not widen the scope of the query.
  const ada = await initAgent();
  const sentinel = await initAgent({ persona: { name: 'Sentinel', domain: 'AI Security' } });
  await recordCycle(sentinel, 'sentinel_1', 60);

  const res = await get(
    `/api/agent/${ada}/cycles?before=${encodeURIComponent(new Date().toISOString())}`
  );

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, []);
});

test('cycles: passes a missing measurement through as null, never as zero', async () => {
  const agentId = await initAgent();
  await recordCycle(agentId, 'c_partial', 10, {
    status: 'failed',
    outcome: 'failed',
    completedAt: null,
    durationMs: null,
    topicsDiscovered: null,
    topicsAfterFilter: null,
    topicsSelected: null,
    postsPublished: null,
    llmCalls: null,
    decision: null,
    decisionScore: null,
    failureCode: 'rate_limited',
    failureMessage: 'Cycle failed [generation:rate_limited]',
  });

  const res = await get(`/api/agent/${agentId}/cycles`);
  const [row] = res.body.data;

  assert.equal(row.status, 'failed');
  assert.equal(row.durationMs, null);
  assert.equal(row.topicsDiscovered, null);
  assert.equal(row.llmCalls, null);
  assert.equal(row.failureCode, 'rate_limited');
});

test('cycles: an interrupted row is reported as interrupted with no invented end', async () => {
  const agentId = await initAgent();
  await recordCycle(agentId, 'c_cut', 10, {
    status: 'interrupted',
    outcome: null,
    completedAt: null,
    durationMs: null,
    failureCode: 'process_restart',
  });

  const res = await get(`/api/agent/${agentId}/cycles`);
  const [row] = res.body.data;

  assert.equal(row.status, 'interrupted');
  assert.equal(row.outcome, null);
  assert.equal(row.completedAt, null);
  assert.equal(row.durationMs, null);
});

test('cycles: the response exposes no internal identifiers, prompts or payloads', async () => {
  const agentId = await initAgent();
  await recordCycle(agentId, 'c1', 10);

  const res = await get(`/api/agent/${agentId}/cycles`);
  const [row] = res.body.data;

  // Exactly the documented row shape — a new schema field cannot leak into the
  // API without this failing first.
  assert.deepEqual(Object.keys(row).sort(), [
    'completedAt', 'cycleId', 'decision', 'decisionScore', 'durationMs', 'failureCode',
    'failureMessage', 'llmCalls', 'model', 'outcome', 'postId', 'postsPublished', 'provider',
    'providerFailureCode', 'startedAt', 'status', 'topicsAfterFilter', 'topicsDiscovered',
    'topicsRejected', 'topicsSelected',
  ]);
  assert.equal(row._id, undefined);
  assert.equal(row.agentId, undefined, 'the agent is already in the path');

  const serialized = JSON.stringify(res.body);
  for (const forbidden of ['prompt', 'apiKey', 'GEMINI', 'mongodb+srv']) {
    assert.ok(!serialized.includes(forbidden), `the response leaked ${forbidden}`);
  }
});

test('cycles: reading history writes nothing', async () => {
  const agentId = await initAgent();
  await recordCycle(agentId, 'c1', 10);
  const before = await CycleRun.findOne({ cycleId: 'c1' }).lean();

  await get(`/api/agent/${agentId}/cycles`);
  await get(`/api/agent/${agentId}/cycles?limit=1`);

  const after = await CycleRun.findOne({ cycleId: 'c1' }).lean();
  assert.equal(await CycleRun.countDocuments(), 1);
  assert.deepEqual(after, before, 'a read must not touch the row it returned');
});
