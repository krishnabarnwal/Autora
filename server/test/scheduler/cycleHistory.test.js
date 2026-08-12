import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { CycleWorker } from '../../src/scheduler/worker.js';
import { CycleRun } from '../../src/models/index.js';
import { OUTCOME } from '../../src/services/agent/runCycle.js';

/**
 * The cycle-history write path, against a real database.
 *
 * worker.test.js covers the timer loop with every seam faked. This file does the
 * opposite: the real CycleRun writers, so what is under test is the lifecycle a
 * row actually goes through — opened before the work starts, closed in place when
 * it ends, and never duplicated for one execution.
 *
 * The properties that matter most here are the ones that would be invisible in a
 * mock: the unique constraint really preventing a double-count, and a provider
 * rate limit that the pipeline absorbs on purpose staying a completed cycle
 * rather than being promoted into a scheduler failure.
 */

const AGENT_ID = 'agt_history_test';
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** A clock the test moves by hand, so a duration is exact rather than measured. */
function fakeClock(start = Date.UTC(2026, 7, 11, 9, 0, 0)) {
  return { t: start, now() { return this.t; }, advance(ms) { this.t += ms; } };
}

/**
 * A worker with the real history writers and everything else faked. Timers are
 * never scheduled: each test calls _runOnce() directly, one cycle at a time.
 */
function makeWorker({ runCycleFn, newId, options } = {}) {
  const clock = fakeClock();
  const persistCalls = [];
  let ids = 0;

  const worker = new CycleWorker(AGENT_ID, {
    now: () => clock.now(),
    setTimer: () => null,
    clearTimer: () => {},
    cycleIntervalMs: 45_000,
    logger: silent,
    newId: newId ?? (() => `cyc_history_${++ids}`),
    reload: async () => ({ agentId: AGENT_ID, status: 'autonomous', persona: { name: 'H', domain: 'D' } }),
    persist: async (id, update) => { persistCalls.push({ id, update }); },
    runCycleFn,
    ...options,
  });

  return { worker, clock, persistCalls };
}

const publishedResult = () => ({
  agentId: AGENT_ID,
  outcome: OUTCOME.PUBLISHED,
  failed: false,
  stats: {
    topicsDiscovered: 18,
    topicsAfterFilter: 7,
    topicsRejected: 11,
    topicsSelected: 1,
    postsPublished: 1,
    llmCalls: 2,
  },
  errors: [],
  editorial: { decision: 'publish', confidence: 0.82, provider: 'gemini', model: 'gemini-2.5-flash' },
  publisher: { postId: 'p_written123456' },
});

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

test('history: a running row exists before the cycle does any work', async () => {
  let observed = null;
  const { worker, clock } = makeWorker({
    // Read the collection from inside the cycle: at this point the row must
    // already be there, because a crash one line later has to leave evidence.
    runCycleFn: async (agent, opts) => {
      observed = await CycleRun.findOne({ cycleId: opts.cycleId });
      clock.advance(1234);
      return publishedResult();
    },
  });

  await worker._runOnce();

  assert.ok(observed, 'no history row existed while the cycle was running');
  assert.equal(observed.status, 'running');
  assert.equal(observed.agentId, AGENT_ID);
  assert.equal(observed.startedAt.toISOString(), '2026-08-11T09:00:00.000Z');
  // Nothing has been measured yet, and null says so where 0 would claim a count.
  assert.equal(observed.outcome, null);
  assert.equal(observed.completedAt, null);
  assert.equal(observed.durationMs, null);
  assert.equal(observed.topicsDiscovered, null);
});

test('history: completion updates the same row rather than writing a second', async () => {
  const { worker, clock } = makeWorker({
    runCycleFn: async () => { clock.advance(42_000); return publishedResult(); },
  });

  await worker._runOnce();

  const rows = await CycleRun.find({ agentId: AGENT_ID });
  assert.equal(rows.length, 1, 'one execution must produce exactly one row');

  const [row] = rows;
  assert.equal(row.cycleId, 'cyc_history_1');
  assert.equal(row.status, 'completed');
  assert.equal(row.outcome, 'published');
  assert.equal(row.durationMs, 42_000);
  assert.equal(row.completedAt.toISOString(), '2026-08-11T09:00:42.000Z');
  assert.equal(row.topicsDiscovered, 18);
  assert.equal(row.topicsAfterFilter, 7);
  assert.equal(row.topicsRejected, 11);
  assert.equal(row.topicsSelected, 1);
  assert.equal(row.postsPublished, 1);
  assert.equal(row.llmCalls, 2);
  assert.equal(row.decision, 'publish');
  assert.equal(row.decisionScore, 0.82);
  assert.equal(row.provider, 'gemini');
  assert.equal(row.model, 'gemini-2.5-flash');
  assert.equal(row.postId, 'p_written123456');
  assert.equal(row.failureCode, null);
  assert.equal(row.providerFailureCode, null);
});

