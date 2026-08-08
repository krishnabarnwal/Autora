import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { TopicMemory } from '../../src/models/index.js';

const AGENT_ID = 'agt_4444444444444444';

function makeMemory(overrides = {}) {
  return {
    agentId: AGENT_ID,
    topic: 'Speculative rumor about an unreleased model',
    keywords: ['speculative', 'rumor', 'model'],
    sourceUrls: ['https://example.com/rumor'],
    decision: 'rejected',
    score: 22,
    reason: 'Unverified single source with no technical detail.',
    rejectionCategory: 'weak_sources',
    ...overrides,
  };
}

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

test('topicMemory: records a rejection with reason and category', async () => {
  const memory = await TopicMemory.create(makeMemory());
  assert.equal(memory.decision, 'rejected');
  assert.equal(memory.rejectionCategory, 'weak_sources');
  assert.equal(memory.score, 22);
  assert.ok(memory.normalizedTopic.length > 0);
  assert.equal(memory.postId, null);
});

test('topicMemory: records a publication linked to its post', async () => {
  const memory = await TopicMemory.create(
    makeMemory({
      topic: 'New prompt injection defense benchmark',
      decision: 'published',
      score: 91,
      reason: 'Concrete benchmark with reproducible methodology.',
      rejectionCategory: null,
      postId: 'p_abcdef123456',
    })
  );
  assert.equal(memory.decision, 'published');
  assert.equal(memory.postId, 'p_abcdef123456');
});

test('topicMemory: reason is required', async () => {
  await assert.rejects(TopicMemory.create(makeMemory({ reason: undefined })));
});

test('topicMemory: rejects an unknown decision or rejection category', async () => {
  await assert.rejects(TopicMemory.create(makeMemory({ decision: 'maybe' })));
  await assert.rejects(TopicMemory.create(makeMemory({ rejectionCategory: 'bad_vibes' })));
});

test('topicMemory: allows repeated decisions on the same topic (no unique constraint)', async () => {
  await TopicMemory.create(makeMemory());
  const second = await TopicMemory.create(makeMemory({ reason: 'Still too thin on evidence.' }));
  assert.ok(second._id, 'memory is an audit log, so repeats must be permitted');
});

test('topicMemory: findByTopic matches word-order variants', async () => {
  await TopicMemory.create(makeMemory({ topic: 'Prompt injection defenses for agents' }));
  const found = await TopicMemory.findByTopic(AGENT_ID, 'Agents and defenses for prompt injection');
  assert.ok(found, 'normalized lookup should match a reordered topic');
  assert.equal(found.decision, 'rejected');
});

test('topicMemory: findByTopic is scoped per agent', async () => {
  await TopicMemory.create(makeMemory({ topic: 'Model weight leakage' }));
  const found = await TopicMemory.findByTopic('agt_other', 'Model weight leakage');
  assert.equal(found, null);
});

test('topicMemory: recentFor returns newest first and can filter by decision', async () => {
  await TopicMemory.create(makeMemory({ topic: 'Topic one', decision: 'rejected' }));
  await new Promise((r) => setTimeout(r, 10));
  await TopicMemory.create(
    makeMemory({ topic: 'Topic two', decision: 'published', rejectionCategory: null, postId: 'p_111111111111' })
  );

  const all = await TopicMemory.recentFor(AGENT_ID);
  assert.equal(all.length, 2);
  assert.equal(all[0].topic, 'Topic two', 'newest first');

  const rejected = await TopicMemory.recentFor(AGENT_ID, { decision: 'rejected' });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].topic, 'Topic one');
});

test('topicMemory: toPublicJSON emits ISO createdAt and no _id', async () => {
  const memory = await TopicMemory.create(makeMemory());
  const json = memory.toPublicJSON();
  assert.match(json.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(json._id, undefined);
  assert.deepEqual(json.sources, ['https://example.com/rumor']);
});
