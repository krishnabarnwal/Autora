/**
 * Live Gemini smoke check for Phase 8.
 *
 * Makes real API calls, so it is deliberately NOT part of `npm test`: the suite
 * must pass offline, on any machine, without a key and without spending quota.
 * Run this when you want to confirm the credential and the model actually work.
 *
 * It spends one or two calls on a deliberately tiny prompt. Nothing here prints
 * the key, and every provider error is already redacted by errors.js before it
 * surfaces.
 *
 * Touches no database and writes nothing.
 *
 * Usage: node src/scripts/smoke-llm.js [--json]
 */
import { config } from '../config/env.js';
import { createLlmProvider, checkLlmReadiness } from '../services/llm/index.js';
import { UsageTracker } from '../services/llm/usage.js';
import { compactCandidates, assertBounded } from '../services/llm/candidates.js';

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A schema shaped like Phase 9's, kept trivial so the call stays cheap. */
const SMOKE_SCHEMA = {
  type: 'object',
  required: ['selectedId', 'rationale'],
  additionalProperties: false,
  properties: {
    selectedId: { type: 'integer', minimum: 1, maximum: 2 },
    rationale: { type: 'string', minLength: 10, maxLength: 300 },
  },
};

const CANDIDATES = [
  {
    title: 'Indirect prompt injection in an agent tool chain leaks private files',
    summary: 'A researcher shows a hidden instruction in a fetched web page causing an agent to read and exfiltrate local files through a tool call.',
    url: 'https://example.com/a',
    source: 'Example Research',
    publishedAt: '2026-08-07T09:00:00.000Z',
    score: 0.9,
    relevance: 0.8,
    corroboration: 2,
    normalizedTopic: 'prompt-injection-agent-tools',
  },
  {
    title: 'Vendor announces an AI security platform at its annual conference',
    summary: 'A press release describing a new product bundle. No technical detail, no disclosure, no reproduction path.',
    url: 'https://example.com/b',
    source: 'Example Wire',
    publishedAt: '2026-08-07T08:00:00.000Z',
    score: 0.4,
    relevance: 0.3,
    corroboration: 1,
    normalizedTopic: 'vendor-platform-launch',
  },
];

async function main() {
  const asJson = process.argv.includes('--json');
  console.log('--- Live LLM smoke check (Phase 8) ---\n');

  const readiness = checkLlmReadiness(config);
  // Never the key, and never a prefix of it.
  console.log(`Provider: ${readiness.provider}`);
  console.log(`Model:    ${readiness.model}`);
  console.log(`Ready:    ${readiness.ok}${readiness.reason ? ` (${readiness.reason})` : ''}\n`);

  if (!readiness.ok) {
    console.log('Nothing to check: set LLM_API_KEY in server/.env to run this against the real API.');
    process.exitCode = 1;
    return;
  }
  if (readiness.provider === 'mock') {
    console.log('LLM_PROVIDER=mock, so this would test the mock rather than the API.');
    console.log('Set LLM_PROVIDER=gemini to run the live check.');
    process.exitCode = 1;
    return;
  }

  const usage = new UsageTracker();
  const provider = createLlmProvider({ ...config.llm, usage, requireCredentials: true });

  const compacted = compactCandidates(CANDIDATES);
  const bounds = assertBounded(compacted);
  const prompt = [
    'You are choosing which of these two items is worth writing about.',
    'Reply with JSON only: {"selectedId": <number>, "rationale": "<one sentence>"}',
    '',
    `Candidates: ${JSON.stringify(compacted)}`,
  ].join('\n');

  console.log('--- Request ---');
  console.log(`Candidates sent: ${bounds.candidates}`);
  console.log(`Payload size:    ${bounds.chars} chars (~${Math.ceil(bounds.chars / 4)} tokens)\n`);

  const started = Date.now();
  let decision;
  let callError;
  try {
    const response = await provider.generateJSON(prompt, { schema: SMOKE_SCHEMA });
    decision = response.data;
    console.log('--- Response ---');
    console.log(`selectedId: ${decision.selectedId}`);
    console.log(`rationale:  ${decision.rationale}\n`);
  } catch (err) {
    callError = err;
    // Already redacted on the way out of the provider.
    console.log(`--- Call failed: ${err.code} — ${err.message}\n`);
  }

  const snapshot = usage.snapshot();

  console.log('--- Assertions ---');
  check('the provider was reachable and returned a decision', Boolean(decision),
    callError ? `${callError.code}` : `${Date.now() - started}ms`);
  check('the response matched the requested schema',
    Boolean(decision) && Number.isInteger(decision.selectedId) && typeof decision.rationale === 'string');
  check('the input stayed bounded', bounds.chars < 12_000 && bounds.candidates <= 10,
    `${bounds.candidates} candidates / ${bounds.chars} chars`);
  check('exactly one logical call was made', snapshot.calls <= 2,
    `${snapshot.calls} attempt(s), ${snapshot.successful} successful`);
  check('token usage was accounted for', snapshot.totalTokens > 0,
    `${snapshot.inputTokens} in / ${snapshot.outputTokens} out${snapshot.tokensAreEstimated ? ' (estimated)' : ' (reported)'}`);

  // A failure must never be the thing that leaks the credential.
  const serialized = JSON.stringify({ snapshot, error: callError?.toJSON?.() ?? null });
  check('nothing in the output carries the credential',
    !serialized.includes(config.llm.apiKey) && !/AIza[0-9A-Za-z._-]{10,}/.test(serialized));

  if (asJson) {
    console.log(`\n${JSON.stringify({ readiness, bounds, decision: decision ?? null, usage: snapshot }, null, 2)}`);
  }

  console.log(`\n--- ${results.length - failed}/${results.length} passed ---`);
  // Set the code and return rather than process.exit(): calling exit() while
  // the HTTP keep-alive socket is still closing aborts libuv on Windows and
  // replaces the real status with a garbage one, which would make a passing
  // run look like a failure.
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  // err.message is redacted for LlmError; String(err) for anything unexpected.
  console.error('\nLLM SMOKE CHECK FAILED:', err?.message || String(err));
  process.exitCode = 1;
});
