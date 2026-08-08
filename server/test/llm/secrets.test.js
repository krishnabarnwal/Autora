import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createGeminiProvider } from '../../src/services/llm/geminiProvider.js';
import { redactSecrets, LlmError } from '../../src/services/llm/errors.js';
import { UsageTracker } from '../../src/services/llm/usage.js';
import { FAKE_API_KEY, geminiResponse, fakeFetch, captureConsole } from '../fixtures/llm.js';

/**
 * The key must not escape through any channel: logs, error messages, thrown
 * objects, usage snapshots, or serialized errors bound for HTTP or MongoDB.
 * Each test below closes one of those channels.
 */

const build = (script, options = {}) => createGeminiProvider({
  apiKey: FAKE_API_KEY, model: 'gemini-2.5-flash', fetchImpl: fakeFetch(script),
  usage: new UsageTracker(), sleep: () => Promise.resolve(), ...options,
});

test('secrets: redactSecrets removes a known key in every encoding', () => {
  const encoded = encodeURIComponent(FAKE_API_KEY);
  const text = `url=https://x/y?key=${FAKE_API_KEY} encoded=${encoded} header=${FAKE_API_KEY}`;
  const clean = redactSecrets(text, [FAKE_API_KEY]);

  assert.ok(!clean.includes(FAKE_API_KEY));
  assert.ok(!clean.includes(encoded));
  assert.match(clean, /\[redacted\]/);
});

test('secrets: key-shaped values are redacted even when we were never told the key', () => {
  // A proxy, a nested provider message, or a copy-pasted curl can carry a key
  // this layer never held. Pattern matching is the only defence there.
  const samples = [
    'Request failed: {"apiKey":"AIzaSyD-SOME-OTHER-KEY-9876543210xyz"}',
    'curl -H "x-goog-api-key: AIzaSyD-ANOTHER-KEY-abcdefghijklmn"',
    'authorization: Bearer sk-proj-0123456789abcdefghij',
    'api_key=abcdef0123456789ABCDEF',
  ];

  for (const sample of samples) {
    const clean = redactSecrets(sample, []);
    assert.match(clean, /\[redacted\]/, `nothing redacted in: ${sample}`);
    assert.ok(!/AIzaSy[0-9A-Za-z._-]{10,}/.test(clean), `google key survived: ${clean}`);
  }
});

test('secrets: short strings are not blanket-replaced', () => {
  // Over-eager redaction would mangle ordinary messages; "key" must stay readable.
  assert.equal(redactSecrets('the key is missing', ['short']), 'the key is missing');
});

test('secrets: the key never appears in a provider error message', async () => {
  // A provider echoing the whole request back is the realistic worst case.
  const echoed = JSON.stringify({
    error: {
      message: `Invalid request to ?key=${FAKE_API_KEY}`,
      details: [{ headers: { 'x-goog-api-key': FAKE_API_KEY } }],
    },
  });
  const provider = build({ status: 400, body: echoed });

  await assert.rejects(() => provider.generateText('hi'), (err) => {
    const serialized = `${err.message} ${JSON.stringify(err)} ${JSON.stringify(err.toJSON())} ${err.stack}`;
    assert.ok(!serialized.includes(FAKE_API_KEY), 'the key leaked through the error');
    assert.match(err.message, /\[redacted\]/);
    return true;
  });
});

test('secrets: the key never appears in a network error message', async () => {
  const leaky = new Error(`connect ECONNREFUSED while sending x-goog-api-key: ${FAKE_API_KEY}`);
  const provider = build([leaky, leaky]);

  await assert.rejects(() => provider.generateText('hi'), (err) => {
    assert.ok(!err.message.includes(FAKE_API_KEY));
    return true;
  });
});

test('secrets: the key never reaches a log sink, including on the retry path', async () => {
  const captured = captureConsole();
  try {
    const provider = build([{ status: 429, body: `quota for key ${FAKE_API_KEY}` }, { status: 429, body: 'quota' }]);
    await provider.generateText('hi').catch(() => {});
  } finally {
    captured.restore();
  }

  assert.ok(captured.lines.length > 0, 'the retry warning was logged');
  assert.ok(!captured.text().includes(FAKE_API_KEY), `key found in logs: ${captured.text()}`);
});

test('secrets: the key travels in a header, never in the URL', async () => {
  const fetchImpl = fakeFetch({ json: geminiResponse('ok') });
  const provider = createGeminiProvider({
    apiKey: FAKE_API_KEY, model: 'gemini-2.5-flash', fetchImpl, usage: new UsageTracker(),
  });

  await provider.generateText('hi');
  const request = fetchImpl.requests[0];

  // URLs end up in logs, proxies, and error strings far more often than headers.
  assert.ok(!request.url.includes(FAKE_API_KEY), 'key must not be a query parameter');
  assert.ok(!request.url.includes('key='));
  assert.equal(request.headers['x-goog-api-key'], FAKE_API_KEY, 'but it must still authenticate');
});

test('secrets: usage snapshots carry counts only', async () => {
  const usage = new UsageTracker();
  const provider = build({ json: geminiResponse('ok') }, { usage });
  await provider.generateText(`a prompt mentioning ${FAKE_API_KEY} by accident`);

  const serialized = JSON.stringify(usage.snapshot());
  assert.ok(!serialized.includes(FAKE_API_KEY));
  // Nor the prompt itself: usage is counts, not content.
  assert.ok(!serialized.includes('a prompt mentioning'));
});

test('secrets: LlmError.toJSON is safe to return over HTTP', () => {
  const error = new LlmError('boom', 'provider_error', { status: 500, provider: 'gemini', model: 'x' });
  const json = error.toJSON();
  assert.deepEqual(Object.keys(json).sort(), ['code', 'message', 'name', 'provider', 'retryable', 'status']);
  assert.ok(!('details' in json), 'raw provider details stay server-side');
  assert.ok(!('stack' in json));
});

test('secrets: no source file logs the API key', async () => {
  const dir = 'src/services/llm';
  const files = (await readdir(dir)).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 6, 'the llm directory was found');

  for (const name of files) {
    const source = await readFile(join(dir, name), 'utf8');
    // Catches log.info('...', { apiKey }) and template interpolation alike.
    assert.ok(!/(log|console)\.[a-z]+\([^)]*\bapiKey\b/s.test(source),
      `${name} passes apiKey to a logger`);
    assert.ok(!/\$\{\s*apiKey\s*\}/.test(source), `${name} interpolates apiKey into a string`);
    assert.ok(!/key=\$\{/.test(source), `${name} builds a URL with the key`);
  }
});
