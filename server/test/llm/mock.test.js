import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockProvider } from '../../src/services/llm/mockProvider.js';
import { createLlmProvider, checkLlmReadiness } from '../../src/services/llm/index.js';
import { UsageTracker } from '../../src/services/llm/usage.js';
import { DECISION_SCHEMA, VALID_DECISION } from '../fixtures/llm.js';

const build = (options = {}) => createMockProvider({ usage: new UsageTracker(), ...options });

test('mock: needs no API key and reports itself configured', async () => {
  const provider = createLlmProvider({ provider: 'mock', apiKey: '' });
  assert.equal(provider.name, 'mock');
  assert.equal(provider.isConfigured, true);

  const { data } = await provider.generateJSON('anything', { schema: DECISION_SCHEMA });
  assert.equal(typeof data.selectedId, 'number');

  assert.deepEqual(checkLlmReadiness({ llm: { provider: 'mock', apiKey: '', model: '' } }),
    { ok: true, provider: 'mock', model: 'mock-1' });
});

test('mock: makes zero external network calls', async () => {
  // Replace fetch outright: anything reaching the network fails the test rather
  // than quietly succeeding on a machine that happens to be online.
  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (...args) => { attempts += 1; return realFetch(...args); };

  try {
    const provider = build();
    await provider.generateJSON('choose a topic', { schema: DECISION_SCHEMA });
    await provider.generateText('write something');
    assert.equal(attempts, 0, 'the mock provider touched the network');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('mock: output is deterministic for the same prompt and schema', async () => {
  const first = await build().generateJSON('identical prompt', { schema: DECISION_SCHEMA });
  const second = await build().generateJSON('identical prompt', { schema: DECISION_SCHEMA });
  assert.deepEqual(first.data, second.data);

  const different = await build().generateJSON('a different prompt', { schema: DECISION_SCHEMA });
  assert.notDeepEqual(first.data, different.data, 'different prompts should not collapse to one answer');
});

test('mock: synthesized output satisfies the requested schema', async () => {
  const schema = {
    type: 'object',
    required: ['headline', 'body', 'score', 'topics', 'publish'],
    additionalProperties: false,
    properties: {
      headline: { type: 'string', minLength: 10, maxLength: 120 },
      body: { type: 'string', minLength: 80 },
      score: { type: 'number', minimum: 0, maximum: 1 },
      topics: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } },
      publish: { type: 'boolean' },
      verdict: { type: 'string', enum: ['publish', 'skip'] },
    },
  };

  // Validation runs inside generateJSON, so returning at all proves conformance.
  const { data } = await build().generateJSON('demo prompt', { schema });
  assert.ok(data.headline.length >= 10 && data.headline.length <= 120);
  assert.ok(data.body.length >= 80);
  assert.ok(data.score >= 0 && data.score <= 1);
  assert.equal(data.topics.length, 2);
  assert.ok(['publish', 'skip'].includes(data.verdict));
});

test('mock: demo output echoes a real candidate title so a demo reads as real work', async () => {
  const prompt = `Candidates: ${JSON.stringify([
    { id: 1, title: 'Indirect prompt injection exfiltrates data from agent tool calls' },
  ])}`;
  const schema = {
    type: 'object', required: ['topic'], properties: { topic: { type: 'string' } },
  };

  const { data } = await build().generateJSON(prompt, { schema });
  assert.equal(data.topic, 'Indirect prompt injection exfiltrates data from agent tool calls');
});

test('mock: a scripted malformed response fails exactly like the real provider', async () => {
  const provider = build({ script: [{ raw: '{"selectedId": 2, "ration' }] });
  await assert.rejects(() => provider.generateJSON('x', { schema: DECISION_SCHEMA }),
    (err) => err.code === 'invalid_response');
});

test('mock: a scripted empty response is classified as empty_response', async () => {
  const provider = build({ script: [{ raw: '' }] });
  await assert.rejects(() => provider.generateJSON('x', { schema: DECISION_SCHEMA }),
    (err) => err.code === 'empty_response');
});

test('mock: scripted output that violates the schema is rejected, not accepted', async () => {
  const provider = build({ script: [{ json: { selectedId: 42, publish: 'sure' } }] });
  await assert.rejects(() => provider.generateJSON('x', { schema: DECISION_SCHEMA }), (err) => {
    assert.equal(err.code, 'schema_invalid');
    return true;
  });
});

test('mock: scripted failures reproduce every provider error code', async () => {
  for (const code of ['timeout', 'rate_limited', 'provider_error', 'content_blocked', 'network_error']) {
    const provider = build({ script: [{ error: code }], retries: 0 });
    await assert.rejects(() => provider.generateText('x'), (err) => {
      assert.equal(err.code, code);
      assert.equal(err.name, 'LlmError');
      return true;
    });
  }
});

test('mock: retry behaviour matches the shared policy', async () => {
  // Retryable then success: the call recovers.
  const recovering = build({ script: [{ error: 'rate_limited' }, { json: VALID_DECISION }] });
  const { data } = await recovering.generateJSON('x', { schema: DECISION_SCHEMA });
  assert.deepEqual(data, VALID_DECISION);
  assert.equal(recovering.calls.length, 1, 'one logical call');
  assert.equal(recovering.usage.snapshot().calls, 2, 'two attempts accounted for');

  // Non-retryable: no second attempt.
  const fatal = build({ script: [{ error: 'content_blocked' }, { json: VALID_DECISION }] });
  await assert.rejects(() => fatal.generateText('x'), (err) => err.code === 'content_blocked');
  assert.equal(fatal.usage.snapshot().calls, 1, 'a blocked prompt is not retried');

  // Budget is respected.
  const exhausted = build({ script: [{ error: 'timeout' }], retries: 3 });
  await assert.rejects(() => exhausted.generateText('x'), (err) => err.code === 'timeout');
  assert.equal(exhausted.usage.snapshot().calls, 4, 'initial attempt plus three retries');
});

test('mock: a script function can branch on the prompt', async () => {
  const provider = build({
    script: (prompt) => (prompt.includes('fail') ? { error: 'provider_error' } : { text: 'ok' }),
    retries: 0,
  });

  assert.equal((await provider.generateText('all good')).text, 'ok');
  await assert.rejects(() => provider.generateText('please fail'), (err) => err.code === 'provider_error');
});

test('mock: calls are recorded for assertions', async () => {
  const provider = build();
  await provider.generateJSON('first prompt', { schema: DECISION_SCHEMA });
  await provider.generateText('second prompt');

  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0].prompt, 'first prompt');
  assert.equal(provider.calls[1].prompt, 'second prompt');

  provider.reset();
  assert.equal(provider.calls.length, 0);
});

