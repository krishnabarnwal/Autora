/**
 * Phase 9 — autonomous editorial judgement.
 *
 * One question, once per cycle: given this shortlist and this persona, which
 * story should the agent publish about, or should it publish nothing?
 *
 * The pipeline:
 *
 *   Phase 7 discoverTopics()  ->  candidates
 *   precheck                  ->  cheap local skip, or a clean list
 *   compactCandidates()       ->  bounded payload (Phase 8 owns the bound)
 *   ONE generateJSON() call   ->  schema-valid decision
 *   verifyDecision()          ->  trusted decision + resolved candidate
 *   confidence gate           ->  final decision
 *
 * Two rules shape the whole file. First, exactly one LLM call per cycle: no
 * per-candidate scoring, no retry-with-a-different-prompt, no second opinion.
 * Second, an invalid decision is a skipped cycle, never a repaired decision —
 * silently patching model output is how a wrong story gets published with a
 * confident rationale attached.
 *
 * No publishing happens here. This returns a decision; Phase 10 writes the post.
 */
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { getLlmProvider } from '../llm/index.js';
import { compactCandidates, assertBounded } from '../llm/candidates.js';
import { LlmError } from '../llm/errors.js';
import { DECISIONS, DECISION_SOURCES, buildDecisionSchema, localDecision } from './schema.js';
import { SYSTEM_PROMPT, buildEditorialPrompt } from './prompt.js';
import { precheckCandidates, EditorialInputError } from './precheck.js';
import { verifyDecision, EditorialDecisionError } from './verify.js';
import { editorialMockScript } from './mockScript.js';

const log = logger('EDITOR');

/**
 * Shape the result so Phase 10 needs no index arithmetic and no re-derivation.
 *
 * `candidate` is the resolved Phase 7 object, not the compacted one: the post
 * writer needs the full record, and making it look the index up again would be
 * a second chance to get the off-by-one wrong.
 */
function decisionResult({
  decision, candidate = null, index = null, source,
  llmCalls = 0, llmAttempts = 0, usage = null, provider = null, model = null,
  warnings = [], startedAt = 0, now = Date.now(),
  candidatesConsidered = 0,
}) {
  return {
    decision: decision.decision,
    selectedCandidateIndex: index,
    candidate,
    confidence: decision.confidence,
    reason: decision.reason,
    angle: decision.decision === DECISIONS.PUBLISH ? decision.angle : null,
    evidence: decision.evidence || [],
    rejectionReasons: decision.rejectionReasons || [],

    // Provenance. The dashboard has to be able to show that a skip was a real
    // editorial judgement rather than a swallowed error, and vice versa.
    source,
    /** Editorial calls made this cycle. The one-call-per-cycle rule is about this. */
    llmCalls,
    /** Transport attempts, so a retried 429 stays visible instead of averaging out. */
    llmAttempts,
    usage,
    provider,
    model,
    warnings,
    candidatesConsidered,
    durationMs: startedAt ? Math.max(0, now - startedAt) : 0,
    decidedAt: new Date(now).toISOString(),
  };
}

/**
 * Judge a shortlist of candidates.
 *
 * @param {object[]} candidates Phase 7 candidates, at most `maxCandidates`
 * @param {{
 *   persona?: object,
 *   provider?: object,
 *   maxCandidates?: number,
 *   minConfidence?: number,
 *   allowSkip?: boolean,
 *   minRelevance?: number,
 *   agentId?: string,
 *   now?: number,
 *   timeoutMs?: number,
 * }} [options] Every knob is injectable so tests never touch env or the network.
 * @returns {Promise<object>} the editorial decision, never a published post
 * @throws {EditorialInputError} when the caller supplied malformed input
 */
