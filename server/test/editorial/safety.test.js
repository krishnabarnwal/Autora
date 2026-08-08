import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidates } from '../../src/services/editorial/index.js';
import { SYSTEM_PROMPT, buildEditorialPrompt } from '../../src/services/editorial/prompt.js';
import { createGeminiProvider } from '../../src/services/llm/geminiProvider.js';
import { createMockProvider } from '../../src/services/llm/mockProvider.js';
import { UsageTracker } from '../../src/services/llm/usage.js';
import { compactCandidates } from '../../src/services/llm/candidates.js';
import { logger, recentActivity, clearActivity } from '../../src/utils/logger.js';
import { NOW } from '../fixtures/feeds.js';
import { PERSONA, STRONG, PROMOTIONAL, THIN, publishDecision, skipDecision } from '../fixtures/editorial.js';

/**
 * Secret safety for the editorial path.
 *
 * A synthetic credential is used throughout, shaped like a real Gemini key so
 * the redaction patterns are genuinely exercised. It is not a real key and
 * never was, and no test here reads the configured one.
 *
 * The threat is mundane: the editorial call is the first place in this project
 * where a credential, a prompt and a log line meet in the same function, and a
 * key reaching the activity buffer would then reach the Phase 14 dashboard.
 */

const FAKE_KEY = 'AIzaSyFAKEKEYFORTESTINGONLY_000000000000';

/** Everything the editorial cycle produced, as one searchable string. */
function surfaces({ result, logs, thrown }) {
  return JSON.stringify({ result, logs, thrown: thrown ? String(thrown.stack || thrown) : null });
}

const evaluate = (candidates, options = {}) =>
  evaluateCandidates(candidates, { persona: PERSONA, now: NOW, ...options });

test('safety: the key never reaches the prompt', () => {
  const prompt = buildEditorialPrompt({
    persona: { ...PERSONA, name: 'Sentinel' },
    candidates: compactCandidates([STRONG, PROMOTIONAL, THIN]),
  });

  assert.ok(!prompt.includes(FAKE_KEY));
  assert.doesNotMatch(prompt, /AIza[0-9A-Za-z._-]{10,}/);
  assert.doesNotMatch(prompt, /x-goog-api-key|authorization|bearer/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /AIza|api[-_ ]?key/i);
});

