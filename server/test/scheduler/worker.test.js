import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CycleWorker,
  calculateBackoffDelay,
  DEFAULT_MAX_BACKOFF_MS,
} from '../../src/scheduler/worker.js';
import { OUTCOME } from '../../src/services/agent/runCycle.js';

/**
 * Phase 12 — CycleWorker: the clock around a cycle.
 *
 * Every collaborator is injected, so the whole timer loop runs on a fake clock
 * with no real timers, no database, and no provider. What is under test is the
 * worker's contract: an immediate first cycle, no overlapping cycles per agent,
 * a failing cycle that never kills the loop, exponential backoff that resets on
 * success, one Agent write per cycle, and a durable error message that can never
 * carry a secret.
 */

const AGENT_ID = 'agt_worker_test';
const INTERVAL = 45_000;
const MAX_BACKOFF = 30 * 60 * 1000;

/** A logger that says nothing, so the suite output stays clean. */
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A deterministic clock. setTimer/clearTimer/now are passed to the worker; the
 * test drives time with advance(), which fires due timers in order and awaits
 * each — so awaiting advance() awaits whole cycles, reschedule included.
 */
class FakeClock {
  constructor(start = 0) {
    this.t = start;
    this.timers = [];
    this.seq = 0;
    this.now = () => this.t;
    this.setTimer = (fn, delay) => {
      const handle = ++this.seq;
      this.timers.push({ handle, fireAt: this.t + Math.max(0, delay), fn, active: true });
      return handle;
    };
    this.clearTimer = (handle) => {
      const timer = this.timers.find((x) => x.handle === handle);
      if (timer) timer.active = false;
    };
  }

  /** Pending (active, unfired) timers — the loop should keep exactly one. */
  pending() {
    return this.timers.filter((x) => x.active);
  }

  /** Advance time by ms, firing every timer that comes due, oldest first. */
  async advance(ms) {
    const target = this.t + ms;
    let guard = 0;
    for (;;) {
      if (++guard > 10_000) throw new Error('FakeClock.advance runaway');
      const due = this.timers
        .filter((x) => x.active && x.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0];
      next.active = false;
      this.t = Math.max(this.t, next.fireAt);
      await next.fn();
    }
    this.t = Math.max(this.t, target);
  }
}

const successResult = (stats = {}) => ({
  agentId: AGENT_ID,
  outcome: OUTCOME.PUBLISHED,
  failed: false,
  stats: {
    topicsDiscovered: 3,
    topicsAfterFilter: 2,
    topicsRejected: 1,
    topicsSelected: 1,
    postsPublished: 1,
    llmCalls: 2,
    ...stats,
  },
  errors: [],
});

const failedResult = (errors = [{ stage: 'generation', code: 'rate_limited' }]) => ({
  agentId: AGENT_ID,
  outcome: OUTCOME.FAILED,
  failed: true,
  stats: null,
  errors,
});

const pausedResult = () => ({
  agentId: AGENT_ID, outcome: OUTCOME.PAUSED, failed: false, stats: null, errors: [],
});

/**
 * Build a worker wired to a fake clock and recording reload/persist/runCycle.
 * `runResults` may be a single result, an array consumed per cycle (last one
 * repeats), or a function (agent) => result.
 *
 * The cycle-history seams are recorded too, and `newId` is deterministic
 * (`cyc_1`, `cyc_2`, …) so a test can name the row a cycle should have written
 * without reaching for a UUID.
 */