export async function evaluateCandidates(candidates, options = {}) {
  const {
    persona = {},
    provider: injected,
    maxCandidates = config.editorial.maxCandidates,
    minConfidence = config.editorial.minConfidence,
    allowSkip = config.editorial.allowSkip,
    minRelevance,
    agentId,
    now = Date.now(),
    timeoutMs,
  } = options;

  const startedAt = now;
  const warnings = [];

  // 1. Deterministic precheck. Throws on caller bugs; returns a decision when
  //    the answer is already known and no call is warranted.
  const pre = precheckCandidates(candidates, {
    maxCandidates,
    ...(minRelevance === undefined ? {} : { minRelevance }),
  });

  if (pre.issues.length) {
    warnings.push(...pre.issues);
    log.warn(`Precheck flagged ${pre.issues.length} candidate issue(s)`, {
      agentId, dropped: pre.dropped, issues: pre.issues.slice(0, 5),
    });
  }

  if (pre.decision) {
    log.info('Skipped without an LLM call', {
      agentId, reason: pre.decision.reason, supplied: Array.isArray(candidates) ? candidates.length : 0,
    });
    return decisionResult({
      decision: pre.decision,
      source: DECISION_SOURCES.PRECHECK,
      llmCalls: 0,
      warnings,
      startedAt,
      now,
      candidatesConsidered: 0,
    });
  }

  const usable = pre.candidates;

  // 2. Bounded payload. Phase 8 owns both functions; neither is bypassed, and
  //    assertBounded is a guard rather than a trim, so an oversized prompt is a
  //    loud failure instead of a surprise bill.
  const compacted = compactCandidates(usable, { limit: maxCandidates });
  const bounds = assertBounded(compacted);

  const prompt = buildEditorialPrompt({ persona, candidates: compacted, allowSkip });
  const schema = buildDecisionSchema(compacted.length);
  const llm = injected || getLlmProvider();

  log.info(`Judging ${compacted.length} candidate(s)`, {
    agentId,
    provider: llm.name,
    model: llm.model,
    promptChars: prompt.length,
    payloadChars: bounds.chars,
  });

  const attemptsBefore = llm.usage?.calls ?? 0;
  // Counted here rather than read from usage: usage counts transport attempts,
  // so a single editorial call that retried a 429 would otherwise report as two
  // and the one-call-per-cycle test would be measuring the wrong thing.
  let llmCalls = 0;
  let response;

  // 3. Exactly one call. A failure here ends the cycle: retrying with a
  //    different prompt would double the cost and give the model a second
  //    chance to produce something we already decided not to trust.
  try {
    llmCalls += 1;
    response = await llm.generateJSON(prompt, {
      schema,
      systemInstruction: SYSTEM_PROMPT,
      ...(timeoutMs ? { timeoutMs } : {}),
      // Only the mock reads this, and only when a test has not scripted it.
      // Needed because a schema-synthesized decision cannot satisfy the
      // cross-field rules verify.js enforces. See mockScript.js.
      fallbackScript: editorialMockScript,
    });
  } catch (error) {
    const code = error instanceof LlmError ? error.code : 'unknown';
    // error.message is already redacted by the LLM layer.
    log.error(`Editorial call failed (${code}); skipping this cycle`, {
      agentId, provider: llm.name, model: llm.model,
    });
    return decisionResult({
      decision: localDecision({
        reason: `The editorial model could not be consulted this cycle (${code}), so nothing was published.`,
        rejectionReasons: [`Editorial call failed: ${code}`],
        confidence: 0,
        source: DECISION_SOURCES.PRECHECK,
      }),
      source: DECISION_SOURCES.PRECHECK,
      llmCalls,
      llmAttempts: (llm.usage?.calls ?? attemptsBefore) - attemptsBefore,
      usage: llm.usage?.snapshot?.() ?? null,
      provider: llm.name,
      model: llm.model,
      warnings: [...warnings, `editorial_call_failed:${code}`],
      startedAt,
      now,
      candidatesConsidered: compacted.length,
    });
  }

  const usage = llm.usage?.snapshot?.() ?? null;
  const provenance = {
    llmCalls,
    llmAttempts: (llm.usage?.calls ?? attemptsBefore) - attemptsBefore,
    usage,
    provider: llm.name,
    model: llm.model,
    startedAt,
    now,
    candidatesConsidered: compacted.length,
  };

  // 4. Verify independently. The schema proved shape; this proves the decision
  //    means something and points at a candidate we actually supplied.
  let verified;
  try {
    verified = verifyDecision(response.data, compacted, usable);
  } catch (error) {
    if (!(error instanceof EditorialDecisionError)) throw error;
    log.warn('Rejected the model decision; publishing nothing this cycle', {
      agentId, code: error.code, problems: error.details?.slice?.(0, 5) ?? [],
    });
    return decisionResult({
      decision: localDecision({
        reason: 'The editorial decision failed verification, so nothing was published this cycle.',
        rejectionReasons: (error.details?.length ? error.details : [error.message]).slice(0, 10),
        confidence: 0,
        source: DECISION_SOURCES.PRECHECK,
      }),
      source: DECISION_SOURCES.PRECHECK,
      warnings: [...warnings, `decision_rejected:${error.code}`],
      ...provenance,
    });
  }

  const { decision, candidate, index } = verified;

  if (decision.decision === DECISIONS.SKIP) {
    // The model declined. Honour it unless the operator has disabled declining.
    if (!allowSkip) {
      // The prompt already told the model to publish, so reaching here means it
      // declined anyway. Falling back to the top-ranked candidate is Phase 7's
      // arithmetic rather than editorial judgement, and the result says so.
      const fallback = usable[0];
      log.warn('Model declined but EDITORIAL_ALLOW_SKIP=false; falling back to the top-ranked candidate', {
        agentId, confidence: decision.confidence,
      });
      return decisionResult({
        decision: {
          ...decision,
          decision: DECISIONS.PUBLISH,
          angle: 'Straight report of the most significant item available this cycle.',
          reason: `Forced publish (EDITORIAL_ALLOW_SKIP=false). The editor declined: ${decision.reason}`,
        },
        candidate: fallback,
        index: 1,
        source: DECISION_SOURCES.FORCED_PUBLISH,
        warnings: [...warnings, 'forced_publish_overrode_skip'],
        ...provenance,
      });
    }

    log.info('Editorial decision: skip', {
      agentId, confidence: decision.confidence, reason: decision.reason,
    });
    return decisionResult({
      decision, source: DECISION_SOURCES.LLM, warnings, ...provenance,
    });
  }

  // 5. Confidence gate. The model's number is an editorial signal, not a
  //    calibrated probability — which is exactly why the threshold is ours and
  //    a publish below it becomes a skip rather than a warning on a post.
  if (decision.confidence < minConfidence) {
    log.info(`Editorial confidence ${decision.confidence} is below the ${minConfidence} floor; skipping`, {
      agentId, candidate: candidate.title?.slice(0, 80),
    });
    return decisionResult({
      decision: {
        ...decision,
        decision: DECISIONS.SKIP,
        selectedCandidateIndex: null,
        angle: null,
        reason: `Below the ${minConfidence} confidence floor (${decision.confidence}). ${decision.reason}`,
      },
      candidate: null,
      index: null,
      source: DECISION_SOURCES.CONFIDENCE_GATE,
      warnings: [...warnings, 'below_confidence_floor'],
      ...provenance,
    });
  }

  log.info('Editorial decision: publish', {
    agentId,
    candidateIndex: index,
    confidence: decision.confidence,
    title: candidate.title?.slice(0, 80),
    source: candidate.source,
  });

  return decisionResult({
    decision, candidate, index, source: DECISION_SOURCES.LLM, warnings, ...provenance,
  });
}

export {
  DECISIONS,
  DECISION_SOURCES,
  buildDecisionSchema,
  localDecision,
} from './schema.js';
export { SYSTEM_PROMPT, buildEditorialPrompt } from './prompt.js';
export { precheckCandidates, inspectCandidate, EditorialInputError } from './precheck.js';
export { verifyDecision, findFabrications, EditorialDecisionError } from './verify.js';
export { editorialMockScript } from './mockScript.js';
