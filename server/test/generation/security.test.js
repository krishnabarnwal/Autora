import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePost } from '../../src/services/generation/index.js';
import { buildPostPrompt, GENERATION_SYSTEM_PROMPT } from '../../src/services/generation/prompt.js';
import { createGeminiProvider } from '../../src/services/llm/geminiProvider.js';
import { createMockProvider } from '../../src/services/llm/mockProvider.js';
import { UsageTracker } from '../../src/services/llm/usage.js';
import { compactCandidates } from '../../src/services/llm/candidates.js';
import { logger, recentActivity, clearActivity } from '../../src/utils/logger.js';
import {
  PERSONA,
  CANDIDATE,
  publishDecisionResult,
  validGeneration,
} from '../fixtures/generation.js';

/**
 * Secret safety for the generation path. Same threat model as the editorial
 * layer: this is the second place a credential, a prompt and a log line meet in
 * one function, and Phase 14 renders this result and the activity buffer. A key
 * reaching either would then reach the dashboard.
 *
 * The synthetic key is shaped like a real Gemini key so the redaction patterns
 * are genuinely exercised. It is not real and never was.
 */

const FAKE_KEY = 'AIzaSyFAKEKEYFORTESTINGONLY_000000000000';

/** Everything a generation cycle produced, as one searchable string. */
function surfaces({ result, logs, thrown }) {
  return JSON.stringify({ result, logs, thrown: thrown ? String(thrown.stack || thrown) : null });
}

/** Re-scan for the key and for the general Gemini key shape. */
function assertNoCredential(text) {
  assert.ok(!text.includes(FAKE_KEY), 'the credential must not appear anywhere');
  assert.doesNotMatch(text, /AIza[0-9A-Za-z._-]{10,}/);
  assert.doesNotMatch(text, /x-goog-api-key|authorization|bearer/i);
}

test('security: the credential never reaches the generation prompt', () => {
  const [candidate] = compactCandidates([CANDIDATE], { limit: 1 });
  const prompt = buildPostPrompt({ persona: PERSONA, candidate, decision: publishDecisionResult(), platform: 'linkedin' });
  assertNoCredential(prompt);
  assert.doesNotMatch(GENERATION_SYSTEM_PROMPT, /AIza|api[-_ ]?key/i);
});

test('security: a failing Gemini call leaks nothing into the result, logs, or errors', async () => {
  clearActivity();

  // A provider with a real-shaped key whose transport fails, so the credential
  // is live in the process during the failure — the case that matters.
  const provider = createGeminiProvider({
    apiKey: FAKE_KEY,
    model: 'gemini-3.5-flash',
    usage: new UsageTracker(),
    retries: 0,
    fetchImpl: async (url, init) => {
      assert.ok(!String(url).includes(FAKE_KEY), 'the key must never ride in the URL');
      assert.equal(init.headers['x-goog-api-key'], FAKE_KEY, 'the key belongs in the header');
      return new Response(
        JSON.stringify({ error: { message: `Invalid key ${FAKE_KEY} in header x-goog-api-key`, code: 400 } }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    },
  });

  const result = await generatePost(publishDecisionResult(), { persona: PERSONA, provider, agentId: 'gen-secret' });
  const logs = recentActivity({ limit: 100 });

  assert.equal(result.status, 'failed', 'a failed call must end the cycle, not fabricate a post');
  assert.equal(result.post, null);
  assertNoCredential(surfaces({ result, logs }));
});

test('security: internal provider error text is not surfaced in the result', async () => {
  // The upstream 400 body above quotes the key; the mapped result must carry a
  // clean taxonomy code and message, not the raw provider string.
  const provider = createGeminiProvider({
    apiKey: FAKE_KEY,
    model: 'gemini-3.5-flash',
    usage: new UsageTracker(),
    retries: 0,
    fetchImpl: async () => new Response(
      JSON.stringify({ error: { message: `boom ${FAKE_KEY}`, code: 400 } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    ),
  });

  const result = await generatePost(publishDecisionResult(), { persona: PERSONA, provider });
  assert.equal(result.status, 'failed');
  // A generic 400 is a bad_request -> generation_failed; the message is ours.
  assert.doesNotMatch(JSON.stringify(result), /boom/);
  assertNoCredential(JSON.stringify(result));
});

test('security: the FinalPost and result carry no prompt text and no credential', async () => {
  const provider = createMockProvider({ script: { json: validGeneration() }, usage: new UsageTracker() });
  const result = await generatePost(publishDecisionResult(), { persona: PERSONA, provider });
  const serialized = JSON.stringify(result);

  assertNoCredential(serialized);
  // The full prompt must not be stored: Phase 14 renders this object.
  assert.doesNotMatch(serialized, /EVIDENCE DISCIPLINE|Reply with JSON only|OUTPUT CONTRACT/i);
});

test('security: generation logs describe the cycle without quoting the prompt', async () => {
  clearActivity();
  const provider = createMockProvider({ script: { json: validGeneration() }, usage: new UsageTracker() });
  await generatePost(publishDecisionResult(), { persona: PERSONA, provider, agentId: 'gen-logs' });

  const entries = recentActivity({ limit: 50 }).filter((entry) => entry.tag === 'WRITER');
  assert.ok(entries.length >= 2, 'the cycle should be observable in the activity buffer');

  const text = JSON.stringify(entries);
  assert.doesNotMatch(text, /EVIDENCE DISCIPLINE|Reply with JSON only/);
  assertNoCredential(text);
  // It logs the size of the prompt, which is the useful part, not its contents.
  assert.ok(entries.some((entry) => typeof entry.data?.promptChars === 'number'));
});

test('security: the activity logger redacts credential-named fields for the writer tag too', () => {
  clearActivity();
  const log = logger('WRITER');
  log.info('probe', { agentId: 'gen-scrub', apiKey: FAKE_KEY, note: 'safe text' });

  const [entry] = recentActivity({ agentId: 'gen-scrub', limit: 1 });
  assert.equal(entry.data.apiKey, '[redacted]');
  assert.equal(entry.data.note, 'safe text');
  assert.ok(!JSON.stringify(entry).includes(FAKE_KEY));
});

test('security: no social-publishing module is imported by the generation layer', async () => {
  // The spec forbids importing any publishing API. Read the module source and
  // assert none of the banned hosts/SDKs appear as an import target.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('../../src/services/generation/', import.meta.url));
  const files = ['index.js', 'prompt.js', 'verify.js', 'schema.js', 'platforms.js', 'errors.js', 'mockScript.js'];
  const banned = /(from|import)\s+['"][^'"]*(linkedin|twitter|facebook|instagram|buffer|hootsuite|x\.com|graph\.)/i;

  for (const file of files) {
    const source = readFileSync(dir + file, 'utf8');
    assert.doesNotMatch(source, banned, `${file} must not import a publishing API`);
  }
});
