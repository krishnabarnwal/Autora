import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { TopicMemory } from '../../src/models/index.js';
import { normalizeTopic } from '../../src/utils/text.js';
import { publishFinalPost } from '../../src/services/publisher/index.js';
import {
  buildFinalPost,
  buildContext,
  seedAgent,
  CANDIDATE,
  publishDecisionResult,
} from '../fixtures/publisher.js';

/**
 * TopicMemory recording (§3). After a Post is stored, the publisher writes one
 * atomic upsert recording the published decision. These tests prove the record
 * carries the right editorial metadata, links to the post, stays singular per
 * topic (the partial unique index), and — crucially for the memory phase — does
 * NOT clobber the rejected/deferred audit history for that same topic.
 */

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

const EXPECTED_NORMALIZED = normalizeTopic(CANDIDATE.title);

test('memory: publishing records a published TopicMemory linked to the post', async () => {
  const agent = await seedAgent();
  const decision = publishDecisionResult();
  const result = await publishFinalPost(buildFinalPost(), buildContext({ agentId: agent.agentId, decision }));

  const memory = await TopicMemory.findOne({ agentId: agent.agentId, decision: 'published' });
  assert.ok(memory, 'a published memory row must exist');
  assert.equal(memory.topic, CANDIDATE.title);
  assert.equal(memory.normalizedTopic, EXPECTED_NORMALIZED);
  assert.equal(memory.decision, 'published');
  assert.equal(memory.postId, result.postId, 'the memory links to the persisted post');
  assert.equal(memory.cycleId, 'c_publish_0001');
  assert.equal(memory.rejectionCategory, null, 'a publication has no rejection category');
  assert.equal(memory.score, 86);
  assert.deepEqual(memory.sourceUrls, [CANDIDATE.url]);
  assert.ok(memory.reason && memory.reason.length > 0, 'the decision reason is recorded');
  assert.ok(Array.isArray(memory.keywords) && memory.keywords.length > 0);
});

test('memory: a repeated publish keeps exactly one published row (atomic upsert)', async () => {
  const agent = await seedAgent();
  const ctx = buildContext({ agentId: agent.agentId });

  await publishFinalPost(buildFinalPost(), ctx);
  await publishFinalPost(buildFinalPost(), ctx);
  await publishFinalPost(buildFinalPost(), ctx);

  const published = await TopicMemory.find({ agentId: agent.agentId, decision: 'published' });
  assert.equal(published.length, 1, 'the upsert is idempotent — one published memory per topic');
});

test('memory: the partial unique index forbids a second published row for the same topic', async () => {
  const agent = await seedAgent();
  await publishFinalPost(buildFinalPost(), buildContext({ agentId: agent.agentId }));

  // A direct attempt to insert a second *published* memory for the same topic
  // must violate the partial unique index.
  await assert.rejects(
    TopicMemory.create({
      agentId: agent.agentId,
      topic: CANDIDATE.title,
      decision: 'published',
      reason: 'A second published row that must not be allowed.',
      postId: 'p_second000000',
      sourceUrls: [CANDIDATE.url],
    }),
    (err) => err.code === 11000
  );
});

test('memory: publishing preserves prior rejected history for the same topic', async () => {
  const agent = await seedAgent();

  // The agent rejected this topic in an earlier cycle — that audit row must survive.
  await TopicMemory.create({
    agentId: agent.agentId,
    topic: CANDIDATE.title,
    decision: 'rejected',
    reason: 'Earlier cycle: the sourcing was too thin to publish.',
    rejectionCategory: 'weak_sources',
    sourceUrls: [],
  });

  await publishFinalPost(buildFinalPost(), buildContext({ agentId: agent.agentId }));

  const all = await TopicMemory.find({ agentId: agent.agentId, normalizedTopic: EXPECTED_NORMALIZED });
  assert.equal(all.length, 2, 'the rejected row and the published row coexist');
  assert.equal(all.filter((m) => m.decision === 'published').length, 1);
  assert.equal(all.filter((m) => m.decision === 'rejected').length, 1);
});

test('memory: multiple rejected rows for one topic remain allowed (audit log semantics)', async () => {
  const agent = await seedAgent();
  const base = {
    agentId: agent.agentId,
    topic: CANDIDATE.title,
    decision: 'rejected',
    rejectionCategory: 'low_novelty',
    sourceUrls: [],
  };
  await TopicMemory.create({ ...base, reason: 'First rejection.' });
  await TopicMemory.create({ ...base, reason: 'Second rejection in a later cycle.' });

  const rejected = await TopicMemory.find({ agentId: agent.agentId, decision: 'rejected' });
  assert.equal(rejected.length, 2, 'the partial index does not constrain rejected history');
});

test('memory: the published row is not written when publication input is invalid', async () => {
  const agent = await seedAgent();
  // Empty body fails validation before any write; no memory row should appear.
  await assert.rejects(
    publishFinalPost(buildFinalPost({ overrides: { text: '  ' } }), buildContext({ agentId: agent.agentId }))
  );
  assert.equal(await TopicMemory.countDocuments(), 0);
});