function makeWorker({ runResults = successResult(), agent, reloadFn, persistFn, options } = {}) {
  const clock = new FakeClock();
  const persistCalls = [];
  const reloadCalls = [];
  const runCalls = [];
  const opened = [];
  const closed = [];
  const theAgent = agent === undefined
    ? { agentId: AGENT_ID, status: 'autonomous', persona: { name: 'W', domain: 'D' } }
    : agent;

  let cursor = 0;
  const nextResult = (a) => {
    if (typeof runResults === 'function') return runResults(a);
    if (Array.isArray(runResults)) {
      const r = runResults[Math.min(cursor, runResults.length - 1)];
      cursor += 1;
      return r;
    }
    return runResults;
  };

  let ids = 0;

  const worker = new CycleWorker(AGENT_ID, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    cycleIntervalMs: INTERVAL,
    maxBackoffMs: MAX_BACKOFF,
    logger: silent,
    newId: () => `cyc_${++ids}`,
    reload: reloadFn ?? (async (id) => { reloadCalls.push(id); return theAgent; }),
    persist: persistFn ?? (async (id, update) => { persistCalls.push({ id, update }); }),
    openCycleRun: async (record) => { opened.push(record); },
    closeCycleRun: async (cycleId, update) => { closed.push({ cycleId, update }); },
    runCycleFn: async (a, opts) => { runCalls.push({ a, opts }); return nextResult(a); },
    ...options,
  });

  return { worker, clock, persistCalls, reloadCalls, runCalls, opened, closed };
}

// --- The pure backoff function: a timer-free truth table ----------------------

test('calculateBackoffDelay: healthy cadence until a failure, then doubling to a ceiling', () => {
  // No failures (0 or negative) -> the base interval.
  assert.equal(calculateBackoffDelay(0, INTERVAL, MAX_BACKOFF), INTERVAL);
  assert.equal(calculateBackoffDelay(-3, INTERVAL, MAX_BACKOFF), INTERVAL);
  // First retry is still at base; each further failure doubles.
  assert.equal(calculateBackoffDelay(1, INTERVAL, MAX_BACKOFF), INTERVAL);
  assert.equal(calculateBackoffDelay(2, INTERVAL, MAX_BACKOFF), INTERVAL * 2);
  assert.equal(calculateBackoffDelay(3, INTERVAL, MAX_BACKOFF), INTERVAL * 4);
  assert.equal(calculateBackoffDelay(4, INTERVAL, MAX_BACKOFF), INTERVAL * 8);
  // Eventually clamped to the ceiling, and a pathological count never yields NaN.
  assert.equal(calculateBackoffDelay(50, INTERVAL, MAX_BACKOFF), MAX_BACKOFF);
  assert.equal(calculateBackoffDelay(1e9, INTERVAL, MAX_BACKOFF), MAX_BACKOFF);
});

test('calculateBackoffDelay: the ceiling may exceed the interval and is not capped at it', () => {
  // A deliberate property: backoff is allowed to grow past one interval.
  const delay = calculateBackoffDelay(3, 1000, 100_000);
  assert.equal(delay, 4000);
  assert.ok(delay > 1000);
});

test('calculateBackoffDelay: bad inputs fall back rather than producing NaN/Infinity', () => {
  // Non-finite / non-positive ceiling -> the default ceiling.
  assert.equal(calculateBackoffDelay(100, INTERVAL, 0), DEFAULT_MAX_BACKOFF_MS);
  assert.equal(calculateBackoffDelay(100, INTERVAL, Number.NaN), DEFAULT_MAX_BACKOFF_MS);
  // A finite result is always returned for a finite failure count.
  const d = calculateBackoffDelay(2, Number.NaN, MAX_BACKOFF);
  assert.ok(Number.isFinite(d) && d > 0);
});

// --- Immediate first cycle ----------------------------------------------------

test('start() runs the first cycle immediately, not after a full interval', async () => {
  const { worker, clock, runCalls, persistCalls } = makeWorker();

  worker.start();
  // Scheduled, not yet run: the first tick is a zero-delay timer.
  assert.equal(runCalls.length, 0);
  assert.equal(clock.pending().length, 1);

  await clock.advance(0);

  assert.equal(runCalls.length, 1, 'the first cycle fires at t=0');
  assert.equal(persistCalls.length, 1);
  assert.equal(persistCalls[0].update.$set.status, 'autonomous');
  // The next cycle is scheduled one interval out.
  assert.equal(worker.nextDelayMs, INTERVAL);
  assert.deepEqual(persistCalls[0].update.$set.nextCycleAt, new Date(INTERVAL));

  worker.stop();
});