test('mock: token and call counting increments correctly', async () => {
  const usage = new UsageTracker();
  const provider = createMockProvider({ usage });

  assert.deepEqual(usage.snapshot().calls, 0);

  await provider.generateText('a prompt with a handful of words in it');
  const afterOne = usage.snapshot();
  assert.equal(afterOne.calls, 1);
  assert.equal(afterOne.successful, 1);
  assert.equal(afterOne.failed, 0);
  assert.ok(afterOne.inputTokens > 0);
  assert.ok(afterOne.outputTokens > 0);
  assert.equal(afterOne.totalTokens, afterOne.inputTokens + afterOne.outputTokens);
  assert.equal(afterOne.tokensAreEstimated, true);
  assert.ok(afterOne.lastCallAt);

  await provider.generateJSON('another prompt', { schema: DECISION_SCHEMA });
  const afterTwo = usage.snapshot();
  assert.equal(afterTwo.calls, 2);
  assert.ok(afterTwo.totalTokens > afterOne.totalTokens, 'tokens accumulate across calls');
  assert.deepEqual(afterTwo.byProvider, { mock: 2 });
});

test('mock: an unsupported provider name is rejected', () => {
  assert.throws(() => createLlmProvider({ provider: 'gpt-9000' }), (err) => {
    assert.equal(err.code, 'not_configured');
    assert.match(err.message, /Supported: gemini, mock/);
    return true;
  });
});
