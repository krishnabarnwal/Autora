import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { Post, TopicMemory } from '../../src/models/index.js';
import {
  checkRepetition,
  REPETITION_STATUS,
  REPETITION_REASON,
} from '../../src/services/memory/index.js';
import {
  seedAgent, seedMemory, publishCandidate,
  CANDIDATE, PUBLISHED_NORMALIZED, TOPICS, BORDERLINE,
} from '../fixtures/memory.js';

/**
 * Repetition detection (§4, §5). Deterministic policy over stored rows:
 * exact-published -> BLOCKED, recently-rejected -> DISCOURAGED, similar-recent
 * -> DISCOURAGED, otherwise ALLOWED. No LLM, no network. Every case asserts the
 * status, the reason, and the reported metadata — never just a boolean.
 */

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

test('exact published topic is BLOCKED as already_published', async () => {
  const agent = await seedAgent();
  await publishCandidate(agent.agentId);

  const res = await checkRepetition(agent.agentId, CANDIDATE);
  assert.equal(res.status, REPETITION_STATUS.BLOCKED);
  assert.equal(res.reason, REPETITION_REASON.ALREADY_PUBLISHED);
  assert.equal(res.repeated, true);
  assert.equal(res.normalizedTopic, PUBLISHED_NORMALIZED);
  assert.equal(res.similarity, 1);
  assert.equal(res.matchedMemory.decision, 'published');
});

test('word-reordered topic collides with the published key (BLOCKED)', async () => {
  const agent = await seedAgent();
  await publishCandidate(agent.agentId);

  // Same tokens, reversed order. normalizeTopic sorts, so the key is identical.
  const res = await checkRepetition(agent.agentId, { title: TOPICS.reordered });
  assert.equal(res.status, REPETITION_STATUS.BLOCKED);
  assert.equal(res.reason, REPETITION_REASON.ALREADY_PUBLISHED);
  assert.equal(res.normalizedTopic, PUBLISHED_NORMALIZED);
});

test('a Post with no published memory row still BLOCKS (Post is the fallback)', async () => {
  const agent = await seedAgent();
  await publishCandidate(agent.agentId);
  // Simulate the crash-reconcile window: post durably stored, memory not yet.
  await TopicMemory.deleteMany({ decision: 'published' });
  assert.equal(await Post.countDocuments({ agentId: agent.agentId }), 1);

  const res = await checkRepetition(agent.agentId, CANDIDATE);
  assert.equal(res.status, REPETITION_STATUS.BLOCKED);
  assert.equal(res.reason, REPETITION_REASON.ALREADY_PUBLISHED);
  assert.equal(res.matchedMemory.decision, 'published');
});

test('repetition is agent-scoped: another agent is unaffected', async () => {
  const owner = await seedAgent();
  const other = await seedAgent({ name: 'Other', domain: 'Data' });
  await publishCandidate(owner.agentId);

  const res = await checkRepetition(other.agentId, CANDIDATE);
  assert.equal(res.status, REPETITION_STATUS.ALLOWED);
  assert.equal(res.matchedMemory, null);
});
test('exact topic rejected inside the window is DISCOURAGED as recently_rejected', async () => {
  const agent = await seedAgent();
  await seedMemory(agent.agentId, { topic: CANDIDATE.title, decision: 'rejected', ageDays: 2 });

  const res = await checkRepetition(agent.agentId, CANDIDATE, { rejectionWindowDays: 14 });
  assert.equal(res.status, REPETITION_STATUS.DISCOURAGED);
  assert.equal(res.reason, REPETITION_REASON.RECENTLY_REJECTED);
  assert.equal(res.similarity, 1);
  assert.equal(res.windowDays, 14);
  assert.equal(res.matchedMemory.decision, 'rejected');
});

test('a deferred decision also counts as a recent rejection', async () => {
  const agent = await seedAgent();
  await seedMemory(agent.agentId, { topic: CANDIDATE.title, decision: 'deferred', rejectionCategory: null, ageDays: 1 });

  const res = await checkRepetition(agent.agentId, CANDIDATE);
  assert.equal(res.status, REPETITION_STATUS.DISCOURAGED);
  assert.equal(res.reason, REPETITION_REASON.RECENTLY_REJECTED);
  assert.equal(res.matchedMemory.decision, 'deferred');
});

