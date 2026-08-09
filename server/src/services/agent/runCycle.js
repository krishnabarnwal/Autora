/**
 * Phase 12 — runCycle: WHAT one autonomous cycle does.
 *
 * Composes the Phase 1–11 services into a single publishing pass, without
 * rewriting any of them:
 *
 *   discoverTopics()        local topic pipeline (0 LLM calls)
 *     per candidate:
 *       checkRepetition()   advisory memory gate (0 LLM calls)
 *         BLOCKED     -> dropped: no editorial call, no generation, no publish
 *         DISCOURAGED -> kept, ordered below fresh ALLOWED candidates
 *         ALLOWED     -> kept
 *     evaluateCandidates()  LLM CALL #1 (exactly one)
 *     generatePost()        LLM CALL #2 (only on a publish decision)
 *     publishFinalPost()    the Post + its published memory (0 LLM calls)
 *     recordDecision()      the non-published candidate's audit row (0 LLM calls)
 *
 * The hard budget: at most two LLM calls per cycle, and zero for a cycle whose
 * candidates are all BLOCKED (or empty). runCycle never decides *when* a cycle
 * runs — the worker owns that — so it never reads or writes the Agent's
 * scheduling fields and never runs a timer. It reads the agent document handed
 * to it and persists only the content the pipeline produces (the Post and its
 * memory rows). It returns stat *deltas*; the worker is the single writer that
 * folds them, the timing, and any backoff into one Agent update.
 *
 * Every failure the composed services are designed to absorb is *returned*,
 * never thrown: a failed editorial call, a failed generation, a failed publish,
 * a degraded memory read — each becomes a named result the worker can tally and
 * back off on. runCycle throws only when handed something unfit (a missing
 * agent), which is a caller bug, not a cycle outcome.
 */
import { logger } from '../../utils/logger.js';
import { newCycleId } from '../../utils/ids.js';
import { discoverTopics } from '../topics/index.js';
import { checkRepetition, recordDecision } from '../memory/index.js';
import { evaluateCandidates, DECISIONS } from '../editorial/index.js';
import { generatePost } from '../generation/index.js';
import { publishFinalPost } from '../publisher/index.js';

const log = logger('AGENT');

/**
 * The composed Phase 1–11 services, in one injectable object. Real imports are
 * the defaults; a test overrides a single entry to force a stage's failure — a
 * throwing publish, a degraded memory read — without a broken database or a
 * network. runCycle calls the services only through this object.
 */
export const DEFAULT_SERVICES = Object.freeze({
  discoverTopics,
  checkRepetition,
  evaluateCandidates,
  generatePost,
  publishFinalPost,
  recordDecision,
});

/** How the repetition gate sorted a candidate. */
export const GATE = Object.freeze({
  BLOCKED: 'blocked',
  DISCOURAGED: 'discouraged',
  ALLOWED: 'allowed',
});

/** The cycle's coarse outcome. `failed` (not this) is what the worker backs off on. */
export const OUTCOME = Object.freeze({
  /** A new post was created this cycle. */
  PUBLISHED: 'published',
  /** The chosen topic was already on the feed; nothing new was written. */
  DUPLICATE: 'duplicate',
  /** A healthy cycle that published nothing (editor skipped / no viable topic). */
  IDLE: 'idle',
  /** The agent was not active, so no cycle ran. */
  PAUSED: 'paused',
  /** The cycle could not complete — the worker should back off. */
  FAILED: 'failed',
});

/** A caller bug: runCycle was handed something it cannot run. Thrown, not returned. */
export class CycleInputError extends Error {
  constructor(message, code = 'invalid_cycle_input') {
    super(message);
    this.name = 'CycleInputError';
    this.code = code;
  }
}

/** Statuses on which the worker must not run a cycle. */
const INACTIVE_STATUSES = new Set(['paused', 'removed']);

/** Map a memory-gate status onto the coarse gate bucket. */
function gateFor(status) {
  if (status === 'blocked') return GATE.BLOCKED;
  if (status === 'discouraged') return GATE.DISCOURAGED;
  return GATE.ALLOWED;
}

/** True for an editorial result that decided *not* to publish. */
function isNonPublish(editor) {
  return editor?.decision !== DECISIONS.PUBLISH;
}

/**
 * One result shape for every exit path, so the worker and the tests can read the
 * same fields no matter where the cycle stopped. `stats` is null only when the
 * cycle never reached discovery.
 */
function buildResult({
  agentId, cycleId = null, outcome, failed = false, providerCalls = 0,
  publisher = null, editorial = null, generation = null, memory = null,
  stats = null, errors = [],
}) {
  return {
    agentId, cycleId, outcome, failed, providerCalls,
    publisher, editorial, generation, memory, stats, errors,
  };
}

