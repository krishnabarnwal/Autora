import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { TopicMemory } from '../../src/models/index.js';
import { recordDecision, getTopicMemory } from '../../src/services/memory/index.js';
import { seedAgent, CANDIDATE, PUBLISHED_NORMALIZED } from '../fixtures/memory.js';
import { publishDecisionResult } from '../fixtures/generation.js';

/**
 * Decision recording (§7, §14). recordDecision persists 'rejected'/'deferred'
 * audit rows through the same TopicMemory the publisher uses, reusing its
 * normalization so the stored key matches every lookup. It never writes a
 * 'published' row (that path belongs to the publisher) and never breaks the
 * partial unique index: many rejected/deferred rows for one topic are allowed.
 */

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

test('recordDecision persists a rejection and returns a compact view', async () => {
  const agent = await seedAgent();
  const res = await recordDecision(agent.agentId, {
    decision: 'rejected',
    topic: CANDIDATE.title,
    reason: 'Already covered this beat last week.',
    rejectionCategory: 'repetitive',
    sources: ['https://example.org/a'],
    score: 55,
    cycleId: 'c_reject_0001',
  });

  assert.equal(res.recorded, true);
  assert.equal(res.decision, 'rejected');
  assert.equal(res.normalizedTopic, PUBLISHED_NORMALIZED);
  assert.equal(res.memory.rejectionCategory, 'repetitive');
  assert.deepEqual(res.memory.sources, ['https://example.org/a']);
  assert.equal(res.memory.cycleId, 'c_reject_0001');

  // It is durable and readable back through the exact-topic lookup.
  const stored = await getTopicMemory(agent.agentId, CANDIDATE.title);
  assert.equal(stored.decision, 'rejected');
});

test('recordDecision persists a deferral', async () => {
  const agent = await seedAgent();
  const res = await recordDecision(agent.agentId, {
    decision: 'deferred',
    topic: 'A promising topic to revisit about edge inference',
    reason: 'Interesting but the sourcing is too thin to write yet.',
  });
  assert.equal(res.decision, 'deferred');
  const count = await TopicMemory.countDocuments({ agentId: agent.agentId, decision: 'deferred' });
  assert.equal(count, 1);
});

test('recordDecision stores structured reasons when the caller supplies them', async () => {
  const agent = await seedAgent();
  const res = await recordDecision(agent.agentId, {
    decision: 'rejected',
    topic: 'A structured-reasoning probe about model evaluation',
    reason: 'Two independent problems with this one.',
    reasons: ['Single unnamed source.', 'Restates a vendor announcement.'],
  });

  assert.deepEqual(res.memory.reasons, ['Single unnamed source.', 'Restates a vendor announcement.']);
  const stored = await TopicMemory.findOne({ agentId: agent.agentId }).lean();
  assert.deepEqual(stored.reasons, ['Single unnamed source.', 'Restates a vendor announcement.']);
});

test('recordDecision leaves reasons unset rather than empty when none are supplied', async () => {
  // The absence has to survive to the document: an empty array here would make
  // a cycle that recorded nothing indistinguishable from one that enumerated
  // nothing, and the dashboard decides what to show on exactly that difference.
  const agent = await seedAgent();
  await recordDecision(agent.agentId, {
    decision: 'deferred',
    topic: 'An unenumerated probe about scheduling',
    reason: 'Parked for a later cycle.',
  });

  const stored = await TopicMemory.findOne({ agentId: agent.agentId }).lean();
  assert.equal(stored.reasons, undefined, 'the field is absent, not []');
  const view = await getTopicMemory(agent.agentId, 'An unenumerated probe about scheduling');
  assert.equal(view.reasons, null, 'the view reports absence as null');
});

test('recordDecision bounds and cleans a hostile reasons list', async () => {
  const agent = await seedAgent();
  const res = await recordDecision(agent.agentId, {
    decision: 'rejected',
    topic: 'A hostile-input probe about sanitizers',
    reason: 'Testing the bounds.',
    reasons: [
      '  padded  ', '', '   ', 42, null, { nope: true },
      'x'.repeat(500),
      ...Array.from({ length: 20 }, (_, i) => `filler ${i}`),
    ],
  });

  const { reasons } = res.memory;
  assert.equal(reasons.length, 10, 'capped at MAX_REASONS');
  assert.equal(reasons[0], 'padded', 'trimmed');
  assert.ok(reasons.every((entry) => typeof entry === 'string' && entry.length <= 300),
    'every entry is a bounded string');
  assert.ok(!reasons.includes(''), 'no empty entries survive');
});

test('recordDecision accepts a Phase 9 decision shape via candidate + context', async () => {
  const agent = await seedAgent();
  // A skip-style decision carrying the candidate, plus context for cycle/score.
  const decision = publishDecisionResult({ decision: 'rejected', reason: 'Out of the agent\'s domain this cycle.' });
  const res = await recordDecision(agent.agentId, decision, { cycleId: 'c_ctx_0007', score: 71 });

  assert.equal(res.decision, 'rejected');
  assert.equal(res.normalizedTopic, PUBLISHED_NORMALIZED, 'topic resolved from decision.candidate.title');
  assert.equal(res.memory.cycleId, 'c_ctx_0007');
  assert.equal(res.memory.score, 71);
});
test('audit rows are append-only: many rejections for one topic coexist', async () => {
  const agent = await seedAgent();
  const topic = 'A recurring weak topic about crypto airdrops';
  await recordDecision(agent.agentId, { decision: 'rejected', topic, reason: 'Promotional the first time.' });
  await recordDecision(agent.agentId, { decision: 'rejected', topic, reason: 'Still promotional a week later.' });
  await recordDecision(agent.agentId, { decision: 'deferred', topic, reason: 'Parking it for now.' });

  // The partial unique index constrains only published rows, so three audit
  // rows for one normalized topic is legal — this is the repetition history.
  const count = await TopicMemory.countDocuments({ agentId: agent.agentId });
  assert.equal(count, 3);
});

test('recordDecision never writes a published row', async () => {
  const agent = await seedAgent();
  await recordDecision(agent.agentId, {
    decision: 'rejected', topic: 'A topic about model weights leaking', reason: 'Thin sourcing.',
  });
  const published = await TopicMemory.countDocuments({ agentId: agent.agentId, decision: 'published' });
  assert.equal(published, 0, 'the memory service is not a publication path');
});

test('a null rejectionCategory is accepted (rejection without a category)', async () => {
  const agent = await seedAgent();
  const res = await recordDecision(agent.agentId, {
    decision: 'rejected', topic: 'Uncategorized rejection about telemetry', reason: 'Just not compelling.',
  });
  assert.equal(res.memory.rejectionCategory, null);
});
