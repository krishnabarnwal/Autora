import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startTestDb, stopTestDb } from './helpers/db.js';
import { Agent, Post, TopicMemory } from '../src/models/index.js';
import { databaseStatus, pingDatabase } from '../src/config/database.js';

test.before(async () => startTestDb());
test.after(async () => stopTestDb());

/** Index keys as comparable strings, e.g. "agentId:1,createdAt:-1". */
async function indexSignatures(Model) {
  const indexes = await Model.collection.indexes();
  return indexes.map((idx) => ({
    key: Object.entries(idx.key)
      .map(([field, dir]) => `${field}:${dir}`)
      .join(','),
    unique: Boolean(idx.unique),
  }));
}

test('indexes: Agent has a unique agentId and a status index', async () => {
  const sigs = await indexSignatures(Agent);
  const byKey = Object.fromEntries(sigs.map((s) => [s.key, s]));

  assert.ok(byKey['agentId:1'], 'agentId index missing');
  assert.equal(byKey['agentId:1'].unique, true, 'agentId must be unique');
  assert.ok(byKey['status:1'], 'status index missing');
});

test('indexes: Post supports the newest-first feed query and topic uniqueness', async () => {
  const sigs = await indexSignatures(Post);
  const byKey = Object.fromEntries(sigs.map((s) => [s.key, s]));

  assert.ok(byKey['postId:1'], 'postId index missing');
  assert.equal(byKey['postId:1'].unique, true, 'postId must be unique');

  // The hot path: GET /api/agent/feed?agentId=... sorted by createdAt desc.
  assert.ok(byKey['agentId:1,createdAt:-1'], 'compound feed index missing');

  // Repetition prevention at the storage layer.
  assert.ok(byKey['agentId:1,normalizedTopic:1'], 'topic uniqueness index missing');
  assert.equal(byKey['agentId:1,normalizedTopic:1'].unique, true);
});

test('indexes: TopicMemory supports decision filtering and topic recall', async () => {
  const sigs = await indexSignatures(TopicMemory);
  const keys = sigs.map((s) => s.key);

  assert.ok(keys.includes('agentId:1,createdAt:-1'), 'activity index missing');
  assert.ok(keys.includes('agentId:1,normalizedTopic:1,createdAt:-1'), 'recall index missing');
  assert.ok(keys.includes('agentId:1,decision:1,createdAt:-1'), 'decision filter index missing');

  // Memory is an audit log; repeats must be allowed.
  const topicIdx = sigs.find((s) => s.key === 'agentId:1,normalizedTopic:1,createdAt:-1');
  assert.equal(topicIdx.unique, false);
});

test('indexes: the feed query actually uses the compound index', async () => {
  const plan = await Post.find({ agentId: 'agt_probe' })
    .sort({ createdAt: -1, _id: -1 })
    .explain('queryPlanner');

  const winning = JSON.stringify(plan.queryPlanner.winningPlan);
  assert.ok(
    winning.includes('IXSCAN'),
    `feed query should use an index scan, got: ${winning.slice(0, 300)}`
  );
  assert.ok(!winning.includes('SORT_KEY_GENERATOR'), 'sort should be served by the index, not in memory');
});

test('database: status reports a healthy connection and ping succeeds', async () => {
  const status = databaseStatus();
  assert.equal(status.healthy, true);
  assert.equal(status.status, 'connected');
  assert.ok(status.database);

  const ping = await pingDatabase();
  assert.equal(ping.ok, true);
  assert.equal(typeof ping.latencyMs, 'number');
});

test('database: status never leaks credentials', async () => {
  const serialized = JSON.stringify(databaseStatus());
  assert.ok(!/mongodb(\+srv)?:\/\//.test(serialized), 'status must not contain a connection string');
  assert.ok(!/password|secret/i.test(serialized));
});

test('database: ping reports a clear failure when disconnected', async () => {
  // readyState is read-only on a real connection, so pass a stand-in.
  const disconnected = { readyState: 0, name: null };

  const ping = await pingDatabase(disconnected);
  assert.equal(ping.ok, false);
  assert.match(ping.error, /not connected/);

  const status = databaseStatus(disconnected);
  assert.equal(status.healthy, false);
  assert.equal(status.status, 'disconnected');

  // The live connection is untouched.
  assert.equal(mongoose.connection.readyState, 1);
});

test('database: ping surfaces a server-side failure instead of throwing', async () => {
  const failing = {
    readyState: 1,
    name: 'test',
    db: { admin: () => ({ ping: async () => { throw new Error('connection reset'); } }) },
  };
  const ping = await pingDatabase(failing);
  assert.equal(ping.ok, false);
  assert.match(ping.error, /connection reset/);
});
