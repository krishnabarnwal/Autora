import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { TopicMemory } from '../../src/models/index.js';
import { getRecentMemory, getTopicMemory } from '../../src/services/memory/index.js';
import { seedAgent, seedMemory } from '../fixtures/memory.js';

/**
 * Bounded memory retrieval (§6). getRecentMemory is agent-scoped, capped so it can
 * never scan the whole collection, deterministically newest-first, and returns
 * only the compact view — never a raw Mongoose document. getTopicMemory returns
 * the agent's latest decision on one exact topic.
 */

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

const REASON = 'Seeded for a retrieval test.';

test('getRecentMemory returns compact views, newest first', async () => {
  const agent = await seedAgent();
  await seedMemory(agent.agentId, { topic: 'Alpha topic about kernels', ageDays: 7 });
  await seedMemory(agent.agentId, { topic: 'Beta topic about compilers', ageDays: 3 });
  await seedMemory(agent.agentId, { topic: 'Gamma topic about databases', ageDays: 1 });

  const rows = await getRecentMemory(agent.agentId);
  assert.equal(rows.length, 3);
  // ageDays 1 < 3 < 7, so newest-first is gamma, beta, alpha.
  assert.deepEqual(rows.map((r) => r.topic), [
    'Gamma topic about databases',
    'Beta topic about compilers',
    'Alpha topic about kernels',
  ]);
});

test('getRecentMemory honors a custom limit (a bounded page)', async () => {
  const agent = await seedAgent();
  for (let i = 0; i < 5; i += 1) {
    await seedMemory(agent.agentId, { topic: `Bounded topic number ${i}`, ageDays: i + 1 });
  }
  const rows = await getRecentMemory(agent.agentId, { limit: 2 });
  assert.equal(rows.length, 2);
});

test('getRecentMemory hard-caps the page no matter how large the request', async () => {
  const agent = await seedAgent();
  // 205 rows inserted in one round trip; the pre('validate') hook derives each
  // normalizedTopic. Rejected rows are exempt from the published unique index.
  const docs = Array.from({ length: 205 }, (_, i) => ({
    agentId: agent.agentId,
    topic: `Ceiling probe topic number ${i} about systems`,
    decision: 'rejected',
    reason: REASON,
  }));
  await TopicMemory.insertMany(docs);

  const rows = await getRecentMemory(agent.agentId, { limit: 100000, days: 3650 });
  assert.equal(rows.length, 200, 'the 200-row ceiling clamps an oversized request');
});

test('getRecentMemory is agent-scoped', async () => {
  const mine = await seedAgent();
  const theirs = await seedAgent({ name: 'Other', domain: 'Data' });
  await seedMemory(mine.agentId, { topic: 'Mine topic about scheduling', ageDays: 1 });
  await seedMemory(theirs.agentId, { topic: 'Their topic about scheduling', ageDays: 1 });

  const rows = await getRecentMemory(mine.agentId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].topic, 'Mine topic about scheduling');
});
test('getRecentMemory can filter by decision kind', async () => {
  const agent = await seedAgent();
  await seedMemory(agent.agentId, { topic: 'Rejected one about caching', decision: 'rejected', ageDays: 2 });
  await seedMemory(agent.agentId, { topic: 'Deferred one about caching layers', decision: 'deferred', rejectionCategory: null, ageDays: 1 });

  const rejected = await getRecentMemory(agent.agentId, { decision: 'rejected' });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].decision, 'rejected');
});

test('getRecentMemory applies a date window', async () => {
  const agent = await seedAgent();
  await seedMemory(agent.agentId, { topic: 'Recent one about tracing', ageDays: 2 });
  await seedMemory(agent.agentId, { topic: 'Ancient one about tracing spans', ageDays: 90 });

  const rows = await getRecentMemory(agent.agentId, { days: 30 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].topic, 'Recent one about tracing');
});

test('getRecentMemory returns a bounded view shape, not a raw document', async () => {
  const agent = await seedAgent();
  await seedMemory(agent.agentId, {
    topic: 'Shape probe about observability', decision: 'rejected',
    rejectionCategory: 'low_novelty', sourceUrls: ['https://example.org/a'], score: 42, ageDays: 1,
    reasons: ['Sourcing too weak to write about responsibly.'],
  });

  const [row] = await getRecentMemory(agent.agentId);
  assert.deepEqual(
    Object.keys(row).sort(),
    ['createdAt', 'cycleId', 'decision', 'normalizedTopic', 'postId', 'reason', 'reasons', 'rejectionCategory', 'score', 'sources', 'topic'].sort()
  );
  assert.equal(typeof row.createdAt, 'string', 'createdAt is an ISO string, not a Date');
  assert.equal(row._id, undefined, 'no raw _id leaks');
  assert.ok(Array.isArray(row.sources));
  assert.deepEqual(row.reasons, ['Sourcing too weak to write about responsibly.']);
  assert.equal(row.reason, 'Seeded for a memory test.');
});

test('getRecentMemory reports absent structured reasons as null, not []', async () => {
  // A row written before structured reasoning existed — the field is genuinely
  // absent on the document, and the view must not manufacture an empty list
  // that would read as "the editor enumerated nothing".
  const agent = await seedAgent();
  await seedMemory(agent.agentId, {
    topic: 'Legacy shape probe about kernels', decision: 'deferred',
    reason: 'Parked for a later cycle.', ageDays: 2,
  });

  const [row] = await getRecentMemory(agent.agentId);
  assert.equal(row.reason, 'Parked for a later cycle.', 'the recorded prose is always present');
  assert.equal(row.reasons, null, 'absent stays absent');
});

test('getRecentMemory is empty (not an error) for an agent with no history', async () => {
  const agent = await seedAgent();
  const rows = await getRecentMemory(agent.agentId);
  assert.deepEqual(rows, []);
});

test('getTopicMemory returns the latest decision on one exact topic', async () => {
  const agent = await seedAgent();
  await seedMemory(agent.agentId, { topic: 'Repeating topic about queues', decision: 'rejected', ageDays: 10 });
  await seedMemory(agent.agentId, { topic: 'Queues repeating topic', decision: 'deferred', rejectionCategory: null, ageDays: 1 });

  // Both strings normalize to the same key; the newest (deferred) wins.
  const row = await getTopicMemory(agent.agentId, 'Repeating topic about queues');
  assert.ok(row);
  assert.equal(row.decision, 'deferred');
});

test('getTopicMemory returns null for an unseen topic', async () => {
  const agent = await seedAgent();
  const row = await getTopicMemory(agent.agentId, 'A topic never decided upon here');
  assert.equal(row, null);
});
