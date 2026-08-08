/**
 * Live publishing smoke check for Phase 10B.
 *
 * Runs the persistence layer against the REAL database: connect to MongoDB,
 * ensure a clearly-labelled smoke agent exists, assemble a verified FinalPost
 * offline (no LLM call — this script tests the publisher, not the writer), then
 *
 *   publish -> read back through Post.feedFor -> verify the TopicMemory row ->
 *   publish the identical FinalPost again -> assert same postId, no duplicate.
 *
 * Deliberately NOT part of `npm test`: the suite runs offline against an
 * in-process server, whereas this proves the transaction-free idempotent
 * strategy behaves the same way against Atlas (a real replica set).
 *
 * Safety: it touches ONLY records under its own smoke agent and deletes only
 * those at the end — it never calls dropDatabase and never removes real data.
 * It prints no credential: connection is via config, and the final assertion
 * re-scans the output for a connection string or key shape before exiting.
 *
 * Usage: node src/scripts/smoke-publish.js [--json] [--keep]
 */
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Agent, Post, TopicMemory, syncIndexes, personaKeyFor } from '../models/index.js';
import { verifyGeneratedPost } from '../services/generation/index.js';
import { publishFinalPost } from '../services/publisher/index.js';

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A clearly-synthetic persona so the smoke agent is unmistakable and easy to purge. */
const SMOKE_PERSONA = { name: 'Smoke Publisher', domain: 'Phase 10B Smoke' };

/**
 * The one story this smoke post is written from, and the model output that cites
 * it. Assembled through the real verifier so the FinalPost is genuine, but no
 * network or model is involved — the publisher is the only thing under test.
 */
const CANDIDATE = {
  title: 'Phase 10B smoke: verified publishing persists a post and records topic memory',
  url: 'https://example.com/phase-10b-smoke',
  sources: ['Phase 10B Smoke Source'],
};

const GENERATION = {
  text:
    'This is a Phase 10B smoke post. It exists only to prove that the publisher persists a verified '
    + 'FinalPost as a durable Post and records the matching TopicMemory row, then treats an identical '
    + 'second publish as a no-op duplicate rather than creating a rival post. No model wrote this; the '
    + 'smoke script assembled it so the persistence path can be exercised against the real database.',
  hook: 'Proving verified publishing is durable and idempotent.',
  hashtags: ['#Autonomy', '#Publishing'],
  sourceUrls: [CANDIDATE.url],
};

