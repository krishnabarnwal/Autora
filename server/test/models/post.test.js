import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { Post } from '../../src/models/index.js';

const AGENT_ID = 'agt_1111111111111111';

function makePost(overrides = {}) {
  return {
    agentId: AGENT_ID,
    topic: 'Prompt injection in autonomous agents',
    text: 'A technical note on indirect prompt injection.',
    rationale: 'Selected because it is a live risk for tool-using agents.',
    sources: ['https://example.com/advisory'],
    ...overrides,
  };
}

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

test('post: generates a unique postId and normalizes the topic', async () => {
  const post = await Post.create(makePost());
  assert.match(post.postId, /^p_[0-9a-f]{12}$/);
  // Tokens sorted, stopwords dropped.
  assert.equal(post.normalizedTopic, 'agents autonomous injection prompt');
});

test('post: toFeedJSON matches the required feed contract exactly', async () => {
  const post = await Post.create(makePost());
  const json = post.toFeedJSON();

  assert.deepEqual(Object.keys(json).sort(), ['createdAt', 'id', 'rationale', 'sources', 'text']);
  assert.equal(json.id, post.postId);
  assert.ok(Array.isArray(json.sources) && json.sources.length > 0);

  // ISO 8601 UTC, e.g. 2026-08-07T10:30:00.000Z
  assert.match(json.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(json.createdAt).toISOString(), json.createdAt);
});

test('post: requires at least one source', async () => {
  await assert.rejects(
    Post.create(makePost({ sources: [] })),
    (err) => /at least one source/.test(err.message)
  );
});

test('post: requires text, rationale, and topic', async () => {
  await assert.rejects(Post.create(makePost({ text: undefined })));
  await assert.rejects(Post.create(makePost({ rationale: undefined })));
  await assert.rejects(Post.create(makePost({ topic: undefined })));
});

test('post: the same agent cannot publish the same topic twice', async () => {
  await Post.create(makePost());
  await assert.rejects(
    Post.create(makePost({ topic: 'Prompt injection in autonomous agents' })),
    (err) => err.code === 11000,
    'duplicate normalizedTopic for one agent must violate the unique index'
  );
});

test('post: topic uniqueness is scoped per agent, not global', async () => {
  await Post.create(makePost());
  const other = await Post.create(makePost({ agentId: 'agt_2222222222222222' }));
  assert.ok(other.postId, 'a different agent may cover the same topic');
});

test('post: word-order variants of a topic collide', async () => {
  await Post.create(makePost({ topic: 'Prompt injection in autonomous agents' }));
  await assert.rejects(
    Post.create(makePost({ topic: 'Autonomous agents and prompt injection' })),
    (err) => err.code === 11000
  );
});

test('post: feedFor returns newest first with unique ids', async () => {
  const topics = ['Model weight exfiltration', 'Agent sandbox escapes', 'RAG poisoning at scale'];
  for (const topic of topics) {
    await Post.create(makePost({ topic }));
    // Distinct createdAt values so ordering is unambiguous.
    await new Promise((r) => setTimeout(r, 10));
  }

  const feed = await Post.feedFor(AGENT_ID);
  assert.equal(feed.length, 3);
  assert.equal(feed[0].topic, 'RAG poisoning at scale', 'newest post must come first');

  const times = feed.map((p) => new Date(p.createdAt).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'must be sorted descending');

  const ids = feed.map((p) => p.postId);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
});

test('post: feedFor is scoped to one agent and respects limit', async () => {
  await Post.create(makePost({ topic: 'Supply chain attacks on model registries' }));
  await Post.create(makePost({ topic: 'Sandbox escapes in code interpreters' }));
  await Post.create(
    makePost({ agentId: 'agt_3333333333333333', topic: 'Unrelated topic from another agent' })
  );

  const feed = await Post.feedFor(AGENT_ID);
  assert.equal(feed.length, 2);
  assert.ok(feed.every((p) => p.agentId === AGENT_ID));

  const limited = await Post.feedFor(AGENT_ID, { limit: 1 });
  assert.equal(limited.length, 1);
});

test('post: topics differing only by a short token are treated as the same topic', async () => {
  // Deliberate: the normalizer drops 1-2 character tokens and stopwords, so
  // near-identical topics collapse. This is what stops trivial reruns.
  await Post.create(makePost({ topic: 'Prompt injection in agents' }));
  await assert.rejects(
    Post.create(makePost({ topic: 'Prompt injection of agents' })),
    (err) => err.code === 11000
  );
});

test('post: an agent with no posts yields an empty feed', async () => {
  const feed = await Post.feedFor('agt_nonexistent');
  assert.deepEqual(feed, []);
});

test('post: metadata round-trips through toDetailJSON', async () => {
  const post = await Post.create(
    makePost({ keywords: ['injection', 'agents'], metadata: { score: 88, model: 'gemini-2.5-flash' } })
  );
  const detail = post.toDetailJSON();
  assert.equal(detail.metadata.score, 88);
  assert.equal(detail.metadata.model, 'gemini-2.5-flash');
  assert.deepEqual(detail.keywords, ['injection', 'agents']);
  assert.equal(detail.topic, post.topic);
});

test('post: score outside 0..100 is rejected', async () => {
  await assert.rejects(Post.create(makePost({ metadata: { score: 140 } })));
});
