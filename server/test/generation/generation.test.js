import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePost } from '../../src/services/generation/index.js';
import { GENERATION_ERROR_CODES, GenerationInputError } from '../../src/services/generation/errors.js';
import { createMockProvider } from '../../src/services/llm/mockProvider.js';
import { UsageTracker } from '../../src/services/llm/usage.js';
import {
  PERSONA,
  CANDIDATE,
  publishDecisionResult,
  skipDecisionResult,
  validGeneration,
  oversizedText,
} from '../fixtures/generation.js';

/**
 * The generator's behaviour end to end, driven through the mock provider so
 * every case runs offline with no key. Two invariants dominate: the editorial
 * gate (a non-publish decision costs zero calls) and fail-closed (every failure
 * is a named result with no post attached, never a repaired post).
 */

/** A provider that records calls and returns exactly the scripted entry each time. */
const scripted = (entry, options = {}) =>
  createMockProvider({ script: entry, usage: new UsageTracker(), ...options });

const run = (decision, provider, options = {}) =>
  generatePost(decision, { persona: PERSONA, provider, ...options });

// --- The editorial gate (§8) ------------------------------------------------

test('generate: a skip decision returns SKIP with zero generation calls', async () => {
  const provider = scripted({ json: validGeneration() });
  const result = await run(skipDecisionResult(), provider);

  assert.equal(result.status, 'skipped');
  assert.equal(result.ok, false);
  assert.equal(result.code, GENERATION_ERROR_CODES.NOT_ALLOWED);
  assert.equal(result.post, null);
  assert.equal(result.llmCalls, 0);
  assert.equal(provider.calls.length, 0, 'the model must not be called for a skip');
});

test('generate: any non-publish decision is a zero-call skip', async () => {
  for (const decision of ['skip', 'defer', 'hold', 'unknown']) {
    const provider = scripted({ json: validGeneration() });
    const result = await run({ ...skipDecisionResult(), decision }, provider);
    assert.equal(result.status, 'skipped', decision);
    assert.equal(provider.calls.length, 0, decision);
  }
});

// --- The happy path (§8, §17) ----------------------------------------------

test('generate: a publish decision makes exactly one call and returns a FinalPost', async () => {
  const provider = scripted({ json: validGeneration() });
  const result = await run(publishDecisionResult(), provider);

  assert.equal(result.status, 'generated');
  assert.equal(result.ok, true);
  assert.equal(result.code, null);
  assert.equal(result.llmCalls, 1);
  assert.equal(provider.calls.length, 1, 'exactly one generation call');

  const { post } = result;
  assert.equal(post.platform, 'linkedin');
  assert.equal(post.characterCount, post.text.length);
  assert.deepEqual(post.sourceUrls, [CANDIDATE.url]);
  assert.ok(post.hashtags.length <= 5);
});

test('generate: the result echoes the editorial decision it wrote from', async () => {
  const decision = publishDecisionResult();
  const result = await run(decision, scripted({ json: validGeneration() }));
  assert.equal(result.editorial.decision, 'publish');
  assert.equal(result.editorial.angle, decision.angle);
  assert.equal(result.editorial.confidence, decision.confidence);
  assert.equal(result.editorial.source, decision.source);
});

test('generate: the default mock (no script) writes a valid post on zero quota', async () => {
  // This is the demo path: LLM_PROVIDER=mock with nothing scripted must still
  // produce a publishable post via the fallback script.
  const provider = createMockProvider({ usage: new UsageTracker() });
  const result = await run(publishDecisionResult(), provider);
  assert.equal(result.status, 'generated');
  assert.equal(result.post.characterCount, result.post.text.length);
  assert.deepEqual(result.post.sourceUrls, [CANDIDATE.url]);
});

test('generate: platform is configurable and drives the limits', async () => {
  const provider = createMockProvider({ usage: new UsageTracker() });
  const result = await run(publishDecisionResult(), provider, { platform: 'twitter' });
  assert.equal(result.status, 'generated');
  assert.equal(result.platform, 'twitter');
  assert.ok(result.post.text.length <= 280);
  assert.ok(result.post.hashtags.length <= 3);
});

// --- Fail-closed: the scripted failure taxonomy (§12, §13) ------------------

test('generate: malformed JSON fails as generation_invalid_json', async () => {
  const result = await run(publishDecisionResult(), scripted({ raw: '{ not valid json' }));
  assert.equal(result.status, 'failed');
  assert.equal(result.code, GENERATION_ERROR_CODES.INVALID_JSON);
  assert.equal(result.post, null);
});

test('generate: a schema-invalid response (extra field) fails as generation_schema_invalid', async () => {
  const result = await run(
    publishDecisionResult(),
    scripted({ json: { ...validGeneration(), sponsored: true } })
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.code, GENERATION_ERROR_CODES.SCHEMA_INVALID);
});

test('generate: a fabricated source fails as generation_invalid_source', async () => {
  const result = await run(
    publishDecisionResult(),
    scripted({ json: validGeneration({ overrides: { sourceUrls: ['https://evil.example.com/x'] } }) })
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.code, GENERATION_ERROR_CODES.INVALID_SOURCE);
  assert.equal(result.post, null);
});

test('generate: an over-limit post fails as generation_too_long', async () => {
  const result = await run(
    publishDecisionResult(),
    scripted({ json: validGeneration({ overrides: { text: oversizedText(3200) } }) })
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.code, GENERATION_ERROR_CODES.TOO_LONG);
});

