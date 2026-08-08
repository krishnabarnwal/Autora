import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { Post, TopicMemory } from '../../src/models/index.js';
import { publishFinalPost, PUBLISH_STATUS } from '../../src/services/publisher/index.js';
import { buildFinalPost, buildContext, seedAgent, CANDIDATE } from '../fixtures/publisher.js';

/**
 * Idempotency and concurrency (§4). The Post's unique (agentId, normalizedTopic)
 * index is the single arbiter of "already published". These tests prove that
 * calling the publisher twice — sequentially, concurrently, or after a crash
 * that lost the memory row — converges on exactly one Post and one published
 * memory, and never throws a duplicate-key error at the caller.
 */

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

test('idempotent: the second sequential publish returns the same Post and creates no duplicate', async () => {
  const agent = await seedAgent();
  const ctx = buildContext({ agentId: agent.agentId });

  const first = await publishFinalPost(buildFinalPost(), ctx);
  const second = await publishFinalPost(buildFinalPost(), ctx);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.status, PUBLISH_STATUS.DUPLICATE);
  assert.equal(second.postId, first.postId, 'the existing post is returned unchanged');
  assert.equal(await Post.countDocuments(), 1, 'exactly one post');
  assert.equal(await TopicMemory.countDocuments({ decision: 'published' }), 1, 'exactly one published memory');
});

test('idempotent: a duplicate never overwrites the original Post body', async () => {
  const agent = await seedAgent();
  const ctx = buildContext({ agentId: agent.agentId });

  const first = await publishFinalPost(buildFinalPost(), ctx);
  const original = await Post.findOne({ postId: first.postId });

  // A second publish for the same topic but different text must NOT edit the post.
  const altered = buildFinalPost({ overrides: { text: `${original.text} EDITED SECOND TIME.` } });
  const second = await publishFinalPost(altered, ctx);

  assert.equal(second.postId, first.postId);
  const after = await Post.findOne({ postId: first.postId });
  assert.equal(after.text, original.text, 'the stored body is unchanged by the duplicate publish');
});

test('concurrent: five simultaneous identical publishes create exactly one Post', async () => {
  const agent = await seedAgent();
  const ctx = buildContext({ agentId: agent.agentId });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => publishFinalPost(buildFinalPost(), ctx))
  );

  // Every call resolves (none throws a raw duplicate-key error at the caller).
  assert.equal(results.length, 5);
  const created = results.filter((r) => r.created);
  const duplicates = results.filter((r) => r.duplicate);
  assert.equal(created.length, 1, 'exactly one call created the post');
  assert.equal(duplicates.length, 4, 'the other four saw the duplicate');

  // All agree on the same postId.
  const ids = new Set(results.map((r) => r.postId));
  assert.equal(ids.size, 1, 'all callers converge on one postId');

  assert.equal(await Post.countDocuments(), 1, 'the database holds exactly one post');
  assert.equal(
    await TopicMemory.countDocuments({ decision: 'published' }),
    1,
    'the partial unique index holds the memory to one published row'
  );
});

test('concurrent: two agents racing on the same topic each get exactly one Post', async () => {
  const a = await seedAgent({ name: 'Sentinel', domain: 'AI Security' });
  const b = await seedAgent({ name: 'Watcher', domain: 'AI Security' });

  const results = await Promise.all([
    ...Array.from({ length: 3 }, () => publishFinalPost(buildFinalPost(), buildContext({ agentId: a.agentId }))),
    ...Array.from({ length: 3 }, () => publishFinalPost(buildFinalPost(), buildContext({ agentId: b.agentId }))),
  ]);

  assert.equal(results.filter((r) => r.created).length, 2, 'one create per agent');
  assert.equal(await Post.countDocuments(), 2);
  assert.equal(await Post.countDocuments({ agentId: a.agentId }), 1);
  assert.equal(await Post.countDocuments({ agentId: b.agentId }), 1);
});

test('reconcile: a publish after a crash that lost the memory heals it without a second Post', async () => {
  const agent = await seedAgent();
  const ctx = buildContext({ agentId: agent.agentId });

  // First publish, then simulate the crash-between-steps state: the Post exists
  // but its published memory row was never written (or was lost).
  const first = await publishFinalPost(buildFinalPost(), ctx);
  await TopicMemory.deleteMany({ decision: 'published' });
  assert.equal(await TopicMemory.countDocuments({ decision: 'published' }), 0);

  // Re-publishing the same topic hits the Post's unique index (duplicate), and
  // the $setOnInsert upsert re-creates the missing memory pointing at the post.
  const second = await publishFinalPost(buildFinalPost(), ctx);
  assert.equal(second.status, PUBLISH_STATUS.DUPLICATE);
  assert.equal(second.postId, first.postId, 'no second post is created');
  assert.equal(await Post.countDocuments(), 1);

  const healed = await TopicMemory.findOne({ agentId: agent.agentId, decision: 'published' });
  assert.ok(healed, 'the missing memory is reconciled');
  assert.equal(healed.postId, first.postId, 'the healed memory points at the real post');
});

test('idempotent: word-order variants of the topic are treated as the same publication', async () => {
  const agent = await seedAgent();

  const first = await publishFinalPost(
    buildFinalPost(),
    buildContext({ agentId: agent.agentId, overrides: { topic: 'Prompt injection in autonomous agents' } })
  );
  const second = await publishFinalPost(
    buildFinalPost(),
    buildContext({ agentId: agent.agentId, overrides: { topic: 'Autonomous agents and prompt injection' } })
  );

  assert.equal(first.created, true);
  assert.equal(second.created, false, 'a reordered topic normalizes to the same key');
  assert.equal(second.postId, first.postId);
  assert.equal(await Post.countDocuments(), 1);
});
