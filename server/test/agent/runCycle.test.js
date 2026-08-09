import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { Post, TopicMemory } from '../../src/models/index.js';
import { normalizeTopic } from '../../src/utils/text.js';
import { runCycle, OUTCOME } from '../../src/services/agent/runCycle.js';
import { createMockProvider } from '../../src/services/llm/mockProvider.js';
import { createGeminiProvider } from '../../src/services/llm/geminiProvider.js';
import { UsageTracker } from '../../src/services/llm/usage.js';
import {
  seedAgent, seedMemory, publishCandidate, CANDIDATE,
} from '../fixtures/memory.js';
import { publishDecision, skipDecision } from '../fixtures/editorial.js';
import { validGeneration } from '../fixtures/generation.js';

/**
 * Phase 12 — runCycle composition.
 *
 * These tests exercise the *real* Phase 11 memory gate, Phase 9 editorial call,
 * Phase 10 generation, and Phase 10B publisher against an in-memory MongoDB and
 * a scripted mock provider — the only injected seam is discovery, so the cycle's
 * candidate set is deterministic without a network or a live feed. What is under
 * test is runCycle's orchestration: the two-LLM-call budget, the gate that drops
 * BLOCKED topics before any call, the non-publish paths, and fail-safety.
 */

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

/** Override discovery so the cycle judges exactly these candidates. */
const withCandidates = (candidates) => ({ discoverTopics: async () => ({ candidates }) });

/** A fresh provider whose calls array is the LLM-budget probe. */
const scripted = (script) => createMockProvider({ script, usage: new UsageTracker() });

// --- The hard budget: a full publishing cycle costs exactly two calls ---------

test('a full cycle discovers, judges, generates, and publishes with exactly two LLM calls', async () => {
  const agent = await seedAgent();
  const provider = scripted([
    { json: publishDecision({ selectedCandidateIndex: 1 }) },
    { json: validGeneration() },
  ]);

  const result = await runCycle(agent, { provider, services: withCandidates([CANDIDATE]) });

  assert.equal(result.outcome, OUTCOME.PUBLISHED);
  assert.equal(result.failed, false);
  assert.equal(provider.calls.length, 2, 'editorial + generation, and nothing more');
  assert.equal(result.providerCalls, 2);
  assert.equal(result.stats.llmCalls, 2);
  assert.equal(result.stats.postsPublished, 1);

  // Exactly one Post reached the feed, and it is the candidate we discovered.
  const posts = await Post.find({ agentId: agent.agentId });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].normalizedTopic, normalizeTopic(CANDIDATE.title));
  assert.ok(result.publisher.created);
});

// --- Zero-call floor: an all-BLOCKED cycle never touches the model ------------

test('a BLOCKED candidate is dropped before the editorial call — zero LLM calls', async () => {
  const agent = await seedAgent();
  // Publish the topic first so the memory gate reports it as already_published.
  await publishCandidate(agent.agentId);
  const provider = scripted([{ json: publishDecision() }, { json: validGeneration() }]);

  const result = await runCycle(agent, { provider, services: withCandidates([CANDIDATE]) });

  assert.equal(result.outcome, OUTCOME.IDLE);
  assert.equal(result.failed, false);
  assert.equal(provider.calls.length, 0, 'a blocked cycle must not spend a token');
  assert.equal(result.stats.llmCalls, 0);
  assert.equal(result.stats.topicsRejected, 1);
  assert.equal(result.stats.postsPublished, 0);

  // No *new* post: only the one we seeded to create the block remains.
  assert.equal(await Post.countDocuments({ agentId: agent.agentId }), 1);
});

// --- DISCOURAGED still gets judged (Phase 11 contract: discouraged ≠ blocked) --

test('a DISCOURAGED candidate stays viable and can still be published', async () => {
  const agent = await seedAgent();
  // A recent rejection of this topic makes the gate DISCOURAGED, not BLOCKED.
  await seedMemory(agent.agentId, { topic: CANDIDATE.title, decision: 'rejected', ageDays: 2 });
  const provider = scripted([
    { json: publishDecision({ selectedCandidateIndex: 1 }) },
    { json: validGeneration() },
  ]);

  const result = await runCycle(agent, { provider, services: withCandidates([CANDIDATE]) });

  assert.equal(result.outcome, OUTCOME.PUBLISHED, 'discouraged is a soft signal, not a veto');
  assert.equal(provider.calls.length, 2);
  assert.equal(await Post.countDocuments({ agentId: agent.agentId }), 1);
});

