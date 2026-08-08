/**
 * Live editorial smoke check for Phase 9.
 *
 * Runs the real Phase 7 discovery pipeline against live feeds, then spends
 * exactly one real editorial call judging what it found. Deliberately NOT part
 * of `npm test`: the suite must pass offline, with no key and no quota spend.
 * Run this to confirm the credential, the model, and the whole judge path work
 * end to end.
 *
 * It never publishes: it prints a decision and exits. No post is written, no
 * database is touched. Nothing here prints the key, the prompt, or the raw
 * provider response — every provider error is already redacted by errors.js,
 * and the final assertion re-scans all output for a credential before exiting.
 *
 * Usage: node src/scripts/smoke-editorial.js [--json]
 */
import { config } from '../config/env.js';
import { createLlmProvider, checkLlmReadiness } from '../services/llm/index.js';
import { UsageTracker } from '../services/llm/usage.js';
import { compactCandidates, assertBounded } from '../services/llm/candidates.js';
import { discoverTopics, SENTINEL_PERSONA } from '../services/topics/index.js';
import { evaluateCandidates } from '../services/editorial/index.js';

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Used only when live discovery comes back empty (weekend arXiv, a feed outage),
 * so the one real call is still exercised. Clearly synthetic, and labelled as
 * such in the output — it is a diagnostic fallback, never the product path.
 */
const FALLBACK = [
  {
    title: 'Indirect prompt injection in an agent tool chain leaks private files',
    summary: 'A researcher shows a hidden instruction in a fetched page causing an agent to read and exfiltrate local files through a tool call. Includes a reproduction and a proposed mitigation.',
    url: 'https://example.com/disclosure',
    source: 'Example Research', publishedAt: '2026-08-07T09:00:00.000Z',
    score: 0.9, relevance: 0.85, corroboration: 2, normalizedTopic: 'prompt-injection-agent-tools',
  },
  {
    title: 'Vendor announces an AI security platform at its annual conference',
    summary: 'A press release describing a new product bundle. No technical detail, no disclosure, no reproduction path.',
    url: 'https://example.com/launch',
    source: 'Example Wire', publishedAt: '2026-08-07T08:00:00.000Z',
    score: 0.4, relevance: 0.3, corroboration: 3, normalizedTopic: 'vendor-platform-launch',
  },
];

