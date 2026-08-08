/**
 * Live smoke check against the configured database (real Atlas, not a mock).
 *
 * Verifies, in order: config validation -> connect -> index sync -> HTTP listen
 * -> /api/health -> real write/read/delete -> graceful shutdown -> sockets closed.
 *
 * Usage: node src/scripts/smoke.js
 */
import mongoose from 'mongoose';
import { startServer } from '../bootstrap.js';
import { config } from '../config/env.js';
import { databaseStatus } from '../config/database.js';
import { Agent, Post, TopicMemory } from '../models/index.js';

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log('--- Live database smoke check ---\n');

  const { server, shutdown } = await startServer();
  const base = `http://localhost:${config.port}`;

  const status = databaseStatus();
  check(
    'connected to a persistent database',
    status.healthy && status.persistent,
    `kind=${status.kind} db=${status.database}`
  );
  check('did NOT silently use an ephemeral database', status.kind === 'mongodb', `kind=${status.kind}`);

  // Health endpoint reflects real database state.
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  check('/api/health reports ok', health.ok === true, `status=${health.database?.status}`);
  check(
    '/api/health ping succeeded',
    health.database?.ping?.ok === true,
    `latency=${health.database?.ping?.latencyMs}ms`
  );
  check(
    '/api/health leaks no connection string',
    !JSON.stringify(health).includes('mongodb+srv://') && !JSON.stringify(health).includes('@cluster')
  );

  // Real round-trip through all three models.
  const agent = await Agent.create({ persona: { name: 'SmokeTest', domain: 'AI Security' } });
  check('Agent write + generated id', /^agt_[0-9a-f]{16}$/.test(agent.agentId), agent.agentId);

  const post = await Post.create({
    agentId: agent.agentId,
    topic: `Smoke check ${agent.agentId}`,
    text: 'Temporary record written by the smoke script.',
    rationale: 'Verifies a real write path against the configured database.',
    sources: ['https://example.com/smoke'],
  });
  check(
    'Post write + feed shape',
    Boolean(post.toFeedJSON().id) && post.toFeedJSON().createdAt.endsWith('Z')
  );

  await TopicMemory.create({
    agentId: agent.agentId,
    topic: `Smoke rejection ${agent.agentId}`,
    decision: 'rejected',
    reason: 'Smoke script record.',
    rejectionCategory: 'other',
    score: 10,
  });

  const feed = await Post.feedFor(agent.agentId);
  check('read back through feedFor', feed.length === 1 && feed[0].postId === post.postId);

  // Duplicate topic must be refused by the unique index on the real server.
  let duplicateRejected = false;
  try {
    await Post.create({
      agentId: agent.agentId,
      topic: `Smoke check ${agent.agentId}`,
      text: 'duplicate',
      rationale: 'duplicate',
      sources: ['https://example.com/smoke'],
    });
  } catch (err) {
    duplicateRejected = err.code === 11000;
  }
  check('duplicate topic rejected by unique index', duplicateRejected);

  // Clean up so the smoke run leaves nothing behind.
  await Promise.all([
    Agent.deleteOne({ agentId: agent.agentId }),
    Post.deleteMany({ agentId: agent.agentId }),
    TopicMemory.deleteMany({ agentId: agent.agentId }),
  ]);
  const leftover = await Post.countDocuments({ agentId: agent.agentId });
  check('test records cleaned up', leftover === 0);

  // Graceful shutdown.
  await shutdown('SMOKE');
  check(
    'mongoose disconnected after shutdown',
    mongoose.connection.readyState === 0,
    `readyState=${mongoose.connection.readyState}`
  );
  check('http server no longer listening', server.listening === false);

  const stillUp = await fetch(`${base}/api/health`)
    .then(() => true)
    .catch(() => false);
  check('port released after shutdown', stillUp === false);

  console.log(`\n--- ${results.length - failed}/${results.length} passed ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSMOKE CHECK FAILED:', err.message);
  process.exit(1);
});
