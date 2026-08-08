/**
 * Phase 10 — final post generation.
 *
 * One job: turn a Phase 9 publish decision plus its selected candidate into a
 * platform-ready FinalPost. Not published — assembled and verified, ready for a
 * future publishing phase.
 *
 * The pipeline mirrors the editorial layer on purpose, so the two read the same:
 *
 *   editorial decision      ->  gate: publish? (skip -> SKIP, zero calls)
 *   getPlatform()           ->  the target and its limits (config, not the model)
 *   resolve candidate       ->  the full Phase 7 record to write from
 *   compactCandidates()     ->  bounded payload (Phase 8 owns the bound)
 *   ONE generateJSON() call ->  schema-valid draft (four creative fields)
 *   verifyGeneratedPost()   ->  trusted FinalPost, or fail closed
 *
 * Two rules shape the whole file. First, exactly one generation call, and only
 * when the decision was publish — a skip costs zero calls, never one. Second,
 * every failure is a named failure with no post attached: the model's output is
 * untrusted input, and a draft that fails any check ends the attempt rather than
 * being repaired into something publishable. It never fabricates a successful
 * post after a failure, and it never publishes.
 */
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { getLlmProvider } from '../llm/index.js';
import { compactCandidates, assertBounded } from '../llm/candidates.js';
import { LlmError } from '../llm/errors.js';
import {
  GenerationError,
  GenerationInputError,
  GENERATION_ERROR_CODES,
  mapLlmErrorCode,
} from './errors.js';
import { getPlatform, DEFAULT_PLATFORM } from './platforms.js';
import { buildGenerationSchema } from './schema.js';
import { GENERATION_SYSTEM_PROMPT, buildPostPrompt } from './prompt.js';
import { verifyGeneratedPost } from './verify.js';
import { generationMockScript } from './mockScript.js';

const log = logger('WRITER');

/** The decision values this layer recognises; kept local so it never imports the editorial gate. */
const PUBLISH = 'publish';

/**
 * Shape the generation result.
 *
 * `status` is the coarse outcome a caller branches on; `code` is the specific
 * taxonomy value (null on success). `post` is the FinalPost on success and null
 * otherwise — never a partial or repaired object, so "failed with a post
 * attached" is unrepresentable. The editorial context is echoed back so a
 * dashboard can show *why* this post exists without re-reading the decision.
 */
