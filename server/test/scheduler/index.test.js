import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Scheduler,
  getScheduler,
  setScheduler,
  DEFAULT_BOOT_STAGGER_MS,
} from '../../src/scheduler/index.js';
import { CycleWorker } from '../../src/scheduler/worker.js';
import { OUTCOME } from '../../src/services/agent/runCycle.js';

/**
 * Phase 12 — Scheduler lifecycle.
 *
 * The registry semantics (idempotency, dormancy, resume stagger, shutdown) are
 * tested against a recording fake worker, so they are fast and deterministic. A
 * final end-to-end test wires the real CycleWorker onto a fake clock to prove the
 * boot stagger actually spaces the first cycles in time.
 */

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** A worker stand-in that records start/stop and reports a `stopped` flag. */
function fakeWorkerFactory() {
  const made = [];
  const createWorker = (agentId, opts) => {
    const worker = {
      agentId,
      opts,
      stopped: true, // dormant until start(), like the real worker
      starts: 0,
      stops: 0,
      start() { this.stopped = false; this.starts += 1; return this; },
      stop() { this.stopped = true; this.stops += 1; return this; },
    };
    made.push(worker);
    return worker;
  };
  return { createWorker, made };
}

function makeScheduler(extra = {}) {
  const { createWorker, made } = fakeWorkerFactory();
  const scheduler = new Scheduler({
    createWorker,
    findResumable: async () => [],
    bootStaggerMs: 1000,
    logger: silent,
    ...extra,
  });
  return { scheduler, made };
}

// --- Dormancy: registering before start() records but does not tick -----------

test('a dormant scheduler records a worker without starting it', () => {
  const { scheduler, made } = makeScheduler();

  const worker = scheduler.register('agt_a');

  assert.equal(scheduler.size, 1);
  assert.equal(made.length, 1);
  assert.equal(worker.starts, 0, 'no timer starts before the scheduler is live');
  assert.equal(worker.stopped, true);
});

test('start() goes live and starts every registered worker exactly once', () => {
  const { scheduler, made } = makeScheduler();
  scheduler.register('agt_a');
  scheduler.register('agt_b');

  scheduler.start();

  assert.equal(scheduler.started, true);
  assert.deepEqual(made.map((w) => w.starts), [1, 1]);

  // A second start() must not double-start already-running workers.
  scheduler.start();
  assert.deepEqual(made.map((w) => w.starts), [1, 1], 'no worker is started twice');
});

test('registering after start() starts the new worker immediately (immediate first cycle)', () => {
  const { scheduler, made } = makeScheduler();
  scheduler.start();

  const worker = scheduler.register('agt_live');

  assert.equal(worker.starts, 1, 'a live registration begins at once');
  assert.equal(made.length, 1);
});

// --- Idempotency: one live worker per agent -----------------------------------

test('register is idempotent: a repeat for a live agent returns the same worker', () => {
  const { scheduler, made } = makeScheduler();
  scheduler.start();

  const first = scheduler.register('agt_a');
  const second = scheduler.register('agt_a');

  assert.equal(first, second, 'the same worker instance is returned');
  assert.equal(made.length, 1, 'no rival worker is created');
  assert.equal(first.starts, 1, 'the existing loop is not restarted');
});

test('register recreates a worker only after it has stopped itself', () => {
  const { scheduler, made } = makeScheduler();
  scheduler.start();

  const first = scheduler.register('agt_a');
  first.stop(); // e.g. the agent was paused and the worker parked itself

  const second = scheduler.register('agt_a');
  assert.notEqual(second, first, 'a stopped worker is replaced, not reused');
  assert.equal(made.length, 2);
  assert.equal(second.starts, 1);
});

test('register ignores a falsy agentId rather than creating a nameless worker', () => {
  const { scheduler, made } = makeScheduler();
  scheduler.start();

  assert.equal(scheduler.register(''), null);
  assert.equal(scheduler.register(undefined), null);
  assert.equal(made.length, 0);
});

// --- resumeAll: load, stagger, start ------------------------------------------

test('resumeAll registers each resumable agent with an increasing boot stagger', async () => {
  const { createWorker, made } = fakeWorkerFactory();
  const scheduler = new Scheduler({
    createWorker,
    findResumable: async () => [{ agentId: 'agt_1' }, { agentId: 'agt_2' }, { agentId: 'agt_3' }],
    bootStaggerMs: 1500,
    logger: silent,
  });

  const count = await scheduler.resumeAll();

  assert.equal(count, 3);
  assert.deepEqual(made.map((w) => w.agentId), ['agt_1', 'agt_2', 'agt_3']);
  // The nth agent's first cycle is delayed n*stagger — no thundering herd.
  assert.deepEqual(made.map((w) => w.opts.bootDelayMs), [0, 1500, 3000]);
  assert.deepEqual(made.map((w) => w.starts), [1, 1, 1], 'all are started');
});

test('resumeAll survives a findResumable failure and comes up empty', async () => {
  const scheduler = new Scheduler({
    createWorker: fakeWorkerFactory().createWorker,
    findResumable: async () => { throw new Error('db unreachable'); },
    logger: silent,
  });

  const count = await scheduler.resumeAll();

  assert.equal(count, 0, 'a boot-time DB failure must not crash startup');
  assert.equal(scheduler.started, true, 'the scheduler is still live for later inits');
});