async function main() {
  const asJson = process.argv.includes('--json');
  const keep = process.argv.includes('--keep');
  console.log('--- Live publishing smoke check (Phase 10B) ---\n');

  if (config.db.useEphemeral) {
    console.log('USE_EPHEMERAL_DB=true would test a throwaway server, not the real database.');
    console.log('Unset it (and set MONGODB_URI) to run this against Atlas.');
    process.exitCode = 1;
    return;
  }
  if (!config.db.mongoUri) {
    console.log('Nothing to check: set MONGODB_URI in server/.env to run this against the real database.');
    process.exitCode = 1;
    return;
  }

  await connectDatabase();
  await syncIndexes();
  console.log(`Connected: ${mongoose.connection.name}\n`);

  // Assemble the verified FinalPost offline. If this throws, the fixture is
  // wrong, not the publisher — surface it before any write.
  const finalPost = verifyGeneratedPost(GENERATION, { candidate: CANDIDATE, platform: 'linkedin' });

  let agent;
  try {
    // 1. Ensure the smoke agent exists (idempotent: init returns the same agent).
    const personaKey = personaKeyFor(SMOKE_PERSONA.name, SMOKE_PERSONA.domain);
    agent = await Agent.findOne({ personaKey });
    if (!agent) agent = await Agent.create({ persona: SMOKE_PERSONA });
    console.log(`Smoke agent: ${agent.agentId}\n`);

    // Start from a clean slate for this agent so a prior aborted run cannot make
    // the first publish look like a duplicate. Scoped strictly to the smoke agent.
    await Post.deleteMany({ agentId: agent.agentId });
    await TopicMemory.deleteMany({ agentId: agent.agentId });

    const context = {
      agent,
      topic: CANDIDATE.title,
      rationale: 'Smoke check: exercise the publisher end to end against the real database.',
      reason: 'Deterministic smoke topic.',
      cycleId: 'smoke-publish',
      provider: 'smoke',
      model: 'none',
    };

    // 2. First publish -> a new Post.
    console.log('--- First publish ---');
    const first = await publishFinalPost(finalPost, context);
    console.log(`status: ${first.status}  postId: ${first.postId}\n`);
    check('the first publish created a post', first.created === true, first.status);

    // 3. Read it back through the feed path the API actually uses.
    const feed = await Post.feedFor(agent.agentId);
    const served = feed.find((p) => p.postId === first.postId);
    check('the post is served by Post.feedFor', Boolean(served), `${feed.length} post(s) in feed`);
    if (served) {
      const json = served.toFeedJSON();
      const keys = Object.keys(json).sort().join(',');
      check('the feed JSON matches the contract shape', keys === 'createdAt,id,rationale,sources,text', keys);
      check('the feed post cites the candidate source', json.sources.length === 1 && json.sources[0] === CANDIDATE.url,
        json.sources.join(', '));
      check('createdAt is ISO 8601 UTC', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(json.createdAt), json.createdAt);
    }

    // 4. Verify the TopicMemory row.
    const memory = await TopicMemory.findOne({ agentId: agent.agentId, decision: 'published' });
    check('a published TopicMemory row was recorded', Boolean(memory));
    if (memory) {
      check('the memory links to the persisted post', memory.postId === first.postId, memory.postId);
      check('the memory normalized topic matches the post', memory.normalizedTopic === first.normalizedTopic,
        memory.normalizedTopic);
    }

    // 5. Second identical publish -> duplicate, same post, no second row.
    console.log('\n--- Second (identical) publish ---');
    const second = await publishFinalPost(finalPost, context);
    console.log(`status: ${second.status}  postId: ${second.postId}\n`);
    check('the second publish is a duplicate, not a new post', second.created === false, second.status);
    check('both publishes agree on the same postId', second.postId === first.postId,
      `${first.postId} vs ${second.postId}`);

    const postCount = await Post.countDocuments({ agentId: agent.agentId });
    check('exactly one post exists after two publishes', postCount === 1, `${postCount} post(s)`);

    const publishedCount = await TopicMemory.countDocuments({ agentId: agent.agentId, decision: 'published' });
    check('exactly one published memory row exists', publishedCount === 1, `${publishedCount} row(s)`);

    // 6. No credential in anything printed.
    const serialized = JSON.stringify({ first, second, feed: served?.toDetailJSON?.() ?? null });
    check('nothing in the output carries a connection string or key',
      !/mongodb(\+srv)?:\/\//.test(serialized) && !/AIza[0-9A-Za-z._-]{10,}/.test(serialized));
  } finally {
    // 7. Clean up ONLY this smoke agent's records. Never a broad delete.
    if (agent && !keep) {
      await Post.deleteMany({ agentId: agent.agentId });
      await TopicMemory.deleteMany({ agentId: agent.agentId });
      await Agent.deleteOne({ agentId: agent.agentId });
      console.log('\nCleaned up the smoke agent and its records.');
    } else if (keep) {
      console.log('\n--keep set: leaving the smoke records in place.');
    }
    await disconnectDatabase();
  }

  if (asJson) console.log(`\n${JSON.stringify({ results }, null, 2)}`);
  console.log(`\n--- ${results.length - failed}/${results.length} passed ---`);
  // process.exitCode, not process.exit(): exiting while the keep-alive socket is
  // still closing aborts libuv on Windows and replaces the status with garbage.
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  // Never print a raw driver message: it can quote the connection string.
  console.error('\nPUBLISH SMOKE CHECK FAILED:', err?.code || err?.name || 'error');
  process.exitCode = 1;
});