// --- Non-publish: the editor declines, so generation never runs ---------------

test('an editorial skip publishes nothing, calls the model once, and records the deferral', async () => {
  const agent = await seedAgent();
  const provider = scripted([{ json: skipDecision() }, { json: validGeneration() }]);

  const result = await runCycle(agent, { provider, services: withCandidates([CANDIDATE]) });

  assert.equal(result.outcome, OUTCOME.IDLE);
  assert.equal(result.failed, false);
  assert.equal(provider.calls.length, 1, 'editorial ran; generation must not');
  assert.equal(result.stats.postsPublished, 0);
  assert.equal(await Post.countDocuments({ agentId: agent.agentId }), 0);

  // The topic we nearly published is written as a `deferred` audit row, so the
  // next cycle's gate discourages re-judging it.
  const deferred = await TopicMemory.findOne({ agentId: agent.agentId, decision: 'deferred' });
  assert.ok(deferred, 'a deferred memory row should be recorded on a skip');
  assert.equal(deferred.normalizedTopic, normalizeTopic(CANDIDATE.title));
  assert.ok(result.memory);
});

// --- Fail-safety: a generation failure is a returned failure, never a throw ---

test('a generation failure fails the cycle safely without publishing', async () => {
  const agent = await seedAgent();
  // Editorial succeeds; the generation call errors. retries:0 keeps it to one attempt.
  const provider = createMockProvider({
    script: [{ json: publishDecision({ selectedCandidateIndex: 1 }) }, { error: 'rate_limited' }],
    usage: new UsageTracker(),
    retries: 0,
  });

  const result = await runCycle(agent, { provider, services: withCandidates([CANDIDATE]) });

  assert.equal(result.failed, true, 'the worker must see this as a backoff signal');
  assert.equal(result.outcome, OUTCOME.FAILED);
  assert.equal(provider.calls.length, 2, 'editorial + one failed generation attempt');
  assert.equal(await Post.countDocuments({ agentId: agent.agentId }), 0);
  assert.ok(result.errors.some((e) => e.stage === 'generation'));
});

// --- Fail-safety: a throwing publisher is caught and surfaced as failed -------

test('a publisher that throws fails the cycle safely without crashing runCycle', async () => {
  const agent = await seedAgent();
  const provider = scripted([
    { json: publishDecision({ selectedCandidateIndex: 1 }) },
    { json: validGeneration() },
  ]);

  const result = await runCycle(agent, {
    provider,
    services: {
      ...withCandidates([CANDIDATE]),
      publishFinalPost: async () => { throw new Error('publish boom'); },
    },
  });

  assert.equal(result.failed, true);
  assert.equal(result.outcome, OUTCOME.FAILED);
  assert.equal(provider.calls.length, 2, 'the failure is downstream of both calls');
  assert.equal(await Post.countDocuments({ agentId: agent.agentId }), 0);
  assert.ok(result.errors.some((e) => e.stage === 'publish'));
});

// --- An inactive agent is a no-op, with no discovery and no calls -------------

test('a paused agent runs no cycle and spends nothing', async () => {
  const agent = await seedAgent({ status: 'paused' });
  const provider = scripted([{ json: publishDecision() }, { json: validGeneration() }]);
  let discovered = false;

  const result = await runCycle(agent, {
    provider,
    services: { discoverTopics: async () => { discovered = true; return { candidates: [CANDIDATE] }; } },
  });

  assert.equal(result.outcome, OUTCOME.PAUSED);
  assert.equal(discovered, false, 'a paused agent should not even discover');
  assert.equal(provider.calls.length, 0);
});

// --- A caller bug (no agent) throws, rather than degrading into a quiet skip ---

test('runCycle throws CycleInputError when handed no agent', async () => {
  await assert.rejects(
    () => runCycle(null, { provider: scripted([{ json: skipDecision() }]) }),
    /agentId/
  );
});

// --- stats.llmCalls against a provider with no `.calls` array -----------------
//
// The dashboard metric used to be read off `provider.calls.length`, which only
// the mock has. Against real Gemini it was `undefined`, so every production
// cycle reported zero LLM calls while the editorial call was demonstrably
// happening. These cases drive the *real* Gemini provider — its own code path,
// its own retry loop, its own usage tracker — with a stubbed fetch, so nothing
// touches the network or spends quota.