function generationResult({
  status,
  post = null,
  code = null,
  message = '',
  details = [],
  platform,
  decision = {},
  llmCalls = 0,
  llmAttempts = 0,
  usage = null,
  provider = null,
  model = null,
  warnings = [],
  agentId = null,
  startedAt = 0,
  now = Date.now(),
}) {
  return {
    status, // 'generated' | 'skipped' | 'failed'
    ok: status === 'generated',
    post,
    code,
    message,
    details,
    platform,

    // Why this post exists, echoed from the editorial decision (never re-judged).
    editorial: {
      decision: decision.decision ?? null,
      confidence: decision.confidence ?? null,
      angle: decision.angle ?? null,
      reason: decision.reason ?? null,
      source: decision.source ?? null,
      selectedCandidateIndex: decision.selectedCandidateIndex ?? null,
    },

    // Provenance, same fields the editorial result carries so the two align.
    /** Generation calls made. Zero for a skip, exactly one for a publish attempt. */
    llmCalls,
    /** Transport attempts, so a retried 429 stays visible rather than averaging out. */
    llmAttempts,
    usage,
    provider,
    model,
    warnings,
    agentId,
    durationMs: startedAt ? Math.max(0, now - startedAt) : 0,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * Pull the candidate to write from out of the editorial decision.
 *
 * The editorial result already resolved the full Phase 7 object into
 * `decision.candidate` — no index arithmetic here, deliberately, since redoing
 * the lookup would be a second chance to get the off-by-one wrong. A publish
 * decision that arrives without a usable candidate is a caller bug (the two
 * should never diverge), so this throws rather than failing the model.
 *
 * @throws {GenerationInputError}
 */
function resolveCandidate(decision) {
  const candidate = decision?.candidate;
  const missing = ['title', 'url'].filter((field) => !String(candidate?.[field] || '').trim());
  if (!candidate || missing.length) {
    throw new GenerationInputError(
      `Publish decision is missing a usable candidate (${missing.length ? `missing ${missing.join(', ')}` : 'no candidate'}).`,
      'invalid_candidate',
      { missing }
    );
  }
  return candidate;
}

/**
 * Generate a final post from an editorial decision.
 *
 * @param {object} decision a Phase 9 editorial result (evaluateCandidates output)
 * @param {{
 *   persona?: object,
 *   platform?: string,
 *   provider?: object,
 *   agentId?: string,
 *   now?: number,
 *   timeoutMs?: number,
 * }} [options] Every knob is injectable so tests never touch env or the network.
 * @returns {Promise<object>} a generation result; a skip and a failure are results, not throws
 * @throws {GenerationInputError} only for caller bugs (bad decision object, unknown platform)
 */
export async function generatePost(decision, options = {}) {
  const {
    persona = {},
    platform: platformId = DEFAULT_PLATFORM,
    provider: injected,
    agentId,
    now = Date.now(),
    timeoutMs,
  } = options;

  const startedAt = now;

  // 0. Validate the caller's input. A malformed decision is a bug in the
  //    surrounding code, not a model failure, so it throws.
  if (!decision || typeof decision !== 'object' || typeof decision.decision !== 'string') {
    throw new GenerationInputError(
      'generatePost requires an editorial decision object with a decision field.',
      'invalid_editorial_decision'
    );
  }

  // Resolve the platform up front: an unknown platform is a config bug and
  // throws (getPlatform), before any skip/publish branching.
  const platform = getPlatform(platformId);

  // 1. The editorial gate. Anything other than publish produces a SKIP with zero
  //    generation calls. We never write a post for a decision that said not to.
  if (decision.decision !== PUBLISH) {
    log.info('No post generated: the editorial decision was not to publish', {
      agentId, decision: decision.decision, platform: platform.id,
    });
    return generationResult({
      status: 'skipped',
      code: GENERATION_ERROR_CODES.NOT_ALLOWED,
      message: `Editorial decision was "${decision.decision}", so no post was generated.`,
      platform: platform.id,
      decision,
      llmCalls: 0,
      agentId,
      startedAt,
      now,
    });
  }

  // 2. The candidate to write from. Throws on a malformed publish decision.
  const candidate = resolveCandidate(decision);

  // 3. Bounded payload. Reuse Phase 8's compacting and its guard — one candidate,
  //    but the same path, so the post writer can never be handed more than the
  //    editorial layer could. assertBounded is a guard, not a trim.
  const [compactCandidate] = compactCandidates([candidate], { limit: 1 });
  assertBounded([compactCandidate]);

  const prompt = buildPostPrompt({
    persona,
    candidate: compactCandidate,
    decision,
    platform,
  });
  const schema = buildGenerationSchema(platform);
  const llm = injected || getLlmProvider();

  log.info(`Writing a ${platform.label} post`, {
    agentId,
    provider: llm.name,
    model: llm.model,
    promptChars: prompt.length,
    candidate: String(candidate.title || '').slice(0, 80),
  });

  const attemptsBefore = llm.usage?.calls ?? 0;
  // Counted locally, exactly like the editorial layer: usage counts transport
  // attempts, so one generation call that retried a 429 would otherwise report
  // as two and the exactly-one-call test would measure the wrong thing.
  let llmCalls = 0;
  let response;

  // 4. Exactly one call. A transport failure ends the attempt: retrying with a
  //    different prompt would double the cost and hand the model another chance
  //    to produce output we would not trust anyway.
  try {
    llmCalls += 1;
    response = await llm.generateJSON(prompt, {
      schema,
      systemInstruction: GENERATION_SYSTEM_PROMPT,
      ...(timeoutMs ? { timeoutMs } : {}),
      // Only the mock reads this, and only when a test has not scripted it.
      // A schema-synthesized post cannot satisfy the platform and source rules
      // verifyGeneratedPost enforces, so generation supplies its own default.
      fallbackScript: generationMockScript,
    });
  } catch (error) {
    if (!(error instanceof LlmError)) throw error; // a real bug, not a provider failure
    const code = mapLlmErrorCode(error.code);
    // error.message is already redacted by the LLM layer; never surface raw provider text.
    log.error(`Generation call failed (${error.code} -> ${code})`, {
      agentId, provider: llm.name, model: llm.model,
    });
    return generationResult({
      status: 'failed',
      code,
      message: `The post could not be written this cycle (${code}).`,
      details: [`llm_error:${error.code}`],
      platform: platform.id,
      decision,
      llmCalls,
      llmAttempts: (llm.usage?.calls ?? attemptsBefore) - attemptsBefore,
      usage: llm.usage?.snapshot?.() ?? null,
      provider: llm.name,
      model: llm.model,
      warnings: [`generation_call_failed:${code}`],
      agentId,
      startedAt,
      now,
    });
  }

  const provenance = {
    platform: platform.id,
    decision,
    llmCalls,
    llmAttempts: (llm.usage?.calls ?? attemptsBefore) - attemptsBefore,
    usage: llm.usage?.snapshot?.() ?? null,
    provider: llm.name,
    model: llm.model,
    agentId,
    startedAt,
    now,
  };

  // 5. Verify independently and assemble the FinalPost. The schema proved shape;
  //    this proves the post is publishable and cites only the candidate's source.
  //    Any GenerationError here is a failed result, never a thrown exception and
  //    never a repaired post.
  let post;
  try {
    post = verifyGeneratedPost(response.data, { candidate, platform });
  } catch (error) {
    if (!(error instanceof GenerationError)) throw error; // unexpected: let it surface
    log.warn('Generated post failed verification; nothing was produced this cycle', {
      agentId, code: error.code, problems: error.details?.slice?.(0, 5) ?? [],
    });
    return generationResult({
      status: 'failed',
      code: error.code,
      message: error.message,
      details: (error.details?.length ? error.details : [error.message]).slice(0, 10),
      warnings: [`generation_verification_failed:${error.code}`],
      ...provenance,
    });
  }

  log.info('Post written and verified', {
    agentId,
    platform: platform.id,
    characterCount: post.characterCount,
    hashtags: post.hashtags.length,
    sources: post.sourceUrls.length,
  });

  return generationResult({
    status: 'generated',
    post,
    message: `Wrote a ${post.characterCount}-character ${platform.label} post.`,
    ...provenance,
  });
}

export {
  GENERATION_ERROR_CODES,
  GenerationError,
  GenerationInputError,
  mapLlmErrorCode,
} from './errors.js';
export {
  PLATFORMS,
  PLATFORM_IDS,
  DEFAULT_PLATFORM,
  getPlatform,
  isSupportedPlatform,
} from './platforms.js';
export {
  GENERATION_FIELDS,
  FINAL_POST_FIELDS,
  buildGenerationSchema,
  buildFinalPostSchema,
  validateFinalPost,
  isValidHashtag,
  isHttpUrl,
} from './schema.js';
export { GENERATION_SYSTEM_PROMPT, buildPostPrompt } from './prompt.js';
export { verifyGeneratedPost, allowedSourceUrls, findFabricatedUrls } from './verify.js';
export { generationMockScript } from './mockScript.js';
