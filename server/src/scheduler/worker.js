/**
 * Phase 12 — CycleWorker: WHEN a single agent's cycles run.
 *
 * runCycle owns WHAT a cycle does; the worker owns the clock around it:
 *
 *   - Immediate first cycle. start() schedules the first tick at bootDelayMs
 *     (0 by default), never after a full interval — a freshly registered or
 *     resumed agent produces something on its first heartbeat.
 *   - No overlap. A `running` guard means one agent never has two cycles in
 *     flight; the next tick is scheduled only in the finally of the current one.
 *   - Failure never kills the scheduler. runCycle is designed to *return*
 *     failures; the worker wraps it anyway so even an unexpected throw becomes a
 *     returned failed result, is counted, and is backed off on — the timer loop
 *     survives.
 *   - Exponential backoff with reset. After a failed cycle the delay doubles
 *     (interval, 2×, 4×, …) up to maxBackoffMs, and resets to the base cadence
 *     on the first success. The math is a pure function so it is unit-tested
 *     without any timer.
 *   - Single writer. The worker folds runCycle's stat *deltas*, the timing, the
 *     status, and any backoff into exactly one Agent update per cycle. runCycle
 *     never touches the Agent's scheduling fields.
 *   - Durable history. Because it is the single writer, it is also the only place
 *     that opens and closes a CycleRun — one permanent row per execution, so the
 *     record that an agent ran survives the restart that clears the activity
 *     buffer. History is bookkeeping: every write to it is wrapped so a failed
 *     insert can never stop the agent from working.
 *
 * Secret safety: the only free-form-ish value that could reach durable Agent
 * state is lastError.message, so it is built solely from runCycle's controlled
 * {stage, code} enums, each pushed through sanitizeToken — never a raw error
 * message, which could carry a connection string or key. The same rule governs
 * every string this file writes to a CycleRun.
 */
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { Agent, CycleRun, CYCLE_RUN_DECISIONS, CYCLE_RUN_OUTCOMES } from '../models/index.js';
import { newCycleId } from '../utils/ids.js';
import { runCycle as defaultRunCycle, OUTCOME } from '../services/agent/runCycle.js';

const log = logger('SCHEDULER');

/** Fallback ceiling when config/override is missing or nonsensical. */
export const DEFAULT_MAX_BACKOFF_MS = 30 * 60 * 1000;

/**
 * Pure backoff calculation — no timers, no state, so tests drive it with a table.
 *
 *   consecutiveFailures <= 0 -> the healthy cadence (cycleIntervalMs)
 *   consecutiveFailures  = 1 -> cycleIntervalMs           (first retry at base)
 *   consecutiveFailures  = 2 -> cycleIntervalMs * 2
 *   consecutiveFailures  = n -> min(cycleIntervalMs * 2^(n-1), maxBackoffMs)
 *
 * A huge failure count makes 2^(n-1) overflow to Infinity; interval is finite
 * and positive, so the product is Infinity and Math.min clamps it to the ceiling
 * (never NaN). Deliberately allowed to exceed cycleIntervalMs.
 */
export function calculateBackoffDelay(consecutiveFailures, cycleIntervalMs, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS) {
  const interval = Number.isFinite(cycleIntervalMs) && cycleIntervalMs > 0
    ? cycleIntervalMs
    : config.agent.cycleIntervalMs;
  const ceiling = Number.isFinite(maxBackoffMs) && maxBackoffMs > 0
    ? maxBackoffMs
    : DEFAULT_MAX_BACKOFF_MS;
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 0) return interval;
  const raw = interval * 2 ** (consecutiveFailures - 1);
  return Math.min(raw, ceiling);
}

/**
 * Reduce a value to a short, credential-free identifier. lastError.message is
 * assembled only from these, so even a future code path that leaked a raw string
 * into an error's stage/code could not write a secret to Agent state.
 */
function sanitizeToken(value) {
  return String(value ?? 'unknown').replace(/[^a-z0-9_.-]/gi, '').slice(0, 40) || 'unknown';
}

/** Real reload/persist seams. Tests inject fakes; production binds to Agent. */
const defaultReload = (agentId) => Agent.findOne({ agentId });
const defaultPersist = (agentId, update) => Agent.updateOne({ agentId }, update);