/** A Gemini provider whose HTTP layer is a scripted array of fake responses. */
function fakeGemini(responses, overrides = {}) {
  const attempts = [];
  let cursor = 0;
  const provider = createGeminiProvider({
    apiKey: 'test-key-not-a-real-credential',
    model: 'gemini-3.6-flash',
    usage: new UsageTracker(),
    // No real backoff: the retry path is under test, the wall clock is not.
    sleep: () => Promise.resolve(),
    fetchImpl: async (url, init) => {
      attempts.push({ url, body: JSON.parse(init.body) });
      const next = responses[Math.min(cursor, responses.length - 1)];
      cursor += 1;
      if (next.status && next.status >= 400) {
        return { ok: false, status: next.status, text: async () => next.body ?? '{}' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(next.json) }] } }],
        }),
      };
    },
    ...overrides,
  });
  provider.attempts = attempts;
  return provider;
}

test('stats.llmCalls counts a real provider cycle that has no `.calls` array', async () => {
  const agent = await seedAgent();
  const provider = fakeGemini([
    { json: publishDecision({ selectedCandidateIndex: 1 }) },
    { json: validGeneration() },
  ]);
  assert.equal(provider.calls, undefined, 'the real provider exposes no test seam — that is the bug');

  const result = await runCycle(agent, { provider, services: withCandidates([CANDIDATE]) });

  assert.equal(result.outcome, OUTCOME.PUBLISHED);
  assert.equal(provider.attempts.length, 2, 'editorial + generation, over the wire');
  assert.equal(result.stats.llmCalls, 2, 'the dashboard metric must not read zero here');
  assert.equal(result.providerCalls, 2);
});

test('stats.llmCalls counts a retried 429 as ONE logical call, not two attempts', async () => {
  const agent = await seedAgent();
  // The editorial call is rate-limited once, then succeeds on the retry; the
  // generation call goes through first time. Three HTTP attempts, two calls.
  const provider = fakeGemini([
    { status: 429, body: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' },
    { json: publishDecision({ selectedCandidateIndex: 1 }) },
    { json: validGeneration() },
  ]);

  const result = await runCycle(agent, { provider, services: withCandidates([CANDIDATE]) });

  assert.equal(result.outcome, OUTCOME.PUBLISHED);
  assert.equal(provider.attempts.length, 3, 'one retry actually happened');
  assert.equal(provider.usage.snapshot().calls, 3, 'usage counts transport attempts');
  // The metric is logical calls — "how many times did the agent decide to
  // consult the model" — which is what the two-per-cycle budget means.
  assert.equal(result.stats.llmCalls, 2, 'a retry must not inflate the metric');
  assert.equal(result.editorial.llmCalls, 1);
  assert.equal(result.editorial.llmAttempts, 2, 'attempts stay separately visible');
});

test('stats.llmCalls records the one spent call when a real 429 exhausts its retry', async () => {
  const agent = await seedAgent();
  // Every attempt is rate-limited: the editorial layer converts that into a
  // skip-shaped decision, so the cycle is idle rather than failed — but the call
  // was still made and paid for, and the metric has to say so.
  const provider = fakeGemini([{ status: 429, body: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' }]);

  const result = await runCycle(agent, { provider, services: withCandidates([CANDIDATE]) });

  assert.equal(result.outcome, OUTCOME.IDLE);
  assert.equal(result.failed, false, 'a spent quota degrades the cycle, it does not fail it');
  assert.equal(provider.attempts.length, 2, 'the initial attempt plus its one retry');
  assert.equal(result.stats.llmCalls, 1, 'one logical editorial call was spent');
  assert.equal(result.stats.postsPublished, 0);
});

test('stats.llmCalls stays 0 for a real-provider cycle that never reaches the model', async () => {
  const agent = await seedAgent();
  await publishCandidate(agent.agentId);
  const provider = fakeGemini([{ json: publishDecision() }]);

  const result = await runCycle(agent, { provider, services: withCandidates([CANDIDATE]) });

  assert.equal(result.outcome, OUTCOME.IDLE);
  assert.equal(provider.attempts.length, 0, 'a blocked cycle must not spend a token');
  assert.equal(result.stats.llmCalls, 0);
});