test('resumeAll tolerates bare id strings as well as documents', async () => {
  const { createWorker, made } = fakeWorkerFactory();
  const scheduler = new Scheduler({
    createWorker,
    findResumable: async () => ['agt_x', { agentId: 'agt_y' }, null],
    bootStaggerMs: 0,
    logger: silent,
  });

  await scheduler.resumeAll();
  assert.deepEqual(made.map((w) => w.agentId), ['agt_x', 'agt_y'], 'the null entry is skipped');
});

// --- stopAll: no orphan timers ------------------------------------------------

test('stopAll stops every worker and empties the registry', () => {
  const { scheduler, made } = makeScheduler();
  scheduler.start();
  scheduler.register('agt_a');
  scheduler.register('agt_b');

  scheduler.stopAll();

  assert.deepEqual(made.map((w) => w.stops), [1, 1], 'each worker was stopped');
  assert.equal(scheduler.size, 0, 'the registry is empty — no orphan references');
  assert.equal(scheduler.started, false, 'the scheduler is dormant again');
});

test('stopAll keeps going even if a worker throws on stop', () => {
  let stops = 0;
  const createWorker = (agentId) => ({
    agentId,
    stopped: false,
    start() { this.stopped = false; },
    stop() { stops += 1; if (agentId === 'agt_bad') throw new Error('stuck'); this.stopped = true; },
  });
  const scheduler = new Scheduler({ createWorker, findResumable: async () => [], logger: silent });
  scheduler.start();
  scheduler.register('agt_bad');
  scheduler.register('agt_good');

  assert.doesNotThrow(() => scheduler.stopAll());
  assert.equal(stops, 2, 'a throwing worker does not abort the shutdown of the rest');
  assert.equal(scheduler.size, 0);
});

// --- The module-level accessor ------------------------------------------------

test('getScheduler is null until setScheduler installs one, and clears back to null', () => {
  assert.equal(getScheduler(), null, 'no scheduler is installed by default');

  const { scheduler } = makeScheduler();
  setScheduler(scheduler);
  assert.equal(getScheduler(), scheduler);

  setScheduler(null);
  assert.equal(getScheduler(), null, 'the accessor can be cleared on shutdown');
});

// --- End to end: real workers, fake clock, staggered first cycles -------------

test('resumeAll spaces real workers first cycles by the boot stagger', async () => {
  // A minimal fake clock: setTimer/clearTimer/now the workers share, advance()
  // fires due timers oldest-first and awaits each (so whole cycles complete).
  let t = 0;
  let seq = 0;
  const timers = [];
  const clock = {
    now: () => t,
    setTimer: (fn, delay) => {
      const handle = ++seq;
      timers.push({ handle, fireAt: t + Math.max(0, delay), fn, active: true });
      return handle;
    },
    clearTimer: (handle) => {
      const timer = timers.find((x) => x.handle === handle);
      if (timer) timer.active = false;
    },
    async advance(ms) {
      const target = t + ms;
      for (let guard = 0; guard < 10_000; guard += 1) {
        const due = timers.filter((x) => x.active && x.fireAt <= target).sort((a, b) => a.fireAt - b.fireAt);
        if (!due.length) break;
        const next = due[0];
        next.active = false;
        t = Math.max(t, next.fireAt);
        await next.fn();
      }
      t = Math.max(t, target);
    },
  };

  const cyclesAt = [];
  const runCycleFn = async (agent) => {
    cyclesAt.push({ agentId: agent.agentId, at: clock.now() });
    return { agentId: agent.agentId, outcome: OUTCOME.IDLE, failed: false, stats: null, errors: [] };
  };

  const scheduler = new Scheduler({
    createWorker: (agentId, opts) => new CycleWorker(agentId, opts),
    findResumable: async () => [{ agentId: 'agt_1' }, { agentId: 'agt_2' }],
    bootStaggerMs: 5_000,
    logger: silent,
    workerOptions: {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      cycleIntervalMs: 60_000,
      maxBackoffMs: 600_000,
      logger: silent,
      reload: async (id) => ({ agentId: id, status: 'autonomous', persona: { name: 'A', domain: 'D' } }),
      persist: async () => {},
      // The history seams are stubbed out: this test is about the boot stagger,
      // and the real ones would reach for a database it never connects to.
      openCycleRun: async () => {},
      closeCycleRun: async () => {},
      runCycleFn,
    },
  });

  await scheduler.resumeAll();

  // At t=0 only the first agent's cycle has fired.
  await clock.advance(0);
  assert.deepEqual(cyclesAt.map((c) => c.agentId), ['agt_1']);
  assert.equal(cyclesAt[0].at, 0);

  // Advancing to the stagger boundary releases the second agent's first cycle.
  await clock.advance(5_000);
  assert.equal(cyclesAt.length, 2);
  assert.equal(cyclesAt[1].agentId, 'agt_2');
  assert.equal(cyclesAt[1].at, 5_000, 'the second agent starts one stagger later');

  scheduler.stopAll();
});

// --- A sanity check on the exported default -----------------------------------

test('DEFAULT_BOOT_STAGGER_MS is a small positive constant', () => {
  assert.ok(Number.isInteger(DEFAULT_BOOT_STAGGER_MS) && DEFAULT_BOOT_STAGGER_MS > 0);
});