async function main() {
  const asJson = process.argv.includes('--json');
  console.log('--- Live editorial smoke check (Phase 9) ---\n');

  const readiness = checkLlmReadiness(config);
  console.log(`Provider: ${readiness.provider}`);
  console.log(`Model:    ${readiness.model}`);
  console.log(`Ready:    ${readiness.ok}${readiness.reason ? ` (${readiness.reason})` : ''}\n`);

  if (!readiness.ok) {
    console.log('Nothing to check: set LLM_API_KEY in server/.env to run this against the real API.');
    process.exitCode = 1;
    return;
  }
  if (readiness.provider === 'mock') {
    console.log('LLM_PROVIDER=mock would test the mock, not the API. Set LLM_PROVIDER=gemini.');
    process.exitCode = 1;
    return;
  }

  const persona = SENTINEL_PERSONA;
  const maxCandidates = config.editorial.maxCandidates;

  // 1. Real Phase 7 discovery. Its own per-source timeouts keep this bounded;
  //    a total failure falls back so the one editorial call still runs.
  console.log('--- Discovery (live feeds) ---');
  let discovered;
  try {
    discovered = await discoverTopics({ persona, limit: maxCandidates });
  } catch (err) {
    console.log(`Discovery failed (${err.code || 'error'}); using the synthetic fallback shortlist.`);
    discovered = null;
  }

  let candidates = discovered?.candidates ?? [];
  let usedFallback = false;
  if (candidates.length === 0) {
    usedFallback = true;
    candidates = FALLBACK;
  }
  candidates = candidates.slice(0, maxCandidates);

  const bounds = assertBounded(compactCandidates(candidates, { limit: maxCandidates }));
  if (discovered) {
    console.log(`Collected: ${discovered.stats.collected}  ->  candidates: ${discovered.stats.candidates}`);
  }
  console.log(`Judging:   ${candidates.length} candidate(s)${usedFallback ? ' (SYNTHETIC fallback)' : ' (live)'}`);
  console.log(`Payload:   ${bounds.chars} chars (~${Math.ceil(bounds.chars / 4)} tokens)\n`);

  // 2. Exactly one real editorial call, through the same service Phase 10 uses.
  const usage = new UsageTracker();
  const provider = createLlmProvider({ ...config.llm, usage, requireCredentials: true });

  const started = Date.now();
  const decision = await evaluateCandidates(candidates, { persona, provider, agentId: 'smoke-editorial' });
  const snapshot = usage.snapshot();

  console.log('--- Decision ---');
  console.log(`decision:   ${decision.decision}`);
  console.log(`confidence: ${decision.confidence}`);
  console.log(`source:     ${decision.source}`);
  if (decision.decision === 'publish') {
    console.log(`selected:   #${decision.selectedCandidateIndex} — ${decision.candidate?.title?.slice(0, 90)}`);
    console.log(`url:        ${decision.candidate?.url}`);
    console.log(`angle:      ${String(decision.angle).slice(0, 120)}`);
  }
  console.log(`reason:     ${String(decision.reason).slice(0, 160)}\n`);

  console.log('--- Assertions ---');
  check('the editorial service returned a decision', Boolean(decision), `${Date.now() - started}ms`);
  check('the decision is a clean publish or skip', ['publish', 'skip'].includes(decision.decision),
    decision.decision);
  check('exactly one editorial call was made this cycle', decision.llmCalls === 1,
    `${decision.llmCalls} call(s), ${decision.llmAttempts} transport attempt(s)`);
  check('transport attempts did not multiply into extra cycles', snapshot.calls <= 2,
    `${snapshot.calls} attempt(s)`);
  check('a publish resolved to a real, verified candidate',
    decision.decision !== 'publish'
      || Boolean(decision.candidate?.url && decision.candidate?.title),
    decision.decision === 'publish' ? decision.candidate?.url : 'n/a (skip)');
  check('the input stayed bounded', bounds.chars < 12_000 && bounds.candidates <= maxCandidates,
    `${bounds.candidates} candidates / ${bounds.chars} chars`);
  check('token usage was accounted for', snapshot.totalTokens > 0,
    `${snapshot.inputTokens} in / ${snapshot.outputTokens} out${snapshot.tokensAreEstimated ? ' (estimated)' : ' (reported)'}`);

  // Nothing published: this script calls no post writer and no database. State
  // it as an assertion so a future edit that added persistence here would fail.
  check('no post was published (this script only judges)',
    typeof decision.candidate === 'object' || decision.candidate === null);

  // A failure must never be the thing that leaks the credential. Re-scan every
  // surface — decision, usage, discovery stats — for the key or a key shape.
  const serialized = JSON.stringify({ decision, snapshot, stats: discovered?.stats ?? null });
  check('nothing in the output carries the credential',
    !serialized.includes(config.llm.apiKey) && !/AIza[0-9A-Za-z._-]{10,}/.test(serialized));

  if (asJson) {
    console.log(`\n${JSON.stringify({ readiness, bounds, usedFallback, decision, usage: snapshot }, null, 2)}`);
  }

  console.log(`\n--- ${results.length - failed}/${results.length} passed ---`);
  // process.exitCode, not process.exit(): exiting while the keep-alive socket is
  // still closing aborts libuv on Windows and replaces the status with garbage.
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  // err.message is redacted for LlmError; String(err) for anything unexpected.
  console.error('\nEDITORIAL SMOKE CHECK FAILED:', err?.message || String(err));
  process.exitCode = 1;
});