test('history: the cycleId on the row is the one the cycle itself ran under', async () => {
  // The join key for the whole feature: the drawer matches a persisted row to a
  // traced cycle by this value, so the worker's id and runCycle's must agree.
  const seen = [];
  const { worker } = makeWorker({
    runCycleFn: async (agent, opts) => { seen.push(opts.cycleId); return publishedResult(); },
  });

  await worker._runOnce();

  const row = await CycleRun.findOne({ agentId: AGENT_ID });
  assert.equal(seen.length, 1);
  assert.equal(row.cycleId, seen[0]);
});

test('history: a failed cycle updates the same row and records a safe code', async () => {
  const { worker, clock } = makeWorker({
    runCycleFn: async () => {
      clock.advance(3000);
      return {
        agentId: AGENT_ID,
        outcome: OUTCOME.FAILED,
        failed: true,
        stats: null,
        errors: [{ stage: 'generation', code: 'rate_limited' }],
      };
    },
  });

  await worker._runOnce();

  const rows = await CycleRun.find({ agentId: AGENT_ID });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.status, 'failed');
  assert.equal(row.outcome, 'failed');
  assert.equal(row.failureCode, 'rate_limited');
  assert.equal(row.failureMessage, 'Cycle failed [generation:rate_limited]');
  assert.equal(row.durationMs, 3000);
  // A cycle that died before discovery measured nothing; zeros would be a lie.
  assert.equal(row.topicsDiscovered, null);
  assert.equal(row.llmCalls, null);
});

test('history: the failure message carries codes only, never a raw error string', async () => {
  const { worker } = makeWorker({
    runCycleFn: async () => ({
      agentId: AGENT_ID,
      outcome: OUTCOME.FAILED,
      failed: true,
      stats: null,
      errors: [{ stage: 'publish', code: 'mongodb+srv://user:pa55w0rd@cluster.example.net' }],
    }),
  });

  await worker._runOnce();

  const row = await CycleRun.findOne({ agentId: AGENT_ID });
  // sanitizeToken strips the separators a URI needs and truncates, so nothing
  // resembling a connection string can reach durable history.
  assert.ok(!row.failureMessage.includes('://'));
  assert.ok(!row.failureMessage.includes('@'));
  assert.ok(!row.failureCode.includes(':'));
  assert.ok(row.failureCode.length <= 60);
});

test('history: a 429 absorbed into an idle cycle is not recorded as a failure', async () => {
  // Existing, deliberate behaviour: the editorial layer converts a provider rate
  // limit into a local skip and the cycle ends healthy. History must record the
  // rate limit without promoting it into a scheduler failure.
  const { worker, clock } = makeWorker({
    runCycleFn: async () => {
      clock.advance(5000);
      return {
        agentId: AGENT_ID,
        outcome: OUTCOME.IDLE,
        failed: false,
        stats: { topicsDiscovered: 12, topicsAfterFilter: 4, topicsSelected: 1, llmCalls: 1 },
        errors: [],
        editorial: {
          decision: 'skip',
          confidence: 0,
          source: 'local_fallback',
          warnings: ['editorial_call_failed:rate_limited'],
        },
      };
    },
  });

  await worker._runOnce();

  const row = await CycleRun.findOne({ agentId: AGENT_ID });
  assert.equal(row.status, 'completed', 'an absorbed rate limit must not become a failed cycle');
  assert.equal(row.outcome, 'idle');
  assert.equal(row.decision, 'skip');
  assert.equal(row.failureCode, null);
  assert.equal(row.failureMessage, null);
  // But it is visible: otherwise a rate-limited agent looks perfectly healthy.
  assert.equal(row.providerFailureCode, 'rate_limited');
});

