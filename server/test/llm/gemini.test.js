import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiProvider } from '../../src/services/llm/geminiProvider.js';
import { createLlmProvider, checkLlmReadiness } from '../../src/services/llm/index.js';
import { UsageTracker } from '../../src/services/llm/usage.js';
import {
  FAKE_API_KEY, DECISION_SCHEMA, VALID_DECISION, geminiResponse, fakeFetch, timeoutError,
} from '../fixtures/llm.js';

const build = (script, options = {}) => {
  const fetchImpl = fakeFetch(script);
  const usage = new UsageTracker();
  const provider = createGeminiProvider({
    apiKey: FAKE_API_KEY, model: 'gemini-2.5-flash', fetchImpl, usage,
    sleep: () => Promise.resolve(), ...options,
  });
  return { provider, fetchImpl, usage };
};

test('gemini: configuration produces a provider bound to the configured model', () => {
  const provider = createGeminiProvider({ apiKey: FAKE_API_KEY, model: 'gemini-2.5-pro' });
  assert.equal(provider.name, 'gemini');
  assert.equal(provider.model, 'gemini-2.5-pro');
  assert.equal(provider.isConfigured, true);
  assert.equal(typeof provider.generateText, 'function');
  assert.equal(typeof provider.generateJSON, 'function');
});

test('gemini: a missing key fails as not_configured before any network call', async () => {
  let called = false;
  const provider = createGeminiProvider({
    apiKey: '', fetchImpl: async () => { called = true; return new Response('{}'); },
  });

  assert.equal(provider.isConfigured, false);
  await assert.rejects(() => provider.generateText('hello'), (err) => {
    assert.equal(err.code, 'not_configured');
    assert.equal(err.retryable, false);
    assert.match(err.message, /LLM_API_KEY/);
    // The message must point at the fix, including the no-key escape hatch.
    assert.match(err.message, /LLM_PROVIDER=mock/);
    return true;
  });
  assert.equal(called, false, 'no request was attempted');
});

test('gemini: the factory can refuse to construct without credentials', () => {
  assert.throws(() => createLlmProvider({ provider: 'gemini', apiKey: '', requireCredentials: true }),
    (err) => err.code === 'not_configured');

  // Default is permissive so the app boots and reports readiness instead.
  const lazy = createLlmProvider({ provider: 'gemini', apiKey: '' });
  assert.equal(lazy.isConfigured, false);

  const readiness = checkLlmReadiness({ llm: { provider: 'gemini', apiKey: '', model: 'gemini-2.5-flash' } });
  assert.deepEqual(readiness, {
    ok: false, provider: 'gemini', model: 'gemini-2.5-flash', reason: 'LLM_API_KEY is not set',
  });
});

test('gemini: successful JSON generation returns validated data and reported usage', async () => {
  const { provider, fetchImpl, usage } = build({ json: geminiResponse(JSON.stringify(VALID_DECISION)) });

  const { data, usage: reported } = await provider.generateJSON('choose one', { schema: DECISION_SCHEMA });

  assert.deepEqual(data, VALID_DECISION);
  assert.equal(reported.inputTokens, 120, 'provider-reported counts win over estimates');
  assert.equal(reported.outputTokens, 45);
  assert.equal(usage.snapshot().successful, 1);

  const request = fetchImpl.requests[0];
  assert.match(request.url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(request.body.generationConfig.responseMimeType, 'application/json',
    'JSON mode is requested at the decoder, not just in the prompt');
});

test('gemini: markdown-fenced output is still parsed', async () => {
  const fenced = '```json\n' + JSON.stringify(VALID_DECISION) + '\n```';
  const { provider } = build({ json: geminiResponse(fenced) });
  const { data } = await provider.generateJSON('choose', { schema: DECISION_SCHEMA });
  assert.deepEqual(data, VALID_DECISION);
});

test('gemini: malformed JSON is not retried and never yields a partial object', async () => {
  const { provider, fetchImpl, usage } = build({ json: geminiResponse('{"selectedId": 2, "rationa') });

  await assert.rejects(() => provider.generateJSON('choose', { schema: DECISION_SCHEMA }), (err) => {
    assert.equal(err.code, 'invalid_response');
    return true;
  });
  assert.equal(fetchImpl.requests.length, 1, 'a malformed body is deterministic; retrying wastes a call');
  assert.equal(usage.snapshot().successful, 1, 'the HTTP call itself succeeded');
});

test('gemini: an empty completion is reported as empty_response', async () => {
  const { provider } = build({ json: geminiResponse('') });
  await assert.rejects(() => provider.generateText('hi'), (err) => err.code === 'empty_response');
});

test('gemini: schema violations surface as schema_invalid', async () => {
  const { provider } = build({ json: geminiResponse(JSON.stringify({ selectedId: 99, publish: 'maybe' })) });

  await assert.rejects(() => provider.generateJSON('choose', { schema: DECISION_SCHEMA }), (err) => {
    assert.equal(err.code, 'schema_invalid');
    assert.ok(err.details.some((d) => /above maximum/.test(d)));
    assert.ok(err.details.some((d) => /rationale/.test(d)));
    return true;
  });
});

test('gemini: a timeout is classified as timeout and retried once', async () => {
  const { provider, fetchImpl, usage } = build([timeoutError(), timeoutError()]);

  await assert.rejects(() => provider.generateText('hi'), (err) => {
    assert.equal(err.code, 'timeout');
    assert.equal(err.retryable, true);
    return true;
  });
  assert.equal(fetchImpl.requests.length, 2, 'one retry, then give up');
  assert.equal(usage.snapshot().failed, 2);
});

test('gemini: a rate limit is retried and can succeed on the second attempt', async () => {
  const { provider, fetchImpl, usage } = build([
    { status: 429, body: 'quota exceeded' },
    { json: geminiResponse(JSON.stringify(VALID_DECISION)) },
  ]);

  const { data } = await provider.generateJSON('choose', { schema: DECISION_SCHEMA });
  assert.deepEqual(data, VALID_DECISION);
  assert.equal(fetchImpl.requests.length, 2);

  const snapshot = usage.snapshot();
  assert.equal(snapshot.calls, 2, 'both attempts are accounted for');
  assert.equal(snapshot.successful, 1);
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.errorsByCode.rate_limited, 1);
});

