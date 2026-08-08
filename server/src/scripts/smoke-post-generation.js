/**
 * Live post-generation smoke check for Phase 10.
 *
 * Runs the real chain end to end: Phase 7 discovery against live feeds, one real
 * editorial call to choose a story, then exactly one real generation call to
 * write the post. Deliberately NOT part of `npm test`: the suite must pass
 * offline, with no key and no quota spend. Run this to confirm the credential,
 * the model, and the whole writer path work against the real API.
 *
 * It NEVER publishes: it prints a FinalPost's safe metadata and exits. No social
 * API is called, no database is touched. Nothing here prints the key, the
 * prompt, the auth header, or the raw provider response — every provider error
 * is already redacted by errors.js, and the final assertion re-scans all output
 * for a credential before exiting.
 *
 * Editorial is run with skipping disabled so a story is always chosen and the
 * one generation call is actually exercised; otherwise a quiet news cycle would
 * make this a no-op. That is a diagnostic choice for the smoke script only, not
 * how the agent behaves in production.
 *
 * Usage: node src/scripts/smoke-post-generation.js [--json]
 */
import { config } from '../config/env.js';
import { createLlmProvider, checkLlmReadiness } from '../services/llm/index.js';
import { UsageTracker } from '../services/llm/usage.js';
import { canonicalizeUrl } from '../utils/text.js';
import { discoverTopics, SENTINEL_PERSONA } from '../services/topics/index.js';
import { evaluateCandidates } from '../services/editorial/index.js';
import {
  generatePost,
  getPlatform,
  validateFinalPost,
  allowedSourceUrls,
  DEFAULT_PLATFORM,
} from '../services/generation/index.js';

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Used only when live discovery comes back empty (weekend arXiv, a feed outage),
 * so the one real generation call is still exercised. Clearly synthetic, and
 * labelled as such in the output — a diagnostic fallback, never the product path.
 */
const FALLBACK = [
  {
    title: 'Indirect prompt injection in an agent tool chain leaks private files',
    summary: 'A researcher shows a hidden instruction in a fetched page causing an agent to read and exfiltrate local files through a tool call. Includes a reproduction and a proposed mitigation.',
    url: 'https://example.com/disclosure',
    source: 'Example Research', publishedAt: '2026-08-07T09:00:00.000Z',
    score: 0.9, relevance: 0.85, corroboration: 2, sources: ['Example Research'],
    normalizedTopic: 'prompt-injection-agent-tools',
  },
];

