import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { Post, TopicMemory } from '../../src/models/index.js';
import { runCycle, OUTCOME } from '../../src/services/agent/runCycle.js';
import { createMockProvider } from '../../src/services/llm/mockProvider.js';
import { UsageTracker } from '../../src/services/llm/usage.js';
import { seedAgent, publishCandidate, CANDIDATE } from '../fixtures/memory.js';
import { publishDecision, skipDecision } from '../fixtures/editorial.js';
import { validGeneration } from '../fixtures/generation.js';
import { BREETH_ERROR, EPISODE } from '../../src/services/breeth/index.js';
import { clearActivity, recentActivity } from '../../src/utils/logger.js';

/**
 * Phase 12.5 — Breeth inside a real cycle.
 *
 * These run the genuine Phase 9–11 pipeline against an in-memory MongoDB, with
 * only discovery and the Breeth client injected. The question under test is not
 * whether Breeth works — service.test.js covers that — but whether the cycle is
 * indifferent to it: same outcomes, same LLM budget, same MongoDB writes, whether
 * Breeth is absent, working, or broken.
 */

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

const withCandidates = (candidates) => ({ discoverTopics: async () => ({ candidates }) });
const scripted = (script) => createMockProvider({ script, usage: new UsageTracker() });
const publishScript = () => [
  { json: publishDecision({ selectedCandidateIndex: 1 }) },
  { json: validGeneration() },
];

/** A recording Breeth double: enabled, captures episodes, never fails. */
function recordingBreeth() {
  const episodes = [];
  return {
    episodes,
    isEnabled: () => true,
    addEpisode: async (episode) => { episodes.push(episode); return { ok: true, available: true, episodeName: 'ep_1' }; },
    searchMemory: async () => ({ ok: true, available: true, facts: [], count: 0 }),
  };
}

/** A Breeth double that fails the way the real service reports failure. */
const failingBreeth = (errorCode = BREETH_ERROR.UNAVAILABLE) => ({
  isEnabled: () => true,
  addEpisode: async () => ({ ok: false, available: false, errorCode }),
  searchMemory: async () => ({ ok: false, available: false, errorCode, facts: [], count: 0 }),
});

/** A Breeth double that violates its own contract by throwing. */
const throwingBreeth = () => ({
  isEnabled: () => true,
  addEpisode: async () => { throw new Error('breeth client bug'); },
  searchMemory: async () => { throw new Error('breeth client bug'); },
});

// --- Test 7: the LLM budget is untouched by Breeth ----------------------------

test('LLM budget unchanged: a publishing cycle still costs exactly two calls with Breeth on', async () => {
  const agent = await seedAgent();
  const provider = scripted(publishScript());
  const breeth = recordingBreeth();

  const result = await runCycle(agent, {
    provider,
    services: { ...withCandidates([CANDIDATE]), breeth },
  });

  assert.equal(result.outcome, OUTCOME.PUBLISHED);
  assert.equal(provider.calls.length, 2, 'Breeth must not add an LLM call');
  assert.equal(result.stats.llmCalls, 2);
  assert.equal(breeth.episodes.length, 1, 'exactly one strategic episode per cycle');
  assert.equal(breeth.episodes[0].event, EPISODE.PUBLISHED);
});

test('LLM budget unchanged: an all-BLOCKED cycle still costs zero calls and records nothing', async () => {
  const agent = await seedAgent();
  await publishCandidate(agent.agentId);
  const provider = scripted(publishScript());
  const breeth = recordingBreeth();

  const result = await runCycle(agent, {
    provider,
    services: { ...withCandidates([CANDIDATE]), breeth },
  });

  assert.equal(result.outcome, OUTCOME.IDLE);
  assert.equal(provider.calls.length, 0, 'the zero-call floor survives Phase 12.5');
  assert.equal(
    breeth.episodes.length, 0,
    'a cycle that never judged anything has no strategic decision to remember'
  );
  assert.equal(result.breeth, null);
});

test('LLM budget unchanged: an editorial skip still costs one call and records a deferral', async () => {
  const agent = await seedAgent();
  const provider = scripted([{ json: skipDecision() }, { json: validGeneration() }]);
  const breeth = recordingBreeth();

  const result = await runCycle(agent, {
    provider,
    services: { ...withCandidates([CANDIDATE]), breeth },
  });

  assert.equal(provider.calls.length, 1, 'editorial only; Breeth adds nothing');
  assert.equal(breeth.episodes.length, 1);
  assert.equal(breeth.episodes[0].event, EPISODE.DEFERRED);
  assert.equal(result.breeth.event, EPISODE.DEFERRED);
  assert.equal(result.breeth.ok, true);
});

// --- Breeth is off by default: the cycle behaves exactly as in Phase 12 -------