test('generate: an empty post fails as generation_verification_failed', async () => {
  const result = await run(
    publishDecisionResult(),
    scripted({ json: validGeneration({ overrides: { text: '   ' } }) })
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.code, GENERATION_ERROR_CODES.VERIFICATION_FAILED);
});

test('generate: an invalid hashtag fails as generation_verification_failed', async () => {
  const result = await run(
    publishDecisionResult(),
    scripted({ json: validGeneration({ overrides: { hashtags: ['not a tag'] } }) })
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.code, GENERATION_ERROR_CODES.VERIFICATION_FAILED);
});

test('generate: a provider timeout maps to generation_timeout', async () => {
  const result = await run(publishDecisionResult(), scripted({ error: 'timeout' }, { retries: 0 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.code, GENERATION_ERROR_CODES.TIMEOUT);
});

test('generate: a rate limit maps to generation_rate_limited', async () => {
  const result = await run(publishDecisionResult(), scripted({ error: 'rate_limited' }, { retries: 0 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.code, GENERATION_ERROR_CODES.RATE_LIMITED);
});

test('generate: a provider failure still counts as exactly one generation call', async () => {
  const provider = scripted({ error: 'provider_error' }, { retries: 0 });
  const result = await run(publishDecisionResult(), provider);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, GENERATION_ERROR_CODES.FAILED);
  assert.equal(result.llmCalls, 1, 'the attempt counts as one call even when it fails');
});

// --- Caller-error boundary (§16-style input validation) ---------------------

test('generate: a malformed decision object is a thrown caller error, not a result', async () => {
  await assert.rejects(
    () => generatePost(null, { persona: PERSONA, provider: scripted({ json: validGeneration() }) }),
    (err) => err instanceof GenerationInputError && err.code === 'invalid_editorial_decision'
  );
  await assert.rejects(
    () => generatePost({}, { persona: PERSONA, provider: scripted({ json: validGeneration() }) }),
    (err) => err instanceof GenerationInputError
  );
});

test('generate: a publish decision without a usable candidate is a thrown caller error', async () => {
  await assert.rejects(
    () => run(publishDecisionResult({ candidate: null }), scripted({ json: validGeneration() })),
    (err) => err instanceof GenerationInputError && err.code === 'invalid_candidate'
  );
  await assert.rejects(
    () => run(publishDecisionResult({ candidate: { title: 'no url here' } }), scripted({ json: validGeneration() })),
    (err) => err instanceof GenerationInputError && err.code === 'invalid_candidate'
  );
});

test('generate: an unknown platform is a thrown caller error', async () => {
  await assert.rejects(
    () => run(publishDecisionResult(), scripted({ json: validGeneration() }), { platform: 'myspace' }),
    (err) => err instanceof GenerationInputError && err.code === 'unsupported_platform'
  );
});

// --- Provenance and cost accounting (§17) -----------------------------------

test('generate: provenance carries provider, model, usage and duration', async () => {
  const usage = new UsageTracker();
  const provider = createMockProvider({ script: { json: validGeneration() }, usage });
  const result = await run(publishDecisionResult(), provider);

  assert.equal(result.provider, 'mock');
  assert.equal(result.model, 'mock-1');
  assert.ok(result.usage && typeof result.usage.calls === 'number');
  assert.equal(typeof result.durationMs, 'number');
  assert.equal(typeof result.generatedAt, 'string');
  assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('generate: a retried transport attempt stays one generation call but shows the extra attempt', async () => {
  // First attempt rate-limited, second succeeds: one generation call, two attempts.
  const usage = new UsageTracker();
  const provider = createMockProvider({
    script: [{ error: 'rate_limited' }, { json: validGeneration() }],
    usage,
    retries: 1,
  });
  const result = await run(publishDecisionResult(), provider);
  assert.equal(result.status, 'generated');
  assert.equal(result.llmCalls, 1, 'still one editorial-level call');
  assert.equal(result.llmAttempts, 2, 'but two transport attempts');
});

// --- End-to-end: real editorial decision -> generator (§18) -----------------

test('generate: end to end from a real editorial decision produces a verified FinalPost', async () => {
  const { evaluateCandidates } = await import('../../src/services/editorial/index.js');
  const { STRONG, PROMOTIONAL } = await import('../fixtures/editorial.js');

  // Phase 9: a real editorial decision from the mock, no key.
  const decision = await evaluateCandidates([STRONG, PROMOTIONAL], {
    persona: PERSONA,
    provider: createMockProvider({ usage: new UsageTracker() }),
    minConfidence: 0,
  });
  assert.equal(decision.decision, 'publish', 'the strong candidate should be selected');

  // Phase 10: the generator writes from that decision.
  const result = await generatePost(decision, {
    persona: PERSONA,
    provider: createMockProvider({ usage: new UsageTracker() }),
  });

  assert.equal(result.status, 'generated');
  const { post } = result;
  // Every field of the FinalPost contract, verified against the real candidate.
  assert.equal(typeof post.text, 'string');
  assert.ok(post.text.length > 0 && post.text.length <= 3000);
  assert.equal(typeof post.hook, 'string');
  assert.ok(post.hook.length > 0);
  assert.ok(Array.isArray(post.hashtags) && post.hashtags.length <= 5);
  assert.equal(post.characterCount, post.text.length);
  assert.equal(post.platform, 'linkedin');
  // The one source must be the selected candidate's own URL.
  assert.deepEqual(post.sourceUrls, [decision.candidate.url]);
});
