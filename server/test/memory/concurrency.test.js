import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { Post, TopicMemory } from '../../src/models/index.js';
import {
  checkRepetition, recordDecision, REPETITION_STATUS,
} from '../../src/services/memory/index.js';
import { seedAgent, publishCandidate, CANDIDATE } from '../fixtures/memory.js';

/**
 * Concurrency and the advisory boundary (§13).
 *
 * The central, deliberately-designed property: checkRepetition is ADVISORY. It
 * reports what was written before it ran. Two cycles that both check a brand-new
 * topic before either publishes will BOTH be told 'allowed' — the memory layer
 * must not, and does not, pretend otherwise. The Post's unique
 * (agentId, normalizedTopic) index — exercised via the real publisher — remains
 * the final, authoritative guarantee that only one post per topic is ever
 * stored. These tests prove exactly that division of responsibility.
 */

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

test('advisory race: two concurrent checks on a never-published topic both return allowed', async () => {
  const agent = await seedAgent();

  // No write has happened yet, so neither check can see the other. This is the
  // documented advisory behaviour, not a bug: memory reflects committed history.
  const [a, b] = await Promise.all([
    checkRepetition(agent.agentId, CANDIDATE),
    checkRepetition(agent.agentId, CANDIDATE),
  ]);

  assert.equal(a.status, REPETITION_STATUS.ALLOWED);
  assert.equal(b.status, REPETITION_STATUS.ALLOWED);
});

test('advisory race: the DB unique index, not memory, enforces one post per topic', async () => {
  const agent = await seedAgent();

  // Both cycles saw "allowed" (previous test). They now both proceed to publish
  // the same topic concurrently. The publisher's unique index must collapse the
  // race to exactly one Post — the memory advice being permissive did not, and
  // must not, create a duplicate.
  const results = await Promise.all([
    publishCandidate(agent.agentId),
    publishCandidate(agent.agentId),
  ]);

  const created = results.filter((r) => r.created);
  assert.equal(created.length, 1, 'exactly one publish created the post');
  assert.equal(await Post.countDocuments({ agentId: agent.agentId }), 1, 'the unique index is the real guarantee');
  assert.equal(await TopicMemory.countDocuments({ decision: 'published' }), 1, 'exactly one published memory');

  // And after the writes commit, memory correctly reports the topic as blocked.
  const after = await checkRepetition(agent.agentId, CANDIDATE);
  assert.equal(after.status, REPETITION_STATUS.BLOCKED);
});

test('a check after a committed publish is BLOCKED (advice tracks committed state)', async () => {
  const agent = await seedAgent();

  const before = await checkRepetition(agent.agentId, CANDIDATE);
  assert.equal(before.status, REPETITION_STATUS.ALLOWED, 'allowed before anything is written');

  await publishCandidate(agent.agentId);

  const after = await checkRepetition(agent.agentId, CANDIDATE);
  assert.equal(after.status, REPETITION_STATUS.BLOCKED, 'blocked once the publish is committed');
});

test('concurrent rejections of one topic all persist (audit log is append-only)', async () => {
  const agent = await seedAgent();

  // Unlike published rows, rejected rows are not uniquely constrained, so
  // concurrent records must all succeed — this is the repetition history.
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) => recordDecision(agent.agentId, {
      decision: 'rejected', topic: CANDIDATE.title, reason: `Concurrent rejection ${i}.`,
    }))
  );

  assert.equal(results.filter((r) => r.recorded).length, 4);
  assert.equal(await TopicMemory.countDocuments({ agentId: agent.agentId, decision: 'rejected' }), 4);
});