test('gemini: a 400 is not retried, a 500 is', async () => {
  const bad = build([{ status: 400, body: 'bad request' }, { status: 400, body: 'bad request' }]);
  await assert.rejects(() => bad.provider.generateText('hi'), (err) => {
    assert.equal(err.code, 'bad_request');
    assert.equal(err.retryable, false);
    return true;
  });
  assert.equal(bad.fetchImpl.requests.length, 1, 'a rejected request fails identically on attempt two');

  const flaky = build([{ status: 503, body: 'unavailable' }, { json: geminiResponse('recovered') }]);
  const { text } = await flaky.provider.generateText('hi');
  assert.equal(text, 'recovered');
  assert.equal(flaky.fetchImpl.requests.length, 2);
});

test('gemini: a 403 points at credentials rather than looking like an outage', async () => {
  const { provider } = build({ status: 403, body: 'permission denied' });
  await assert.rejects(() => provider.generateText('hi'), (err) => err.code === 'not_configured');
});

test('gemini: retries are bounded by the configured budget', async () => {
  const { provider, fetchImpl } = build(
    [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }], { retries: 2 });

  await assert.rejects(() => provider.generateText('hi'), (err) => err.code === 'provider_error');
  assert.equal(fetchImpl.requests.length, 3, 'initial attempt plus two retries, and no more');
});

test('gemini: a blocked prompt is distinguished from an empty one', async () => {
  const blocked = build({ json: { promptFeedback: { blockReason: 'SAFETY' } } });
  await assert.rejects(() => blocked.provider.generateText('hi'), (err) => {
    assert.equal(err.code, 'content_blocked');
    assert.equal(err.retryable, false);
    return true;
  });

  const stopped = build({
    json: { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'RECITATION' }] },
  });
  await assert.rejects(() => stopped.provider.generateText('hi'), (err) => err.code === 'content_blocked');
});

test('gemini: a network failure is classified, not leaked as a raw system error', async () => {
  const boom = Object.assign(new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'), { code: 'ENOTFOUND' });
  const { provider } = build([boom, boom]);

  await assert.rejects(() => provider.generateText('hi'), (err) => {
    assert.equal(err.code, 'network_error');
    assert.equal(err.name, 'LlmError');
    return true;
  });
});

test('gemini: usage counts input tokens even for failed calls', async () => {
  const { provider, usage } = build([{ status: 500 }, { status: 500 }]);
  await assert.rejects(() => provider.generateText('a prompt of some length here'));

  const snapshot = usage.snapshot();
  assert.equal(snapshot.calls, 2);
  assert.equal(snapshot.failed, 2);
  assert.ok(snapshot.inputTokens > 0, 'a rejected call still consumed input tokens upstream');
  assert.equal(snapshot.lastError, 'provider_error');
  assert.ok(snapshot.lastCallAt, 'timestamp recorded for the dashboard');
});

test('gemini: falls back to estimated tokens when the provider reports none', async () => {
  const { provider } = build({ json: geminiResponse('some output text', null) });
  const { usage } = await provider.generateText('a prompt');
  assert.ok(usage.inputTokens > 0);
  assert.ok(usage.outputTokens > 0);
  assert.equal(usage.estimated, true, 'estimates are labelled as estimates');
});
