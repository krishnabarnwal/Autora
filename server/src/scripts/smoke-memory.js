/**
 * Live memory smoke check for Phase 11.
 *
 * Runs the topic-memory + repetition layer against the REAL database: connect to
 * MongoDB, create a clearly-labelled smoke agent, then walk the full contract
 * against Atlas rather than the in-process test server:
 *
 *   empty memory -> record a rejection -> read it back -> detect exact repetition
 *   -> confirm an unrelated topic is allowed -> detect a reworded (similar) topic
 *   -> record a deferral -> confirm newest-first history -> confirm the rejection
 *   window is honoured -> confirm an out-of-window memory no longer repeats ->
 *   confirm recordDecision refuses 'published' (the publisher owns that) and that
 *   the real publisher path still blocks a published topic.
 *
 * Deliberately NOT part of `npm test`: the suite runs offline against an
 * in-process server, whereas this proves the same deterministic judgements hold
 * against Atlas. No LLM and no network: the memory layer is pure DB + token math,
 * and the single published row is written by the real publisher, not by this
 * script.
 *
 * Safety: it touches ONLY records under its own smoke agent and deletes only
 * those at the end — it never calls dropDatabase and never removes real data.
 * It prints no credential: connection is via config, and a final assertion
 * re-scans the output for a connection string or key shape before exiting.
 *
 * Usage: node src/scripts/smoke-memory.js [--json] [--keep]
 */
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Agent, Post, TopicMemory, syncIndexes, personaKeyFor } from '../models/index.js';
import { normalizeTopic } from '../utils/text.js';
import { verifyGeneratedPost } from '../services/generation/index.js';
import { publishFinalPost } from '../services/publisher/index.js';
import {
  getTopicMemory,
  getRecentMemory,
  checkRepetition,
  recordDecision,
  REPETITION_STATUS,
  REPETITION_REASON,
  MemoryInputError,
} from '../services/memory/index.js';

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Assert that an async call rejects with a specific MemoryInputError code. */
async function expectThrows(name, fn, code) {
  try {
    await fn();
    check(name, false, 'did not throw');
  } catch (err) {
    check(name, err instanceof MemoryInputError && err.code === code, err?.code || err?.name || 'error');
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A clearly-synthetic persona so the smoke agent is unmistakable and easy to purge. */
const SMOKE_PERSONA = { name: 'Smoke Memory', domain: 'Phase 11 Smoke' };

// Deterministic topics with known token relationships (see comments inline).
const REJECTED = 'Phase 11 smoke rejected candidate about unremarkable incremental tooling updates';
// Shares 6 of REJECTED's 8 content tokens (drops "phase"/"smoke", adds
// "reconsidered"): Jaccard 6/9 ≈ 0.67 -> a similar, non-identical topic.
const REJECTED_SIMILAR = 'Unremarkable incremental tooling updates rejected candidate reconsidered';
// Disjoint tokens -> no repetition.
const DIFFERENT = 'A friendly guide to brewing better espresso at home';
const DEFERRED = 'Phase 11 smoke deferred candidate about promising but underdeveloped research directions';
const STALE = 'Phase 11 smoke stale topic about an ancient outdated matter well beyond the window';

/** The one story the published row is written from, assembled offline (no model). */
const CANDIDATE = {
  title: 'Phase 11 smoke published topic memory detects repetition across autonomous cycles',
  url: 'https://example.com/phase-11-smoke-published',
  sources: ['Phase 11 Smoke Source'],
};
const GENERATION = {
  text:
    'This is a Phase 11 smoke post. It exists only so the memory layer has a genuinely published topic to '
    + 'recognise: the publisher persists it as a durable Post and its published TopicMemory row, and '
    + 'checkRepetition must then report the exact topic as already published. No model wrote this text; the '
    + 'smoke script assembled it so the repetition path can be exercised against the real database.',
  hook: 'Proving topic memory recognises a genuinely published topic.',
  hashtags: ['#Autonomy', '#Memory'],
  sourceUrls: [CANDIDATE.url],
};

async function main() {
  const asJson = process.argv.includes('--json');
  const keep = process.argv.includes('--keep');
  console.log('--- Live memory smoke check (Phase 11) ---\n');

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

  let agent;
  try {
    // 1. Ensure the smoke agent exists (idempotent), then start from a clean slate
    //    scoped strictly to it so a prior aborted run cannot skew a judgement.
    const personaKey = personaKeyFor(SMOKE_PERSONA.name, SMOKE_PERSONA.domain);
    agent = await Agent.findOne({ personaKey });
    if (!agent) agent = await Agent.create({ persona: SMOKE_PERSONA });
    console.log(`Smoke agent: ${agent.agentId}\n`);
    await Post.deleteMany({ agentId: agent.agentId });
    await TopicMemory.deleteMany({ agentId: agent.agentId });

    // 2. A fresh agent has no memory of this topic and no recent history.
    console.log('--- Initial (empty) state ---');
    check('getTopicMemory returns null for an unseen topic', (await getTopicMemory(agent.agentId, REJECTED)) === null);
    const emptyRecent = await getRecentMemory(agent.agentId);
    check('getRecentMemory returns an empty list initially', Array.isArray(emptyRecent) && emptyRecent.length === 0,
      `${emptyRecent.length} row(s)`);

    // 3. Record a rejection, then read it back and verify every stored field.
    console.log('\n--- Record + read back a rejection ---');
    const rejectSources = ['https://example.com/phase-11-smoke-rejected'];
    const recorded = await recordDecision(agent.agentId, {
      decision: 'rejected',
      topic: REJECTED,
      reason: 'Covered this incremental tooling beat already; nothing new to say.',
      rejectionCategory: 'repetitive',
      sources: rejectSources,
      cycleId: 'smoke-memory-reject',
    });
    check('recordDecision reports the rejection was recorded', recorded.recorded === true && recorded.decision === 'rejected');

    const view = recorded.memory;
    check('recorded normalizedTopic matches the normalizer', view.normalizedTopic === normalizeTopic(REJECTED),
      view.normalizedTopic);
    check('recorded topic is preserved verbatim', view.topic === REJECTED);
    check('recorded decision is rejected', view.decision === 'rejected');
    check('recorded rejectionCategory is preserved', view.rejectionCategory === 'repetitive', String(view.rejectionCategory));
    check('recorded source URLs are preserved', JSON.stringify(view.sources) === JSON.stringify(rejectSources),
      view.sources.join(', '));
    check('recorded cycleId is preserved', view.cycleId === 'smoke-memory-reject', String(view.cycleId));

    // The audit fields the compact view intentionally omits (agentId, reason) are
    // read straight off the stored document, scoped to this agent + topic.
    const row = await TopicMemory.findOne({ agentId: agent.agentId, normalizedTopic: view.normalizedTopic });
    check('the stored row is scoped to the smoke agent', Boolean(row) && row.agentId === agent.agentId);
    check('the stored row keeps the rejection reason', Boolean(row) && typeof row.reason === 'string' && row.reason.length > 0);

    // 4. Exact repetition is detected (recently rejected -> discouraged).
    console.log('\n--- Repetition detection ---');
    const exact = await checkRepetition(agent.agentId, { title: REJECTED });
    check('an exact recently-rejected topic is flagged as repetition',
      exact.repeated === true && exact.status === REPETITION_STATUS.DISCOURAGED
      && exact.reason === REPETITION_REASON.RECENTLY_REJECTED, `${exact.status}/${exact.reason}`);

    // 5. A clearly different topic is NOT repetition.
    const different = await checkRepetition(agent.agentId, { title: DIFFERENT });
    check('an unrelated topic is not flagged as repetition',
      different.repeated === false && different.status === REPETITION_STATUS.ALLOWED,
      `${different.status}/${different.reason}`);

    // 6. A reworded version of the rejected topic is caught by similarity.
    const similar = await checkRepetition(agent.agentId, { title: REJECTED_SIMILAR });
    check('a differently-worded version of the same topic is flagged as similar',
      similar.repeated === true && similar.status === REPETITION_STATUS.DISCOURAGED
      && similar.reason === REPETITION_REASON.SIMILAR_RECENT_TOPIC, `${similar.status}/${similar.reason}`);
    check('the similar match reports a similarity at or above the threshold',
      similar.similarity >= similar.threshold, `similarity=${similar.similarity} threshold=${similar.threshold}`);

    // 7. Record a deferral; it is retained as history alongside the rejection.
    console.log('\n--- Deferral + history ordering ---');
    await recordDecision(agent.agentId, {
      decision: 'deferred',
      topic: DEFERRED,
      reason: 'Promising but underdeveloped; revisit when the sourcing firms up.',
      cycleId: 'smoke-memory-defer',
    });
    const deferredBack = await getTopicMemory(agent.agentId, DEFERRED);
    check('a deferred decision is retained as history', Boolean(deferredBack) && deferredBack.decision === 'deferred');

    // 8. History is newest-first: the deferral (just written) precedes the rejection.
    const recent = await getRecentMemory(agent.agentId);
    check('getRecentMemory returns both decisions', recent.length === 2, `${recent.length} row(s)`);
    check('history is newest-first (deferral before rejection)',
      recent.length === 2 && recent[0].decision === 'deferred' && recent[1].decision === 'rejected',
      recent.map((r) => r.decision).join(' > '));
    const bounded = await getRecentMemory(agent.agentId, { limit: 1 });
    check('getRecentMemory honours a bounded limit', bounded.length === 1, `${bounded.length} row(s)`);

    // 9. The rejection window is a live knob: the fresh rejection sits inside it.
    console.log('\n--- Rejection window ---');
    const windowed = await checkRepetition(agent.agentId, { title: REJECTED }, { rejectionWindowDays: 14 });
    check('a fresh rejection is inside the configured window', windowed.windowDays === 14
      && windowed.reason === REPETITION_REASON.RECENTLY_REJECTED, `windowDays=${windowed.windowDays}`);

    // 10. An out-of-window memory no longer repeats. Record a rejection, backdate
    //     ONLY that row (its own _id) to 40 days ago, then check with a 14/14 window.
    const staleRec = await recordDecision(agent.agentId, {
      decision: 'rejected', topic: STALE, reason: 'Old rejection, kept only to prove the window boundary.',
    });
    const staleRow = await TopicMemory.findOne({ agentId: agent.agentId, normalizedTopic: staleRec.normalizedTopic });
    await TopicMemory.collection.updateOne(
      { _id: staleRow._id },
      { $set: { createdAt: new Date(Date.now() - 40 * DAY_MS) } }
    );
    const staleCheck = await checkRepetition(
      agent.agentId, { title: STALE }, { rejectionWindowDays: 14, similarityWindowDays: 14 }
    );
    check('an out-of-window memory does not trigger repetition',
      staleCheck.repeated === false && staleCheck.status === REPETITION_STATUS.ALLOWED,
      `${staleCheck.status}/${staleCheck.reason}`);

    // 11. recordDecision must refuse 'published': that path belongs to the publisher.
    console.log('\n--- Published stays the publisher\'s responsibility ---');
    await expectThrows('recordDecision refuses a published decision',
      () => recordDecision(agent.agentId, { decision: 'published', topic: CANDIDATE.title, reason: 'nope' }),
      'published_requires_publisher');
    const publishedViaMemory = await TopicMemory.countDocuments({ agentId: agent.agentId, decision: 'published' });
    check('no published row was written by the memory layer', publishedViaMemory === 0, `${publishedViaMemory} row(s)`);

    // The real publisher writes the published row; memory then reads it and blocks.
    const finalPost = verifyGeneratedPost(GENERATION, { candidate: CANDIDATE, platform: 'linkedin' });
    const publishResult = await publishFinalPost(finalPost, {
      agent,
      topic: CANDIDATE.title,
      rationale: 'Smoke check: give the memory layer a genuinely published topic to recognise.',
      reason: 'Deterministic smoke topic.',
      cycleId: 'smoke-memory-publish',
      provider: 'smoke',
      model: 'none',
    });
    check('the publisher created the published post', publishResult.created === true, publishResult.status);

    const publishedCheck = await checkRepetition(agent.agentId, { title: CANDIDATE.title });
    check('checkRepetition blocks an already-published topic',
      publishedCheck.status === REPETITION_STATUS.BLOCKED
      && publishedCheck.reason === REPETITION_REASON.ALREADY_PUBLISHED, `${publishedCheck.status}/${publishedCheck.reason}`);

    // 12. No credential anywhere in what this script produced.
    const serialized = JSON.stringify({ recent, view, exact, similar, publishResult: publishResult.status });
    check('nothing in the output carries a connection string or key',
      !/mongodb(\+srv)?:\/\//.test(serialized) && !/AIza[0-9A-Za-z._-]{10,}/.test(serialized));
  } finally {
    // 13. Clean up ONLY this smoke agent's records. Never a broad delete.
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
  console.error('\nMEMORY SMOKE CHECK FAILED:', err?.code || err?.name || 'error');
  process.exitCode = 1;
});