/** Real history seams, one row per cycle keyed by the worker's own cycleId. */
const defaultOpenCycleRun = (record) => CycleRun.create(record);
const defaultCloseCycleRun = (cycleId, update) => CycleRun.updateOne({ cycleId }, { $set: update });

/** A measured number, or null when nothing was measured. Never a stand-in zero. */
function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/** A value the CycleRun schema knows, or null. Keeps an unexpected code out of an enum field. */
function enumOrNull(value, allowed) {
  return allowed.includes(value) ? value : null;
}

/**
 * A provider/model *name* for the history row: configuration, not a credential.
 * Bounded because updateOne does not run schema validators, so maxlength would
 * not be enforced on the way in.
 */
function boundedName(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}

/**
 * The provider failure this cycle actually hit, if any — including one the
 * pipeline absorbed on purpose.
 *
 * Read only from codes the services themselves reported: the editorial layer
 * appends `editorial_call_failed:<code>` to its warnings when a call fails and
 * it falls back to a local skip, and generation reports `status: 'failed'` with
 * its own code. Neither of those makes the cycle a scheduler failure, and this
 * function does not change that — it only stops a rate-limited agent from
 * looking perfectly healthy in its own history.
 */
export function providerFailureCodeOf(result) {
  const warnings = result?.editorial?.warnings;
  if (Array.isArray(warnings)) {
    for (const warning of warnings) {
      const match = /^editorial_call_failed:(.+)$/.exec(String(warning ?? ''));
      if (match) return sanitizeToken(match[1]);
    }
  }
  if (result?.generation?.status === 'failed') {
    return sanitizeToken(result.generation.code || 'generation_failed');
  }
  return null;
}

/**
 * One agent's autonomous timer loop. Construct one per agent (the scheduler owns
 * the registry), call start() to begin, stop() to end. Every collaborator is an
 * injectable seam so the whole loop can be tested with a fake clock and no DB.
 */
export class CycleWorker {
  /**
   * @param {string} agentId the agent this worker drives.
   * @param {{
   *   provider?: object,
   *   runCycleFn?: Function,
   *   reload?: (agentId: string) => Promise<object|null>,
   *   persist?: (agentId: string, update: object) => Promise<unknown>,
   *   openCycleRun?: (record: object) => Promise<unknown>,
   *   closeCycleRun?: (cycleId: string, update: object) => Promise<unknown>,
   *   newId?: () => string,
   *   now?: () => number,
   *   setTimer?: (fn: Function, ms: number) => unknown,
   *   clearTimer?: (handle: unknown) => void,
   *   cycleIntervalMs?: number,
   *   maxBackoffMs?: number,
   *   bootDelayMs?: number,
   *   logger?: object,
   * }} [options]
   */
  constructor(agentId, options = {}) {
    if (!agentId) throw new Error('CycleWorker requires an agentId');
    const {
      provider,
      runCycleFn = defaultRunCycle,
      reload = defaultReload,
      persist = defaultPersist,
      openCycleRun = defaultOpenCycleRun,
      closeCycleRun = defaultCloseCycleRun,
      newId = newCycleId,
      now = Date.now,
      setTimer = setTimeout,
      clearTimer = clearTimeout,
      cycleIntervalMs = config.agent.cycleIntervalMs,
      maxBackoffMs = config.agent.maxBackoffMs,
      bootDelayMs = 0,
      logger: injectedLog = log,
    } = options;

    this.agentId = agentId;
    this.provider = provider;
    this.runCycleFn = runCycleFn;
    this.reload = reload;
    this.persist = persist;
    this.openCycleRun = openCycleRun;
    this.closeCycleRun = closeCycleRun;
    this.newId = newId;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.cycleIntervalMs = Number.isFinite(cycleIntervalMs) && cycleIntervalMs > 0
      ? cycleIntervalMs
      : config.agent.cycleIntervalMs;
    this.maxBackoffMs = Number.isFinite(maxBackoffMs) && maxBackoffMs > 0
      ? maxBackoffMs
      : DEFAULT_MAX_BACKOFF_MS;
    this.bootDelayMs = Math.max(0, Number.isFinite(bootDelayMs) ? bootDelayMs : 0);
    this.log = injectedLog;

    // Runtime state. `stopped` starts true: a worker does nothing until start().
    this.timer = null;
    this.stopped = true;
    this.running = false;
    this.consecutiveFailures = 0;
    this.nextDelayMs = null;
    this.lastResult = null;
  }