/** Empty stat block for a cycle that discovered candidates but published none. */
function statBlock({ discovered = 0, afterFilter = 0, rejected = 0, selected = 0, published = 0, llmCalls = 0 }) {
  return {
    topicsDiscovered: discovered,
    topicsAfterFilter: afterFilter,
    topicsRejected: rejected,
    topicsSelected: selected,
    postsPublished: published,
    llmCalls,
  };
}

/**
 * Record the cycle's non-published choice as a `deferred` audit row, so the next
 * cycle's repetition gate discourages re-judging the same topic. On a skip the
 * editorial result carries no candidate, so the top viable topic — the one the
 * cycle most nearly published — stands in for the decision. Advisory bookkeeping
 * never fails the cycle: a memory error is logged and swallowed (the DB unique
 * index, not this row, is the real duplicate guarantee).
 *
 * @returns {Promise<object|null>} the memory result, or null when there is
 *   nothing to record or the write degraded.
 */
async function recordDeferredCandidate(agentId, editor, viable, cycleId, recordFn) {
  // Nothing to record on a publish: the publisher writes that topic's memory,
  // and the candidates the editor passed over stay eligible for a later cycle.
  if (!isNonPublish(editor)) return null;
  const candidate = viable[0];
  if (!candidate?.title) return null;

  const base = editor?.reason?.trim() || 'No editorial rationale was produced.';
  try {
    const result = await recordFn(agentId, {
      decision: 'deferred',
      topic: candidate.title,
      reason: `Deferred this cycle: ${base}`,
      score: Number.isFinite(candidate.score) ? candidate.score : null,
      cycleId,
    }, { cycleId });
    log.info('Recorded a deferred candidate', { agentId, normalizedTopic: result.normalizedTopic });
    return result;
  } catch (err) {
    log.warn('Could not record the deferred candidate', {
      agentId, code: err?.code, title: String(candidate.title).slice(0, 80),
    });
    return null;
  }
}

/**
 * Run one full autonomous cycle for an agent.
 *
 * @param {object} agent a persisted Agent document (only `agentId`, `persona`,
 *   and `status` are read). Passing the document — not just an id — lets the
 *   publisher skip its existence check and proves the cycle runs for a real agent.
 * @param {{
 *   provider?: object, now?: number, cycleId?: string,
 *   discover?: object, editorial?: object, generation?: object, publish?: object,
 *   services?: object,
 * }} [options] `discover` may carry `items`/`sources` so a test keeps the cycle
 *   fully offline; `provider` is injected so a test never touches the network;
 *   `services` overrides any composed Phase 1–11 function (see DEFAULT_SERVICES).
 * @returns {Promise<object>} a runCycle result. Never throws for a cycle-level
 *   failure (that is a returned `failed:true` result); throws CycleInputError
 *   only on a caller bug.
 */