test('history: the agent is still marked autonomous after an absorbed rate limit', async () => {
  // The other half of the same guarantee — the Agent write must not change either.
  const { worker, persistCalls } = makeWorker({
    runCycleFn: async () => ({
      agentId: AGENT_ID,
      outcome: OUTCOME.IDLE,
      failed: false,
      stats: null,
      errors: [],
      editorial: { decision: 'skip', warnings: ['editorial_call_failed:rate_limited'] },
    }),
  });

  await worker._runOnce();

  assert.equal(persistCalls.length, 1);
  assert.equal(persistCalls[0].update.$set.status, 'autonomous');
  assert.equal(persistCalls[0].update.$set['lastError.message'], undefined);
  assert.equal(worker.consecutiveFailures, 0);
});

test('history: two cycles write two rows', async () => {
  const { worker, clock } = makeWorker({
    runCycleFn: async () => { clock.advance(1000); return publishedResult(); },
  });

  await worker._runOnce();
  clock.advance(45_000);
  await worker._runOnce();

  const rows = await CycleRun.historyFor(AGENT_ID, { limit: 10 });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.cycleId),
    ['cyc_history_2', 'cyc_history_1'],
    'history reads newest first'
  );
});

test('history: a repeated cycleId cannot double-count one execution', async () => {
  // The unique index is the guarantee. If an id generator ever repeated itself,
  // the second open is rejected, the first row keeps its own data, and — because
  // the row was not opened by this cycle — the second cycle does not overwrite it.
  const { worker, clock } = makeWorker({
    newId: () => 'cyc_repeated',
    runCycleFn: async (agent, opts) => {
      clock.advance(1000);
      return opts.cycleId === 'cyc_repeated' && (await CycleRun.countDocuments()) === 1
        ? publishedResult()
        : { ...publishedResult(), outcome: OUTCOME.IDLE };
    },
  });

  await worker._runOnce();
  await worker._runOnce();

  const rows = await CycleRun.find({});
  assert.equal(rows.length, 1, 'a duplicate cycleId must not create a second row');
  assert.equal(rows[0].outcome, 'published', 'the surviving row keeps the execution it recorded');
});

test('history: a paused cycle closes its row instead of leaving it running', async () => {
  // Without this the row would be stranded as `running` by an orderly stop and
  // the next boot would misreport it as an interrupted crash.
  const { worker, clock } = makeWorker({
    runCycleFn: async () => {
      clock.advance(20);
      return { agentId: AGENT_ID, outcome: OUTCOME.PAUSED, failed: false, stats: null, errors: [] };
    },
  });

  const delay = await worker._runOnce();

  assert.equal(delay, null, 'a paused agent stops its worker');
  const row = await CycleRun.findOne({ agentId: AGENT_ID });
  assert.equal(row.status, 'completed');
  assert.equal(row.outcome, 'paused');
  assert.equal(row.durationMs, 20);
});

test('history: a cycle that throws still closes its row as failed', async () => {
  const { worker } = makeWorker({
    runCycleFn: async () => { throw Object.assign(new Error('boom'), { code: 'unexpected_bug' }); },
  });

  await worker._runOnce();

  const rows = await CycleRun.find({ agentId: AGENT_ID });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].failureCode, 'unexpected_bug');
  assert.equal(rows[0].failureMessage, 'Cycle failed [cycle:unexpected_bug]');
});

test('history: an unwritable history collection never stops the agent working', async () => {
  // Bookkeeping must never outrank the job. If the open fails, the cycle runs
  // anyway and simply has no history row — the honest outcome, and better than a
  // row invented afterwards with a guessed start time.
  const { worker, persistCalls } = makeWorker({
    runCycleFn: async () => publishedResult(),
    options: {
      openCycleRun: async () => { throw new Error('history is down'); },
      closeCycleRun: async () => { throw new Error('history is down'); },
    },
  });

  const delay = await worker._runOnce();

  assert.equal(delay, 45_000, 'the cycle succeeded and the cadence is unchanged');
  assert.equal(persistCalls.length, 1, 'the agent was still updated');
  assert.equal(await CycleRun.countDocuments(), 0);
});

test('history: a close that fails leaves the row open rather than losing the cycle', async () => {
  // The row stays `running`, which the next boot resolves to `interrupted`. That
  // is the correct reading: something did happen to that cycle that this process
  // could not record.
  const { worker } = makeWorker({
    runCycleFn: async () => publishedResult(),
    options: { closeCycleRun: async () => { throw new Error('write failed'); } },
  });

  await worker._runOnce();

  const row = await CycleRun.findOne({ agentId: AGENT_ID });
  assert.equal(row.status, 'running');
  assert.equal(row.completedAt, null);
});