  /**
   * Begin the loop with an immediate first cycle (at bootDelayMs, 0 by default).
   * Idempotent: a second start() while a tick is scheduled or in flight is a
   * no-op, so a worker never runs two loops.
   */
  start() {
    if (this.timer !== null || this.running) return this;
    this.stopped = false;
    this._schedule(this.bootDelayMs);
    return this;
  }

  /** End the loop and cancel any pending tick. Idempotent. */
  stop() {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    return this;
  }

  /** Schedule the next tick unless stopped. delay is clamped to >= 0. */
  _schedule(delayMs) {
    if (this.stopped) return;
    const delay = Math.max(0, Number.isFinite(delayMs) ? delayMs : this.cycleIntervalMs);
    this.nextDelayMs = delay;
    // Return (not void) the tick promise so a fake clock can await a whole cycle;
    // production setTimeout ignores the return, and _tick never rejects.
    this.timer = this.setTimer(() => {
      this.timer = null;
      return this._tick();
    }, delay);
  }

  /**
   * One guarded pass: never overlaps, never throws out, always reschedules
   * (unless stopped). The last-resort catch means even a bug in _runOnce cannot
   * kill the loop — it becomes a backed-off retry.
   */
  async _tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    let delay = this.cycleIntervalMs;
    try {
      delay = await this._runOnce();
    } catch (err) {
      this.consecutiveFailures += 1;
      delay = calculateBackoffDelay(this.consecutiveFailures, this.cycleIntervalMs, this.maxBackoffMs);
      this.log.error('Cycle worker tick threw; backing off', {
        agentId: this.agentId,
        code: err?.code,
        consecutiveFailures: this.consecutiveFailures,
        delayMs: delay,
      });
    } finally {
      this.running = false;
      if (!this.stopped && delay !== null) this._schedule(delay);
    }
  }

  /**
   * Reload the agent, run its cycle, and fold the result into one update.
   * Returns the delay for the next tick, or null when the worker stopped itself
   * (agent gone or inactive) and must not reschedule.
   *
   * The cycleId is minted here rather than inside runCycle so the durable history
   * row can be opened *before* the work starts, under the id that will also land
   * on the cycle's log markers, its memory row and its post. runCycle accepts the
   * id as an option precisely so the two agree.
   */
  async _runOnce() {
    let agent;
    try {
      agent = await this.reload(this.agentId);
    } catch (err) {
      // A transient read failure is a backoff signal, but we cannot touch stats
      // without the document, so only the counter and the timer advance. No
      // history row either: no cycle was attempted, and a `failed` row here would
      // claim the agent tried to work when it never got that far.
      this.consecutiveFailures += 1;
      const delay = calculateBackoffDelay(this.consecutiveFailures, this.cycleIntervalMs, this.maxBackoffMs);
      this.log.warn('Could not reload agent; backing off', {
        agentId: this.agentId, code: err?.code, delayMs: delay,
      });
      return delay;
    }

    if (!agent) {
      this.log.info('Agent no longer exists; stopping its worker', { agentId: this.agentId });
      this.stop();
      return null;
    }

    const cycleId = this.newId();
    const startedAt = new Date(this.now());
    const opened = await this._openCycleRun(cycleId, startedAt);

    // `result` stays null only if _safeRunCycle itself threw, which it is built
    // not to. The finally closes the row on *every* exit path — including the
    // paused early return below — so a row can never be left `running` by an
    // orderly shutdown and later misreported as an interrupted crash.
    let result = null;
    try {
      result = await this._safeRunCycle(agent, cycleId);

      // runCycle returns PAUSED for an inactive agent without spending a call or a
      // write; stop the timer so we don't wake every interval for a no-op. The
      // scheduler re-creates the worker when the agent is resumed.
      if (result.outcome === OUTCOME.PAUSED) {
        this.log.info('Agent is not active; stopping its worker until it is resumed', {
          agentId: this.agentId,
        });
        this.stop();
        return null;
      }

      return await this._applyResult(agent, result, cycleId);
    } finally {
      if (opened) await this._closeCycleRun(cycleId, startedAt, result);
    }
  }

  /**
   * Open this cycle's durable row as `running`, before any work begins.
   *
   * Never throws, and returns whether the row exists: history is bookkeeping, and
   * an unreachable or full history collection must not stop an agent from doing
   * its actual job. A cycle whose row could not be opened simply has no history
   * entry — which is the honest outcome, and better than a row invented after the
   * fact with a guessed start time.
   */
  async _openCycleRun(cycleId, startedAt) {
    try {
      await this.openCycleRun({
        agentId: this.agentId,
        cycleId,
        status: 'running',
        startedAt,
      });
      return true;
    } catch (err) {
      this.log.warn('Could not open the cycle history row; the cycle still runs', {
        agentId: this.agentId, cycleId, code: err?.code,
      });
      return false;
    }
  }

  /**
   * Close the same row this cycle opened, in place — one execution, one row.
   * Also never throws, for the same reason.
   */
  async _closeCycleRun(cycleId, startedAt, result) {
    try {
      const completedAt = new Date(this.now());
      await this.closeCycleRun(cycleId, this._buildCycleRunUpdate(result, startedAt, completedAt));
    } catch (err) {
      this.log.warn('Could not close the cycle history row', {
        agentId: this.agentId, cycleId, code: err?.code,
      });
    }
  }

  /**
   * The durable summary of one cycle. Pure, so the mapping from a runCycle result
   * to a history row is unit-tested without a database.
   *
   * Two separate axes, deliberately not collapsed:
   *
   *   status  — did the cycle complete its work? `failed` only when runCycle said
   *             so. A provider 429 that the editorial layer turns into a local
   *             skip is a *completed* cycle with outcome `idle`, exactly as the
   *             scheduler already treats it; that rate limit is recorded in
   *             providerFailureCode instead, where it is visible without being
   *             promoted into a failure it never was.
   *   outcome — what came of the work: published, duplicate, idle, failed, paused.
   *
   * Every metric is copied only when the pipeline measured it. A cycle that
   * exited before discovery leaves the counts null rather than writing zeros that
   * would read as "it looked and found nothing".
   */
  _buildCycleRunUpdate(result, startedAt, completedAt) {
    const failed = result === null || Boolean(result.failed);
    const update = {
      status: failed ? 'failed' : 'completed',
      outcome: enumOrNull(result?.outcome, CYCLE_RUN_OUTCOMES),
      completedAt,
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      decision: enumOrNull(result?.editorial?.decision, CYCLE_RUN_DECISIONS),
      decisionScore: finiteOrNull(result?.editorial?.confidence),
      provider: boundedName(result?.editorial?.provider ?? result?.generation?.provider, 60),
      model: boundedName(result?.editorial?.model ?? result?.generation?.model, 120),
      postId: result?.publisher?.postId ?? null,
      providerFailureCode: providerFailureCodeOf(result),
      failureCode: failed ? sanitizeToken(result?.errors?.[0]?.code) : null,
      failureMessage: failed ? this._safeErrorMessage(result?.errors) : null,
    };

    const s = result?.stats;
    for (const key of [
      'topicsDiscovered',
      'topicsAfterFilter',
      'topicsRejected',
      'topicsSelected',
      'postsPublished',
      'llmCalls',
    ]) {
      update[key] = finiteOrNull(s?.[key]);
    }

    return update;
  }

  /**
   * Run the cycle so a throw can never propagate. runCycle is built to *return*
   * failures, so reaching the catch means an unexpected bug (or a CycleInputError
   * from a malformed agent) — either way it becomes a returned failed result,
   * carrying the cycleId of the row that is already open for it.
   */
  async _safeRunCycle(agent, cycleId) {
    try {
      return await this.runCycleFn(agent, { provider: this.provider, cycleId });
    } catch (err) {
      this.log.error('runCycle threw unexpectedly; treating the cycle as failed', {
        agentId: this.agentId, name: err?.name, code: err?.code,
      });
      return {
        agentId: agent.agentId,
        cycleId,
        outcome: OUTCOME.FAILED,
        failed: true,
        stats: null,
        errors: [{ stage: 'cycle', code: err?.code || 'cycle_threw' }],
      };
    }
  }

  /**
   * The single writer. Advances or resets the failure counter, computes the next
   * delay, and persists exactly one Agent update folding stat deltas, timing,
   * status, and (on failure) a sanitized lastError. A persist miss is logged and
   * swallowed — the content already succeeded or failed on its own merits.
   */
  async _applyResult(agent, result, cycleId = null) {
    const at = new Date(this.now());

    if (result.failed) this.consecutiveFailures += 1;
    else this.consecutiveFailures = 0;

    const delay = calculateBackoffDelay(this.consecutiveFailures, this.cycleIntervalMs, this.maxBackoffMs);
    const nextCycleAt = new Date(at.getTime() + delay);
    const update = this._buildUpdate(result, at, nextCycleAt);

    try {
      await this.persist(this.agentId, update);
    } catch (err) {
      this.log.warn('Could not persist cycle result; continuing', {
        agentId: this.agentId, code: err?.code,
      });
    }

    this.lastResult = result;
    this.log.info('Cycle complete', {
      agentId: this.agentId,
      // The id this worker minted for the cycle: the one it handed to runCycle,
      // the one runCycle logged on 'Cycle started', the one on this cycle's
      // memory row and post, and the key of its history row. Without it the
      // closing marker could only be matched to its opening one by position in
      // the buffer, which silently misattributes as soon as two agents' cycles
      // interleave. Null only on a path that never reached a cycle at all, and
      // it stays null rather than being invented.
      cycleId: cycleId ?? null,
      outcome: result.outcome,
      failed: Boolean(result.failed),
      consecutiveFailures: this.consecutiveFailures,
      nextDelayMs: delay,
    });
    return delay;
  }

  /** Build the one-and-only Agent update for a completed cycle. */
  _buildUpdate(result, at, nextCycleAt) {
    const inc = { 'stats.cyclesRun': 1 };
    if (result.failed) inc['stats.cyclesFailed'] = 1;

    // Fold runCycle's stat deltas (null on a pre-discovery exit). Only non-zero
    // deltas are incremented, keeping the update minimal.
    const s = result.stats;
    if (s) {
      for (const [key, field] of [
        ['topicsDiscovered', 'stats.topicsDiscovered'],
        ['topicsAfterFilter', 'stats.topicsAfterFilter'],
        ['topicsRejected', 'stats.topicsRejected'],
        ['topicsSelected', 'stats.topicsSelected'],
        ['postsPublished', 'stats.postsPublished'],
        ['llmCalls', 'stats.llmCalls'],
      ]) {
        if (Number.isFinite(s[key]) && s[key] !== 0) inc[field] = s[key];
      }
    }

    const set = {
      lastCycleAt: at,
      nextCycleAt,
      status: result.failed ? 'error' : 'autonomous',
      // The cadence this worker is actually sleeping on, folded into the write
      // that already happens every cycle (no second query).
      //
      // configuration.cycleIntervalMs defaults from config at *document
      // creation* and then never moves, while the worker reads config at
      // *construction*. Change AGENT_CYCLE_INTERVAL_MS and the two diverge
      // permanently: an agent created under the 45s demo default kept reporting
      // "cycle every 45s" through the API while its worker slept 90 minutes.
      // The dashboard reads this field, so it was the number judges saw.
      //
      // Env is deliberately the winner. The cadence is set to 5,400,000ms to fit
      // the free-tier Gemini quota (see env.js), and honouring a stale 45s from
      // an old document would spend a day's quota in a quarter of an hour.
      'configuration.cycleIntervalMs': this.cycleIntervalMs,
    };
    if (result.failed) {
      set['lastError.message'] = this._safeErrorMessage(result.errors);
      set['lastError.at'] = at;
    }

    return { $set: set, $inc: inc };
  }

  /**
   * A durable failure message built solely from controlled {stage, code} enums,
   * each sanitized. Never includes a raw error message — that could carry a URI
   * or key. Capped so a pathological error list cannot bloat the document.
   */
  _safeErrorMessage(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return 'Cycle failed';
    const parts = errors.map((e) => `${sanitizeToken(e?.stage)}:${sanitizeToken(e?.code)}`);
    const message = `Cycle failed [${parts.join(', ')}]`;
    return message.length > 300 ? `${message.slice(0, 297)}...` : message;
  }
}