test('start() is idempotent — a second start does not create a second loop', async () => {
  const { worker, clock, runCalls } = makeWorker();

  worker.start();
  worker.start();
  assert.equal(clock.pending().length, 1, 'still exactly one pending timer');

  await clock.advance(0);
  assert.equal(runCalls.length, 1);
  worker.stop();
});

// --- No overlap ---------------------------------------------------------------

test('a cycle never overlaps itself: a tick while one is running is a no-op', async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  let running = 0;
  let maxConcurrent = 0;

  const { worker } = makeWorker({
    options: {
      runCycleFn: async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await blocker;
        running -= 1;
        return successResult();
      },
    },
  });

  worker.stopped = false; // allow ticks without scheduling the boot timer
  const first = worker._tick();
  const second = worker._tick(); // must early-return on the running guard
  release();
  await Promise.all([first, second]);

  assert.equal(maxConcurrent, 1, 'at most one cycle in flight at any moment');
});

// --- Failure never kills the loop ---------------------------------------------

test('a runCycle that throws is caught, counted, and the loop keeps going', async () => {
  const { worker, clock, persistCalls } = makeWorker({
    options: { runCycleFn: async () => { throw new Error('boom'); } },
  });

  worker.start();
  await clock.advance(0);

  // The throw became a failed cycle, not a dead worker.
  assert.equal(worker.consecutiveFailures, 1);
  assert.equal(persistCalls.length, 1);
  assert.equal(persistCalls[0].update.$set.status, 'error');
  assert.equal(persistCalls[0].update.$inc['stats.cyclesFailed'], 1);
  // And a next tick is scheduled, so the loop survives.
  assert.equal(clock.pending().length, 1);

  worker.stop();
});

test('even an unexpected throw inside the tick body cannot kill the loop', async () => {
  const { worker, clock } = makeWorker();
  // Force a throw past every inner catch, straight to the last-resort handler.
  worker._runOnce = async () => { throw new Error('unexpected'); };

  worker.start();
  await clock.advance(0);

  assert.equal(worker.consecutiveFailures, 1, 'the last-resort catch backed off');
  assert.equal(clock.pending().length, 1, 'and rescheduled rather than dying');
  worker.stop();
});

// --- Backoff progression and reset --------------------------------------------

test('consecutive failures back off exponentially, then a success resets to base', async () => {
  const { worker, clock } = makeWorker({
    // fail, fail, then succeed forever.
    runResults: [failedResult(), failedResult(), successResult()],
  });

  worker.start();

  await clock.advance(0); // cycle 1: failure #1 -> delay = INTERVAL
  assert.equal(worker.consecutiveFailures, 1);
  assert.equal(worker.nextDelayMs, INTERVAL);

  await clock.advance(INTERVAL); // cycle 2: failure #2 -> delay = INTERVAL*2
  assert.equal(worker.consecutiveFailures, 2);
  assert.equal(worker.nextDelayMs, INTERVAL * 2);

  await clock.advance(INTERVAL * 2); // cycle 3: success -> reset
  assert.equal(worker.consecutiveFailures, 0);
  assert.equal(worker.nextDelayMs, INTERVAL, 'the base cadence is restored on recovery');

  worker.stop();
});

// --- One write per cycle, folding stat deltas ---------------------------------

test('a successful cycle folds stat deltas into exactly one Agent update', async () => {
  const { worker, clock, persistCalls } = makeWorker({
    runResults: successResult({ topicsRejected: 0 }), // a zero delta must be omitted
  });

  worker.start();
  await clock.advance(0);

  assert.equal(persistCalls.length, 1, 'the worker is the single writer');
  const { update } = persistCalls[0];
  assert.deepEqual(update.$inc, {
    'stats.cyclesRun': 1,
    'stats.topicsDiscovered': 3,
    'stats.topicsAfterFilter': 2,
    'stats.topicsSelected': 1,
    'stats.postsPublished': 1,
    'stats.llmCalls': 2,
  });
  assert.ok(!('stats.topicsRejected' in update.$inc), 'a zero delta is not written');
  assert.ok(!('stats.cyclesFailed' in update.$inc), 'a success does not touch cyclesFailed');
  assert.ok(!('lastError.message' in update.$set), 'a success clears no error but sets none');
  assert.equal(update.$set.status, 'autonomous');
  assert.ok(update.$set.lastCycleAt instanceof Date);

  worker.stop();
});