export async function runCycle(agent, options = {}) {
  const {
    provider,
    now = Date.now(),
    cycleId = newCycleId(),
    discover = {},
    editorial = {},
    generation = {},
    publish = {},
    services: serviceOverrides = {},
  } = options;

  const services = { ...DEFAULT_SERVICES, ...serviceOverrides };

  if (!agent || !agent.agentId) {
    throw new CycleInputError('runCycle requires a persisted Agent document with an agentId.');
  }
  const agentId = agent.agentId;

  if (INACTIVE_STATUSES.has(agent.status)) {
    log.info('Cycle skipped: the agent is not active', { agentId, status: agent.status });
    return buildResult({ agentId, cycleId, outcome: OUTCOME.PAUSED });
  }

  const shared = { agentId, now };
  const providerCallsBefore = provider?.calls?.length ?? 0;
  const errors = [];

  // --- Discover (0 LLM calls) -------------------------------------------------
  let discovered;
  try {
    discovered = await services.discoverTopics({ ...shared, persona: agent.persona, ...discover });
  } catch (err) {
    log.error('Topic discovery failed; nothing was published this cycle', {
      agentId, name: err?.name, code: err?.code,
    });
    return buildResult({
      agentId, cycleId, outcome: OUTCOME.FAILED, failed: true,
      errors: [{ stage: 'discover', code: err?.code || 'discover_failed' }],
    });
  }

  // --- Repetition gate (0 LLM calls) ------------------------------------------
  const checked = [];
  for (const candidate of discovered.candidates) {
    try {
      const result = await services.checkRepetition(agentId, candidate, { now });
      checked.push({ candidate, gate: gateFor(result.status) });
    } catch (err) {
      // A memory read failure must not take the feed down. Treat the topic as
      // allowed so the cycle still makes a judgement, and note the degradation.
      log.warn('Repetition check degraded; treating the candidate as allowed', {
        agentId, code: err?.code, title: String(candidate.title || '').slice(0, 80),
      });
      errors.push({ stage: 'memory', code: err?.code || 'repetition_check_failed' });
      checked.push({ candidate, gate: GATE.ALLOWED });
    }
  }

  const blockedCount = checked.filter((e) => e.gate === GATE.BLOCKED).length;
  const allowed = checked.filter((e) => e.gate === GATE.ALLOWED).map((e) => e.candidate);
  const discouraged = checked.filter((e) => e.gate === GATE.DISCOURAGED).map((e) => e.candidate);
  // DISCOURAGED candidates trail fresh ALLOWED ones but stay in the running.
  const viable = [...allowed, ...discouraged];

  if (viable.length === 0) {
    log.info('No viable candidate this cycle; publishing nothing and calling no LLM', {
      agentId, discovered: discovered.candidates.length, blocked: blockedCount,
    });
    return buildResult({
      agentId, cycleId, outcome: OUTCOME.IDLE,
      stats: statBlock({ discovered: discovered.candidates.length, rejected: blockedCount }),
      errors,
    });
  }

  // --- Editorial judgement (LLM CALL #1) --------------------------------------
  let editor;
  try {
    editor = await services.evaluateCandidates(viable, { persona: agent.persona, provider, ...shared, ...editorial });
  } catch (err) {
    // Only a caller bug (malformed input) reaches here — a real editorial
    // failure is a returned skip-shaped decision, not a throw.
    log.error('Editorial judgement threw; the cycle counts as failed', {
      agentId, name: err?.name, code: err?.code,
    });
    return buildResult({
      agentId, cycleId, outcome: OUTCOME.FAILED, failed: true,
      providerCalls: (provider?.calls?.length ?? 0) - providerCallsBefore,
      errors: [...errors, { stage: 'editorial', code: err?.code || 'editorial_failed' }],
    });
  }

  let generation_ = null;
  let publisher = null;
  let outcome = OUTCOME.IDLE;
  let failed = false;

  if (isNonPublish(editor)) {
    log.info('No post this cycle: the editor did not choose to publish', {
      agentId, decision: editor.decision, source: editor.source,
    });
  } else {
    // --- Generation (LLM CALL #2, publish path only) --------------------------
    try {
      generation_ = await services.generatePost(editor, { persona: agent.persona, provider, ...shared, ...generation });
    } catch (err) {
      log.error('Post generation threw; the cycle counts as failed', {
        agentId, name: err?.name, code: err?.code,
      });
      errors.push({ stage: 'generation', code: err?.code || 'generation_failed' });
      failed = true;
    }

    if (generation_) {
      if (generation_.status === 'generated' && generation_.post) {
        // --- Publish (0 LLM calls) --------------------------------------------
        try {
          publisher = await services.publishFinalPost(generation_.post, {
            agent,
            decision: editor,
            cycleId,
            generationMs: generation_.durationMs,
            ...publish,
          });
        } catch (err) {
          // The publisher already surfaces safe, classified errors.
          log.error('Publishing failed; nothing was added to the feed', {
            agentId, name: err?.name, code: err?.code,
          });
          errors.push({ stage: 'publish', code: err?.code || 'publish_failed' });
          failed = true;
        }
      } else if (generation_.status === 'failed') {
        // A generation failure usually means an unhealthy provider — exactly the
        // signal the worker should back off on.
        log.warn('No post generated this cycle (generation failed)', { agentId, code: generation_.code });
        errors.push({ stage: 'generation', code: generation_.code || 'generation_failed' });
        failed = true;
      } else {
        log.info('No post generated this cycle', { agentId, status: generation_.status });
      }
    }
  }

  if (publisher) {
    outcome = publisher.created ? OUTCOME.PUBLISHED : OUTCOME.DUPLICATE;
    log.info('Publishing outcome', { agentId, status: publisher.status, postId: publisher.postId });
  } else if (failed) {
    outcome = OUTCOME.FAILED;
  }

  // --- Memory for the candidate we did not publish ----------------------------
  const memory = await recordDeferredCandidate(agentId, editor, viable, cycleId, services.recordDecision);

  const providerCalls = (provider?.calls?.length ?? 0) - providerCallsBefore;
  const published = publisher?.created === true;

  return buildResult({
    agentId,
    cycleId,
    outcome,
    failed,
    providerCalls,
    publisher,
    editorial: editor,
    generation: generation_,
    memory,
    stats: statBlock({
      discovered: discovered.candidates.length,
      afterFilter: viable.length,
      rejected: blockedCount,
      selected: editor.decision === DECISIONS.PUBLISH ? 1 : 0,
      published: published ? 1 : 0,
      llmCalls: providerCalls,
    }),
    errors,
  });
}