test('safety: a failing Gemini call leaks nothing into the decision, logs, or errors', async () => {
  clearActivity();

  // A provider with a real-shaped key whose transport fails, so the credential
  // is present in the process during the failure — the case that matters.
  const provider = createGeminiProvider({
    apiKey: FAKE_KEY,
    model: 'gemini-3.5-flash',
    usage: new UsageTracker(),
    retries: 0,
    fetchImpl: async (url, init) => {
      // The upstream error text quotes the request, which is how keys escape.
      assert.ok(!String(url).includes(FAKE_KEY), 'the key must never ride in the URL');
      assert.equal(init.headers['x-goog-api-key'], FAKE_KEY, 'the key belongs in the header');
      return new Response(
        JSON.stringify({ error: { message: `Invalid key ${FAKE_KEY} in header x-goog-api-key`, code: 400 } }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    },
  });

  const result = await evaluate([STRONG, PROMOTIONAL], { provider, agentId: 'agent-secret' });
  const logs = recentActivity({ limit: 100 });
  const everything = surfaces({ result, logs });

  assert.equal(result.decision, 'skip', 'a failed call must end the cycle, not publish');
  assert.ok(!everything.includes(FAKE_KEY), 'the credential must not appear anywhere');
  assert.doesNotMatch(everything, /AIza[0-9A-Za-z._-]{10,}/);
});

test('safety: a thrown provider error carries no credential', async () => {
  const provider = createGeminiProvider({
    apiKey: FAKE_KEY,
    model: 'gemini-3.5-flash',
    usage: new UsageTracker(),
    retries: 0,
    fetchImpl: async () => { throw new Error(`connect ECONNREFUSED using key ${FAKE_KEY}`); },
  });

  let thrown = null;
  try {
    await provider.generateJSON('probe', { schema: { type: 'object', properties: {} } });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown, 'the probe should have failed');
  assert.ok(!surfaces({ thrown }).includes(FAKE_KEY));
  assert.match(String(thrown.message), /\[redacted\]/);
});

test('safety: the usage tracker holds counts only, never prompts or credentials', async () => {
  const usage = new UsageTracker();
  const provider = createMockProvider({ script: [{ json: publishDecision() }], usage });

  const result = await evaluate([STRONG, PROMOTIONAL], { provider });
  const snapshot = JSON.stringify(usage.snapshot());

  assert.ok(!snapshot.includes(FAKE_KEY));
  assert.doesNotMatch(snapshot, /AIza/);
  // No prompt text, no candidate text, no key — counts and timings only.
  assert.doesNotMatch(snapshot, /PERSONA|CANDIDATES|prompt injection/i);
  assert.ok(!snapshot.includes(STRONG.title));
  assert.equal(result.usage.calls, 1);
});

test('safety: the decision object carries no prompt and no credential', async () => {
  const provider = createMockProvider({ script: [{ json: publishDecision() }], usage: new UsageTracker() });
  const result = await evaluate([STRONG, PROMOTIONAL], { provider });
  const serialized = JSON.stringify(result);

  assert.ok(!serialized.includes(FAKE_KEY));
  assert.doesNotMatch(serialized, /AIza|x-goog-api-key|authorization/i);
  // The full prompt must not be stored: Phase 10 persists this object.
  assert.doesNotMatch(serialized, /Reply with JSON only/);
  assert.doesNotMatch(serialized, /editorial decision-maker/i);
});

test('safety: editorial logs describe the cycle without quoting the prompt', async () => {
  clearActivity();
  const provider = createMockProvider({ script: [{ json: publishDecision() }], usage: new UsageTracker() });

  await evaluate([STRONG, PROMOTIONAL], { provider, agentId: 'agent-logs' });

  const entries = recentActivity({ limit: 50 }).filter((entry) => entry.tag === 'EDITOR');
  assert.ok(entries.length >= 2, 'the cycle should be observable in the activity buffer');

  const text = JSON.stringify(entries);
  assert.doesNotMatch(text, /Reply with JSON only|EVIDENCE DISCIPLINE|PERSONA\\n/);
  assert.ok(!text.includes(FAKE_KEY));

  // It logs the size of the prompt, which is the useful part, not its contents.
  assert.ok(entries.some((entry) => typeof entry.data?.promptChars === 'number'));
  assert.ok(entries.some((entry) => /Editorial decision: publish/.test(entry.message)));
});

test('safety: the activity logger redacts credential-named fields as a last-line net', () => {
  // The editorial path already avoids this by logging counts and titles rather
  // than prose, but the buffer that feeds the Phase 14 dashboard needs a net of
  // its own: a field whose NAME looks like a credential is redacted by value
  // before it is ever stored. (This nets field names, not free text — which is
  // why the discipline of not logging prose in the first place still matters.)
  clearActivity();
  const log = logger('EDITOR');
  log.info('probe', {
    agentId: 'agent-scrub', apiKey: FAKE_KEY, authorization: `Bearer ${FAKE_KEY}`, note: 'safe text',
  });

  const [entry] = recentActivity({ agentId: 'agent-scrub', limit: 1 });
  assert.equal(entry.data.apiKey, '[redacted]');
  assert.equal(entry.data.authorization, '[redacted]');
  assert.equal(entry.data.note, 'safe text', 'non-secret fields must survive');
  assert.ok(!JSON.stringify(entry).includes(FAKE_KEY));
});

test('safety: activity entries are scoped per agent', async () => {
  // Phase 14 renders this buffer per agent; a leak across agents would show one
  // operator another operator's editorial reasoning.
  clearActivity();
  await evaluate([STRONG, PROMOTIONAL], {
    provider: createMockProvider({ script: [{ json: publishDecision() }], usage: new UsageTracker() }),
    agentId: 'agent-alpha',
  });
  await evaluate([STRONG, PROMOTIONAL], {
    provider: createMockProvider({ script: [{ json: skipDecision() }], usage: new UsageTracker() }),
    agentId: 'agent-beta',
  });

  const alpha = recentActivity({ agentId: 'agent-alpha', limit: 50 });
  const beta = recentActivity({ agentId: 'agent-beta', limit: 50 });

  assert.ok(alpha.length > 0 && beta.length > 0, 'both agents should have logged');
  assert.ok(alpha.every((entry) => entry.agentId === 'agent-alpha'));
  assert.ok(beta.every((entry) => entry.agentId === 'agent-beta'));
});