test('a rejection older than the window no longer discourages (ALLOWED)', async () => {
  const agent = await seedAgent();
  await seedMemory(agent.agentId, { topic: CANDIDATE.title, decision: 'rejected', ageDays: 40 });

  const res = await checkRepetition(agent.agentId, CANDIDATE, { rejectionWindowDays: 14, similarityWindowDays: 14 });
  assert.equal(res.status, REPETITION_STATUS.ALLOWED);
  assert.equal(res.reason, null);
});

test('a similar (non-identical) recent topic is DISCOURAGED as similar_recent_topic', async () => {
  const agent = await seedAgent();
  // Nine of the candidate's ten content tokens; drops only "prompt".
  await seedMemory(agent.agentId, { topic: TOPICS.similar, decision: 'rejected', ageDays: 3 });

  const res = await checkRepetition(agent.agentId, CANDIDATE, { similarityThreshold: 0.6 });
  assert.equal(res.status, REPETITION_STATUS.DISCOURAGED);
  assert.equal(res.reason, REPETITION_REASON.SIMILAR_RECENT_TOPIC);
  assert.ok(res.similarity >= 0.6, `expected similarity >= 0.6, got ${res.similarity}`);
  assert.notEqual(res.normalizedTopic, res.matchedMemory.normalizedTopic, 'a similar match is not the exact key');
});

test('an unrelated topic is ALLOWED', async () => {
  const agent = await seedAgent();
  await seedMemory(agent.agentId, { topic: CANDIDATE.title, decision: 'rejected', ageDays: 3 });

  const res = await checkRepetition(agent.agentId, { title: TOPICS.unrelated });
  assert.equal(res.status, REPETITION_STATUS.ALLOWED);
  assert.equal(res.reason, null);
  assert.equal(res.similarity, 0);
  assert.equal(res.matchedMemory, null);
});

test('the similarity threshold is configurable: a borderline pair toggles on it', async () => {
  const agent = await seedAgent();
  await seedMemory(agent.agentId, { topic: BORDERLINE.seeded, decision: 'rejected', ageDays: 1 });

  // Shares 2 of 3 tokens (jaccard 0.5). Above the default floor -> allowed;
  // lower the floor below 0.5 -> the same pair now matches. Deterministic.
  const strict = await checkRepetition(agent.agentId, { title: BORDERLINE.probe }, { similarityThreshold: 0.6 });
  assert.equal(strict.status, REPETITION_STATUS.ALLOWED, 'borderline pair is below the 0.6 floor');

  const loose = await checkRepetition(agent.agentId, { title: BORDERLINE.probe }, { similarityThreshold: 0.4 });
  assert.equal(loose.status, REPETITION_STATUS.DISCOURAGED, 'the same pair matches once the floor drops to 0.4');
  assert.equal(loose.reason, REPETITION_REASON.SIMILAR_RECENT_TOPIC);
});

test('similarity is deterministic across repeated calls', async () => {
  const agent = await seedAgent();
  await seedMemory(agent.agentId, { topic: TOPICS.similar, decision: 'rejected', ageDays: 3 });

  const a = await checkRepetition(agent.agentId, CANDIDATE);
  const b = await checkRepetition(agent.agentId, CANDIDATE);
  assert.deepEqual(a, b);
});

test('a published exact match outranks a similar one (policy order)', async () => {
  const agent = await seedAgent();
  await publishCandidate(agent.agentId);
  await seedMemory(agent.agentId, { topic: TOPICS.similar, decision: 'rejected', ageDays: 1 });

  const res = await checkRepetition(agent.agentId, CANDIDATE);
  assert.equal(res.status, REPETITION_STATUS.BLOCKED);
  assert.equal(res.reason, REPETITION_REASON.ALREADY_PUBLISHED);
});
