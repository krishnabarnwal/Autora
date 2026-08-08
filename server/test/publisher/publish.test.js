import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { Post, TopicMemory } from '../../src/models/index.js';
import { normalizeTopic } from '../../src/utils/text.js';
import {
  publishFinalPost,
  PublisherInputError,
  PUBLISH_STATUS,
} from '../../src/services/publisher/index.js';
import {
  buildFinalPost,
  buildContext,
  seedAgent,
  CANDIDATE,
  publishDecisionResult,
} from '../fixtures/publisher.js';

/**
 * The publisher's front door: it must reject every unpublishable input BEFORE
 * touching MongoDB (the 12 enumerated validation cases), then, on valid input,
 * persist a Post that maps cleanly onto the feed contract. The FinalPost here is
 * a real verified one, so these tests are about the true runtime object.
 */

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

const EXPECTED_NORMALIZED = normalizeTopic(CANDIDATE.title);

/** Assert a call rejects as a PublisherInputError with a specific code, and wrote nothing. */
async function rejectsInput(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof PublisherInputError, `expected PublisherInputError, got ${err?.name}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
  assert.equal(await Post.countDocuments(), 0, 'no Post may be written on invalid input');
  assert.equal(await TopicMemory.countDocuments(), 0, 'no TopicMemory may be written on invalid input');
}

// --- The 12 validation cases (§7): reject before any database write ----------

test('validate 1/12: a non-object FinalPost is rejected as invalid_final_post', async () => {
  await rejectsInput(publishFinalPost(null, buildContext({ agentId: 'agt_x' })), 'invalid_final_post');
});

test('validate 2/12: an empty body is rejected as empty_text', async () => {
  await rejectsInput(
    publishFinalPost(buildFinalPost({ overrides: { text: '   ' } }), buildContext({ agentId: 'agt_x' })),
    'empty_text'
  );
});

test('validate 3/12: an over-limit body is rejected as text_too_long', async () => {
  await rejectsInput(
    publishFinalPost(buildFinalPost({ overrides: { text: 'x'.repeat(5001) } }), buildContext({ agentId: 'agt_x' })),
    'text_too_long'
  );
});

test('validate 4/12: no source URL is rejected as missing_sources', async () => {
  await rejectsInput(
    publishFinalPost(buildFinalPost({ overrides: { sourceUrls: [] } }), buildContext({ agentId: 'agt_x' })),
    'missing_sources'
  );
});

test('validate 5/12: a non-URL source is rejected as invalid_source', async () => {
  await rejectsInput(
    publishFinalPost(buildFinalPost({ overrides: { sourceUrls: ['not a url'] } }), buildContext({ agentId: 'agt_x' })),
    'invalid_source'
  );
});

test('validate 6/12: a context with no agent is rejected as missing_agent', async () => {
  await rejectsInput(publishFinalPost(buildFinalPost(), { decision: publishDecisionResult() }), 'missing_agent');
});

test('validate 7/12: a context with no topic is rejected as missing_topic', async () => {
  // No context.topic and a decision carrying no candidate -> nothing to derive a topic from.
  await rejectsInput(publishFinalPost(buildFinalPost(), { agentId: 'agt_x', decision: {} }), 'missing_topic');
});

test('validate 8/12: a topic that normalizes to nothing is rejected as missing_normalized_topic', async () => {
  await rejectsInput(
    publishFinalPost(buildFinalPost(), { agentId: 'agt_x', topic: '!!! ---', decision: {} }),
    'missing_normalized_topic'
  );
});

test('validate 9/12: no derivable rationale is rejected as missing_rationale', async () => {
  // A valid topic but a decision with no angle/reason and no explicit rationale.
  await rejectsInput(
    publishFinalPost(buildFinalPost(), { agentId: 'agt_x', topic: 'A perfectly valid topic', decision: {} }),
    'missing_rationale'
  );
});

test('validate 10/12: an unknown agentId is rejected as unknown_agent', async () => {
  // Everything is well-formed, but no such agent exists — a typo must not orphan a post.
  await rejectsInput(
    publishFinalPost(buildFinalPost(), buildContext({ agentId: 'agt_does_not_exist' })),
    'unknown_agent'
  );
});

test('validate 11/12: a well-formed publish for a real agent succeeds', async () => {
  const agent = await seedAgent();
  const result = await publishFinalPost(buildFinalPost(), buildContext({ agentId: agent.agentId }));
  assert.equal(result.status, PUBLISH_STATUS.PUBLISHED);
  assert.equal(result.created, true);
  assert.equal(await Post.countDocuments(), 1);
});

test('validate 12/12: a second identical publish is a duplicate, not a second post', async () => {
  const agent = await seedAgent();
  const ctx = buildContext({ agentId: agent.agentId });
  const first = await publishFinalPost(buildFinalPost(), ctx);
  const second = await publishFinalPost(buildFinalPost(), ctx);
  assert.equal(first.status, PUBLISH_STATUS.PUBLISHED);
  assert.equal(second.status, PUBLISH_STATUS.DUPLICATE);
  assert.equal(second.postId, first.postId);
  assert.equal(await Post.countDocuments(), 1);
});

// --- The happy path: field mapping (§2) --------------------------------------

test('publish: maps the FinalPost and context onto the Post schema faithfully', async () => {
  const agent = await seedAgent();
  const finalPost = buildFinalPost();
  const decision = publishDecisionResult();
  const result = await publishFinalPost(finalPost, buildContext({ agentId: agent.agentId, decision }));

  const post = await Post.findOne({ postId: result.postId });
  assert.ok(post, 'the post must be persisted');

  // Identity and repetition key.
  assert.equal(post.agentId, agent.agentId);
  assert.equal(post.topic, CANDIDATE.title);
  assert.equal(post.normalizedTopic, EXPECTED_NORMALIZED);
  assert.equal(result.normalizedTopic, EXPECTED_NORMALIZED, 'the returned key matches what is stored');

  // Content, verbatim from the verified FinalPost.
  assert.equal(post.text, finalPost.text);
  assert.deepEqual(post.sources, [CANDIDATE.url]);

  // Rationale comes from the editorial decision, never the FinalPost.
  assert.equal(post.rationale, `${decision.angle} — ${decision.reason}`);

  // Provenance metadata.
  assert.equal(post.metadata.provider, 'mock');
  assert.equal(post.metadata.model, 'mock-1');
  assert.equal(post.metadata.cycleId, 'c_publish_0001');
  assert.equal(post.metadata.score, 86, 'confidence 0.86 scales to a 0..100 score');
  assert.ok(Array.isArray(post.keywords) && post.keywords.length > 0);
});

test('publish: an explicit context.rationale overrides the decision-derived one', async () => {
  const agent = await seedAgent();
  const result = await publishFinalPost(
    buildFinalPost(),
    buildContext({ agentId: agent.agentId, overrides: { rationale: 'A curated editorial rationale.' } })
  );
  const post = await Post.findOne({ postId: result.postId });
  assert.equal(post.rationale, 'A curated editorial rationale.');
});

test('publish: accepts a full agent document and skips the existence lookup', async () => {
  const agent = await seedAgent();
  // Passing the document (not just the id) is the hot-path shape; it must publish.
  const result = await publishFinalPost(buildFinalPost(), buildContext({ agent }));
  assert.equal(result.status, PUBLISH_STATUS.PUBLISHED);
  assert.equal(result.agentId, agent.agentId);
});

// --- The feed contract (§2, §8): the published Post must serve the feed -------

test('publish: the persisted Post satisfies the GET /feed contract exactly', async () => {
  const agent = await seedAgent();
  const finalPost = buildFinalPost();
  const result = await publishFinalPost(finalPost, buildContext({ agentId: agent.agentId }));

  const [fromFeed] = await Post.feedFor(agent.agentId);
  assert.equal(fromFeed.postId, result.postId, 'the published post is the one the feed serves');

  const json = fromFeed.toFeedJSON();
  assert.deepEqual(Object.keys(json).sort(), ['createdAt', 'id', 'rationale', 'sources', 'text']);
  assert.equal(json.id, result.postId);
  assert.equal(json.text, finalPost.text);
  assert.deepEqual(json.sources, [CANDIDATE.url]);
  assert.match(json.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(json.createdAt).toISOString(), json.createdAt);
});

test('publish: two agents may publish the same topic; uniqueness is per-agent', async () => {
  const a = await seedAgent({ name: 'Sentinel', domain: 'AI Security' });
  const b = await seedAgent({ name: 'Watcher', domain: 'AI Security' });
  const r1 = await publishFinalPost(buildFinalPost(), buildContext({ agentId: a.agentId }));
  const r2 = await publishFinalPost(buildFinalPost(), buildContext({ agentId: b.agentId }));
  assert.equal(r1.status, PUBLISH_STATUS.PUBLISHED);
  assert.equal(r2.status, PUBLISH_STATUS.PUBLISHED);
  assert.notEqual(r1.postId, r2.postId);
  assert.equal(await Post.countDocuments(), 2);
});
