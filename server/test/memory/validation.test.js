import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { TopicMemory } from '../../src/models/index.js';
import {
  getTopicMemory,
  getRecentMemory,
  checkRepetition,
  recordDecision,
  MemoryInputError,
} from '../../src/services/memory/index.js';
import { seedAgent } from '../fixtures/memory.js';

/**
 * Input validation (§10, §12). Every entry point fails deterministically on
 * malformed input, throws a MemoryInputError with a precise code, and — for the
 * writing path — leaves the store untouched.
 */

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof MemoryInputError, `expected MemoryInputError, got ${err?.name}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

test('validation: every entry point requires an agentId', async () => {
  await rejectsCode(getTopicMemory('', 'a topic'), 'missing_agent');
  await rejectsCode(getRecentMemory(undefined), 'missing_agent');
  await rejectsCode(checkRepetition('  ', { title: 'a topic' }), 'missing_agent');
  await rejectsCode(recordDecision(null, { decision: 'rejected', topic: 'x', reason: 'y' }), 'missing_agent');
});

test('validation: checkRepetition rejects a candidate with no usable topic', async () => {
  const agent = await seedAgent();
  await rejectsCode(checkRepetition(agent.agentId, null), 'invalid_candidate');
  await rejectsCode(checkRepetition(agent.agentId, {}), 'missing_topic');
  await rejectsCode(checkRepetition(agent.agentId, { title: '   ' }), 'missing_topic');
});

test('validation: a topic that normalizes to nothing is rejected', async () => {
  const agent = await seedAgent();
  // All stopwords / too-short tokens -> empty normalized key.
  await rejectsCode(checkRepetition(agent.agentId, { title: 'the of and a an' }), 'missing_normalized_topic');
  await rejectsCode(getTopicMemory(agent.agentId, '!!! ---'), 'missing_normalized_topic');
});

test('validation: getRecentMemory rejects an unknown decision filter', async () => {
  const agent = await seedAgent();
  await rejectsCode(getRecentMemory(agent.agentId, { decision: 'approved' }), 'invalid_decision');
});

test('validation: recordDecision rejects a missing or malformed decision object', async () => {
  const agent = await seedAgent();
  await rejectsCode(recordDecision(agent.agentId, null), 'invalid_decision');
  await rejectsCode(recordDecision(agent.agentId, 'rejected'), 'invalid_decision');
  await rejectsCode(recordDecision(agent.agentId, { decision: 'maybe', topic: 'x', reason: 'y' }), 'invalid_decision');
  assert.equal(await TopicMemory.countDocuments(), 0, 'nothing is written on invalid input');
});

test('validation: recordDecision refuses a published decision (the publisher owns that)', async () => {
  const agent = await seedAgent();
  await rejectsCode(
    recordDecision(agent.agentId, { decision: 'published', topic: 'x', reason: 'y' }),
    'published_requires_publisher'
  );
  assert.equal(await TopicMemory.countDocuments(), 0);
});

test('validation: recordDecision requires a topic and a reason', async () => {
  const agent = await seedAgent();
  // No topic key at all -> invalid_candidate; a present-but-blank topic -> missing_topic.
  await rejectsCode(recordDecision(agent.agentId, { decision: 'rejected', reason: 'y' }), 'invalid_candidate');
  await rejectsCode(recordDecision(agent.agentId, { decision: 'rejected', topic: '   ', reason: 'y' }), 'missing_topic');
  await rejectsCode(recordDecision(agent.agentId, { decision: 'rejected', topic: 'A real topic here' }), 'missing_reason');
  assert.equal(await TopicMemory.countDocuments(), 0);
});

test('validation: recordDecision rejects an out-of-enum rejectionCategory', async () => {
  const agent = await seedAgent();
  await rejectsCode(
    recordDecision(agent.agentId, {
      decision: 'rejected', topic: 'A real topic here', reason: 'weak', rejectionCategory: 'not_a_category',
    }),
    'invalid_rejection_category'
  );
  assert.equal(await TopicMemory.countDocuments(), 0);
});