async function main() {
  const asJson = process.argv.includes('--json');
  const platform = getPlatform(process.env.SMOKE_PLATFORM || DEFAULT_PLATFORM);
  console.log('--- Live post-generation smoke check (Phase 10) ---\n');

  const readiness = checkLlmReadiness(config);
  console.log(`Provider: ${readiness.provider}`);
  console.log(`Model:    ${readiness.model}`);
  console.log(`Platform: ${platform.id}`);
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

  // 1. Real discovery. A total failure falls back so the generation call still runs.
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
  console.log(`Judging:  ${candidates.length} candidate(s)${usedFallback ? ' (SYNTHETIC fallback)' : ' (live)'}\n`);

  // 2. One editorial call. Skipping disabled so a story is always chosen and the
  //    generation path is genuinely exercised.
  const usage = new UsageTracker();
  const provider = createLlmProvider({ ...config.llm, usage, requireCredentials: true });

  const decision = await evaluateCandidates(candidates, {
    persona, provider, allowSkip: false, agentId: 'smoke-generation',
  });

  console.log('--- Editorial decision ---');
  console.log(`decision:   ${decision.decision} (source: ${decision.source})`);
  console.log(`selected:   ${decision.candidate?.title?.slice(0, 90) ?? 'n/a'}`);
  console.log(`url:        ${decision.candidate?.url ?? 'n/a'}\n`);

  if (decision.decision !== 'publish') {
    check('editorial produced a publish decision to generate from', false, decision.decision);
    finish(asJson, { readiness, decision: safeDecision(decision) });
    return;
  }

  // 3. Exactly one real generation call.
  const started = Date.now();
  const result = await generatePost(decision, {
    persona, platform: platform.id, provider, agentId: 'smoke-generation',
  });
  const snapshot = usage.snapshot();
  const post = result.post;

  console.log('--- Generated post (safe metadata) ---');
  console.log(`status:     ${result.status}${result.code ? ` (${result.code})` : ''}`);
  console.log(`platform:   ${result.platform}`);
  if (post) {
    console.log(`chars:      ${post.characterCount} / ${platform.maxChars}`);
    console.log(`hashtags:   ${post.hashtags.length} — ${post.hashtags.join(' ')}`);
    console.log(`sourceUrls: ${post.sourceUrls.join(', ')}`);
    console.log(`hook:       ${post.hook.slice(0, 120)}`);
    console.log(`preview:    ${post.text.slice(0, 180).replace(/\n+/g, ' ')}…`);
  }
  console.log('');

  // 4. Assertions.
  console.log('--- Assertions ---');
  check('the generator returned a result', Boolean(result), `${Date.now() - started}ms`);
  check('the post was generated (not skipped or failed)', result.status === 'generated', result.code || 'ok');
  check('exactly one generation call was made', result.llmCalls === 1,
    `${result.llmCalls} call(s), ${result.llmAttempts} transport attempt(s)`);

  if (post) {
    const contract = validateFinalPost(post, platform);
    check('the FinalPost passes the strict contract', contract.valid, contract.errors.join('; ') || 'valid');
    check('characterCount matches the text length', post.characterCount === post.text.length,
      `${post.characterCount} vs ${post.text.length}`);
    check('the post is within the platform limit', post.text.length <= platform.maxChars,
      `${post.text.length} <= ${platform.maxChars}`);

    // Every cited source must be one the candidate actually carried.
    const allowed = new Set(allowedSourceUrls(decision.candidate).keys());
    const foreign = post.sourceUrls.filter((url) => !allowed.has(canonicalizeUrl(url)));
    check('every source URL came from the candidate', foreign.length === 0,
      foreign.length ? `foreign: ${foreign.join(', ')}` : `${post.sourceUrls.length} verified`);
  } else {
    check('the FinalPost passes the strict contract', false, 'no post was produced');
  }

  check('token usage was accounted for', snapshot.totalTokens > 0,
    `${snapshot.inputTokens} in / ${snapshot.outputTokens} out${snapshot.tokensAreEstimated ? ' (estimated)' : ' (reported)'}`);

  // Nothing published: this script imports no social API and touches no database.
  // Stated as an assertion so a future edit that added publishing here would fail.
  check('no post was published (this script only writes and verifies)', result.ok || result.status === 'failed');

  // A failure must never be the thing that leaks the credential. Re-scan every
  // surface — the post, the decision, usage — for the key or a key shape.
  const serialized = JSON.stringify({ result, snapshot });
  check('nothing in the output carries the credential',
    !serialized.includes(config.llm.apiKey) && !/AIza[0-9A-Za-z._-]{10,}/.test(serialized));

  finish(asJson, { readiness, usedFallback, result: safeResult(result), usage: snapshot });
}

/** Strip the decision down to fields safe to serialize in --json mode. */
function safeDecision(decision) {
  return {
    decision: decision.decision, confidence: decision.confidence, source: decision.source,
    candidate: decision.candidate ? { title: decision.candidate.title, url: decision.candidate.url } : null,
  };
}

/** The generation result carries only candidate-derived text; still, echo it explicitly. */
function safeResult(result) {
  return {
    status: result.status, code: result.code, platform: result.platform,
    llmCalls: result.llmCalls, llmAttempts: result.llmAttempts,
    post: result.post, editorial: result.editorial,
  };
}

function finish(asJson, payload) {
  if (asJson) console.log(`\n${JSON.stringify(payload, null, 2)}`);
  console.log(`\n--- ${results.length - failed}/${results.length} passed ---`);
  // process.exitCode, not process.exit(): exiting while the keep-alive socket is
  // still closing aborts libuv on Windows and replaces the status with garbage.
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  // err.message is redacted for LlmError; String(err) for anything unexpected.
  console.error('\nGENERATION SMOKE CHECK FAILED:', err?.message || String(err));
  process.exitCode = 1;
});