test('a failed cycle increments cyclesFailed and records a sanitized lastError', async () => {
  const { worker, clock, persistCalls } = makeWorker({ runResults: failedResult() });

  worker.start();
  await clock.advance(0);

  const { update } = persistCalls[0];
  assert.equal(update.$inc['stats.cyclesRun'], 1);
  assert.equal(update.$inc['stats.cyclesFailed'], 1);
  assert.equal(update.$set.status, 'error');
  assert.equal(update.$set['lastError.message'], 'Cycle failed [generation:rate_limited]');
  assert.ok(update.$set['lastError.at'] instanceof Date);

  worker.stop();
});

// --- Secret safety: the durable error message can never carry a credential ----

test('lastError.message is built only from sanitized stage:code, never raw text', async () => {
  // A synthetic, obviously-fake connection string: if a future code path let a
  // raw error string reach a `code`, this asserts it could not survive intact.
  const dirty = 'mongodb+srv://user:FAKE_PLACEHOLDER_NOT_A_SECRET@host.example/db';
  const { worker, clock, persistCalls } = makeWorker({
    runResults: failedResult([{ stage: 'publish', code: dirty }]),
  });

  worker.start();
  await clock.advance(0);

  const message = persistCalls[0].update.$set['lastError.message'];
  assert.ok(!message.includes('://'), 'no URL scheme structure');
  assert.ok(!message.includes('@'), 'no host delimiter');
  assert.ok(!message.includes('/'), 'no path separators');
  assert.ok(!message.includes(':FAKE_PLACEHOLDER_NOT_A_SECRET'), 'no user:password pair');
  assert.ok(message.startsWith('Cycle failed [publish:'));

  worker.stop();
});

test('lastError.message is length-capped so a pathological error list cannot bloat the doc', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ stage: 'generation', code: `err_${i}` }));
  const { worker, clock, persistCalls } = makeWorker({ runResults: failedResult(many) });

  worker.start();
  await clock.advance(0);

  const message = persistCalls[0].update.$set['lastError.message'];
  assert.ok(message.length <= 300, `message length ${message.length} must be capped`);
  assert.ok(message.endsWith('...'));

  worker.stop();
});

// --- Self-stopping paths: paused agent and vanished agent ---------------------

test('an agent that runCycle reports as PAUSED stops its worker with no stat write', async () => {
  const { worker, clock, persistCalls } = makeWorker({ runResults: pausedResult() });

  worker.start();
  await clock.advance(0);

  assert.equal(worker.stopped, true, 'a paused agent parks its worker');
  assert.equal(persistCalls.length, 0, 'a no-op cycle writes nothing');
  assert.equal(clock.pending().length, 0, 'and leaves no orphan timer');
});

test('an agent that no longer exists stops its worker before running a cycle', async () => {
  const { worker, clock, runCalls, persistCalls } = makeWorker({
    reloadFn: async () => null,
  });

  worker.start();
  await clock.advance(0);

  assert.equal(runCalls.length, 0, 'no cycle runs for a missing agent');
  assert.equal(persistCalls.length, 0);
  assert.equal(worker.stopped, true);
  assert.equal(clock.pending().length, 0);
});

// --- A reload failure backs off without a stat write --------------------------