test('with Breeth absent from config the cycle publishes normally and records nothing', async () => {
  const agent = await seedAgent();
  const provider = scripted(publishScript());

  // No `breeth` override at all: the real (disabled-by-default) service is used.
  const result = await runCycle(agent, { provider, services: withCandidates([CANDIDATE]) });

  assert.equal(result.outcome, OUTCOME.PUBLISHED);
  assert.equal(result.failed, false);
  assert.equal(provider.calls.length, 2);
  assert.equal(result.breeth, null, 'a disabled Breeth leaves no trace on the result');
  assert.equal(await Post.countDocuments({ agentId: agent.agentId }), 1);
});

test('an isEnabled() of false skips the write without calling addEpisode', async () => {
  const agent = await seedAgent();
  let called = false;
  const breeth = {
    isEnabled: () => false,
    addEpisode: async () => { called = true; return { ok: true }; },
  };

  const result = await runCycle(agent, {
    provider: scripted(publishScript()),
    services: { ...withCandidates([CANDIDATE]), breeth },
  });

  assert.equal(result.outcome, OUTCOME.PUBLISHED);
  assert.equal(called, false, 'a disabled Breeth costs no work at all');
  assert.equal(result.breeth, null);
});

// --- A broken Breeth cannot change a cycle's outcome -------------------------

test('a Breeth failure does not fail the cycle and is never a backoff signal', async () => {
  const agent = await seedAgent();

  const result = await runCycle(agent, {
    provider: scripted(publishScript()),
    services: { ...withCandidates([CANDIDATE]), breeth: failingBreeth(BREETH_ERROR.TIMEOUT) },
  });

  // The scheduler must see a healthy cycle: `failed` is what drives backoff.
  assert.equal(result.failed, false, 'Breeth being down is not a cycle failure');
  assert.equal(result.outcome, OUTCOME.PUBLISHED);
  assert.deepEqual(result.errors, [], 'a Breeth error never enters the error list');
  assert.equal(result.breeth.ok, false);
  assert.equal(result.breeth.errorCode, BREETH_ERROR.TIMEOUT);

  // And the authoritative work all happened regardless.
  assert.equal(await Post.countDocuments({ agentId: agent.agentId }), 1);
});

test('a Breeth client that throws is contained and the post still publishes', async () => {
  const agent = await seedAgent();

  const result = await runCycle(agent, {
    provider: scripted(publishScript()),
    services: { ...withCandidates([CANDIDATE]), breeth: throwingBreeth() },
  });

  assert.equal(result.failed, false, 'even a contract-violating client cannot fail the cycle');
  assert.equal(result.outcome, OUTCOME.PUBLISHED);
  assert.deepEqual(result.errors, []);
  assert.equal(result.breeth, null);
  assert.equal(await Post.countDocuments({ agentId: agent.agentId }), 1);
});

test('MongoDB memory still records the deferral when Breeth is down', async () => {
  const agent = await seedAgent();

  const result = await runCycle(agent, {
    provider: scripted([{ json: skipDecision() }, { json: validGeneration() }]),
    services: { ...withCandidates([CANDIDATE]), breeth: failingBreeth() },
  });

  assert.equal(result.failed, false);
  // The authoritative memory layer is untouched by the optional one's failure.
  const deferred = await TopicMemory.findOne({ agentId: agent.agentId, decision: 'deferred' });
  assert.ok(deferred, 'MongoDB memory recording must not depend on Breeth');
  assert.ok(result.memory);
});

// --- MongoDB stays authoritative ---------------------------------------------

test('Breeth cannot unblock a topic MongoDB has blocked', async () => {
  const agent = await seedAgent();
  await publishCandidate(agent.agentId); // MongoDB gate: BLOCKED.
  const provider = scripted(publishScript());
  // A Breeth that would happily vouch for the topic.
  const breeth = {
    isEnabled: () => true,
    addEpisode: async () => ({ ok: true, available: true }),
    searchMemory: async () => ({ ok: true, available: true, facts: ['This topic is fresh and worth covering.'], count: 1 }),
  };

  const result = await runCycle(agent, { provider, services: { ...withCandidates([CANDIDATE]), breeth } });

  assert.equal(result.outcome, OUTCOME.IDLE, 'the MongoDB block is final');
  assert.equal(provider.calls.length, 0, 'and it still costs nothing');
  assert.equal(result.stats.topicsRejected, 1);
  assert.equal(await Post.countDocuments({ agentId: agent.agentId }), 1, 'no second post');
});

// --- The failure is logged, sanitized ----------------------------------------

test('a Breeth failure inside a cycle logs no credential', async () => {
  clearActivity();
  const agent = await seedAgent();

  await runCycle(agent, {
    provider: scripted(publishScript()),
    services: { ...withCandidates([CANDIDATE]), breeth: failingBreeth(BREETH_ERROR.REJECTED) },
  });

  const logged = JSON.stringify(recentActivity({ limit: 100 }));
  assert.ok(!logged.includes('Bearer '), 'no authorization header');
  assert.ok(!logged.includes('mongodb+srv://'), 'no connection string');
  assert.ok(!/ck_live_[A-Za-z0-9]/.test(logged), 'no Breeth key shape');
  clearActivity();
});