test('a transient reload failure backs off and retries without writing stats', async () => {
  let calls = 0;
  const { worker, clock, persistCalls, runCalls } = makeWorker({
    reloadFn: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('db down'), { code: 'db_unavailable' });
      return { agentId: AGENT_ID, status: 'autonomous', persona: { name: 'W', domain: 'D' } };
    },
    runResults: successResult(),
  });

  worker.start();
  await clock.advance(0); // reload throws -> backoff, no cycle, no persist
  assert.equal(worker.consecutiveFailures, 1);
  assert.equal(runCalls.length, 0);
  assert.equal(persistCalls.length, 0);
  assert.equal(clock.pending().length, 1, 'the loop survives a DB blip');

  await clock.advance(INTERVAL); // second attempt: reload works, cycle succeeds
  assert.equal(runCalls.length, 1);
  assert.equal(worker.consecutiveFailures, 0, 'recovery resets the backoff');

  worker.stop();
});

// --- Observability: the completion marker names the cycle it closes -----------
//
// 'Cycle started' (runCycle) and 'Cycle complete' (here) bracket one cycle's
// work in the activity buffer. The dashboard's cycle view reads the pair to know
// where a cycle began and ended; without a shared id the only way to match them
// is by position, which misattributes as soon as two agents interleave.

/** A logger that keeps what it was told, so a payload can be asserted. */
function capturingLogger() {
  const entries = [];
  const push = (level) => (message, meta) => entries.push({ level, message, meta });
  return {
    entries,
    debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error'),
  };
}

test('Cycle complete carries the cycleId of the cycle it closes', async () => {
  const logger = capturingLogger();
  const { worker, clock, runCalls, opened } = makeWorker({
    options: { logger, newId: () => 'c_worker_0001' },
  });

  worker.start();
  await clock.advance(0);

  // The worker mints the id, hands it to runCycle, and opens the history row
  // under it — so all three name the same cycle.
  assert.equal(runCalls[0].opts.cycleId, 'c_worker_0001', 'runCycle is told which cycle this is');
  assert.equal(opened[0].cycleId, 'c_worker_0001', 'and the durable row is keyed by it');

  const complete = logger.entries.filter((e) => e.message === 'Cycle complete');
  assert.equal(complete.length, 1, 'exactly one completion marker per cycle');
  assert.equal(complete[0].meta.cycleId, 'c_worker_0001', 'the id that ties the pair together');
  assert.equal(complete[0].meta.agentId, AGENT_ID);
  assert.equal(complete[0].meta.outcome, OUTCOME.PUBLISHED);
  assert.equal(complete[0].meta.failed, false);
  assert.equal(complete[0].meta.consecutiveFailures, 0);

  worker.stop();
});

test('Cycle complete names the open history row even when runCycle threw', async () => {
  const logger = capturingLogger();
  // _safeRunCycle's catch path builds its own failed result. The id is still
  // real — the worker minted it and a row is already open under it — so the
  // marker must name that row rather than reporting nothing.
  const { worker, clock, opened, closed } = makeWorker({
    runResults: () => { throw Object.assign(new Error('boom'), { code: 'unexpected' }); },
    options: { logger },
  });

  worker.start();
  await clock.advance(0);

  const complete = logger.entries.filter((e) => e.message === 'Cycle complete');
  assert.equal(complete.length, 1);
  assert.equal(complete[0].meta.cycleId, 'cyc_1');
  assert.equal(complete[0].meta.cycleId, opened[0].cycleId, 'the marker points at a row that exists');
  assert.equal(closed[0].cycleId, 'cyc_1');
  assert.equal(complete[0].meta.failed, true);
  assert.equal(complete[0].meta.consecutiveFailures, 1);

  worker.stop();
});

// --- stop() halts the clock loop ----------------------------------------------

test('stop() cancels the pending tick so no further cycles run', async () => {
  const { worker, clock, runCalls } = makeWorker();

  worker.start();
  await clock.advance(0);
  assert.equal(runCalls.length, 1);

  worker.stop();
  assert.equal(clock.pending().length, 0, 'the pending timer was cleared');

  await clock.advance(INTERVAL * 10);
  assert.equal(runCalls.length, 1, 'nothing runs after stop()');
});
