import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAverage,
  formatCount,
  formatRate,
  latestRun,
  NOT_AVAILABLE,
  statusMeta,
  summarizeCycleRuns,
} from '../src/lib/cycleAnalytics.js';

/**
 * Historical execution analytics.
 *
 * These run under bare `node --test` — the module is pure JavaScript with no JSX
 * and no browser API, so it needs no bundler and the client gains no dependency
 * to be tested. What is under test is mostly what the module refuses to do:
 * average a missing measurement as zero, count an interrupted cycle as a failure,
 * or report a rate with no denominator as 0%.
 */

const row = (overrides = {}) => ({
  cycleId: 'c1',
  status: 'completed',
  outcome: 'published',
  startedAt: '2026-08-11T09:00:00.000Z',
  completedAt: '2026-08-11T09:00:30.000Z',
  durationMs: 30_000,
  llmCalls: 2,
  providerFailureCode: null,
  ...overrides,
});

// --- summarizeCycleRuns ------------------------------------------------------

test('summary: an empty history reports nothing rather than zeroes', () => {
  const summary = summarizeCycleRuns([]);

  assert.equal(summary.total, 0);
  // Every rate and average is null, so the UI renders "Not available". A 0%
  // success rate would accuse an agent that has not yet run of failing.
  assert.equal(summary.successRate, null);
  assert.equal(summary.publishRate, null);
  assert.equal(summary.avgDurationMs, null);
  assert.equal(summary.avgLlmCalls, null);
  assert.equal(summary.latest, null);
  // Counts are real counts: none is honestly zero.
  assert.equal(summary.providerFailures, 0);
  assert.equal(summary.interrupted, 0);
});

test('summary: tolerates a missing, null or non-array input', () => {
  for (const input of [undefined, null, 'rows', 42, {}]) {
    const summary = summarizeCycleRuns(input);
    assert.equal(summary.total, 0, `${JSON.stringify(input)} should summarize to nothing`);
    assert.equal(summary.successRate, null);
  }
  // A junk entry inside a real array is dropped, not counted.
  assert.equal(summarizeCycleRuns([row(), null, 'x', 7]).total, 1);
});

test('summary: counts each status and outcome it was given', () => {
  const summary = summarizeCycleRuns([
    row({ cycleId: 'a', status: 'completed', outcome: 'published' }),
    row({ cycleId: 'b', status: 'completed', outcome: 'idle' }),
    row({ cycleId: 'c', status: 'failed', outcome: 'failed' }),
    row({ cycleId: 'd', status: 'interrupted', outcome: null }),
    row({ cycleId: 'e', status: 'running', outcome: null }),
  ]);

  assert.equal(summary.total, 5);
  assert.deepEqual(summary.byStatus, {
    running: 1, completed: 2, failed: 1, interrupted: 1, unknown: 0,
  });
  assert.equal(summary.byOutcome.published, 1);
  assert.equal(summary.byOutcome.idle, 1);
  assert.equal(summary.byOutcome.failed, 1);
  assert.equal(summary.byOutcome.unknown, 2, 'a cycle with no outcome yet has no outcome');
});

test('summary: success rate is measured only over cycles that reached an end', () => {
  const summary = summarizeCycleRuns([
    row({ cycleId: 'a', status: 'completed' }),
    row({ cycleId: 'b', status: 'completed' }),
    row({ cycleId: 'c', status: 'completed' }),
    row({ cycleId: 'd', status: 'failed', outcome: 'failed' }),
    // Neither of these is evidence either way: one is still in flight and the
    // other was cut short by a restart. Counting them as failures would blame the
    // agent for a redeploy.
    row({ cycleId: 'e', status: 'running', outcome: null }),
    row({ cycleId: 'f', status: 'interrupted', outcome: null }),
  ]);

  assert.equal(summary.successSamples, 4);
  assert.equal(summary.successRate, 0.75);
  assert.equal(summary.interrupted, 1);
});

test('summary: publish rate keeps deliberate non-publishing in the denominator', () => {
  // An agent that declines to publish is the editorial standard working. Dropping
  // those cycles would turn this into a meaningless 100%.
  const summary = summarizeCycleRuns([
    row({ cycleId: 'a', outcome: 'published' }),
    row({ cycleId: 'b', outcome: 'idle' }),
    row({ cycleId: 'c', outcome: 'idle' }),
    row({ cycleId: 'd', outcome: 'duplicate' }),
  ]);

  assert.equal(summary.publishSamples, 4);
  assert.equal(summary.publishRate, 0.25);
});

test('summary: a rate with no denominator is null, not zero', () => {
  const summary = summarizeCycleRuns([
    row({ cycleId: 'a', status: 'running', outcome: null }),
    row({ cycleId: 'b', status: 'running', outcome: null }),
  ]);

  assert.equal(summary.successRate, null);
  assert.equal(summary.successSamples, 0);
  assert.equal(summary.publishRate, null);
  assert.equal(summary.publishSamples, 0);
});

test('summary: averages skip missing measurements instead of reading them as zero', () => {
  const summary = summarizeCycleRuns([
    row({ cycleId: 'a', durationMs: 10_000, llmCalls: 2 }),
    row({ cycleId: 'b', durationMs: 20_000, llmCalls: null }),
    row({ cycleId: 'c', durationMs: null, llmCalls: 1, status: 'running' }),
  ]);

  // (10s + 20s) / 2, not / 3 — the third cycle has not finished, so it has no
  // duration, and averaging in a zero would halve the reported figure.
  assert.equal(summary.avgDurationMs, 15_000);
  assert.equal(summary.durationSamples, 2);
  assert.equal(summary.avgLlmCalls, 1.5);
  assert.equal(summary.llmSamples, 2);
});

test('summary: a zero measurement is real and is averaged in', () => {
  const summary = summarizeCycleRuns([
    row({ cycleId: 'a', llmCalls: 0 }),
    row({ cycleId: 'b', llmCalls: 2 }),
  ]);

  assert.equal(summary.avgLlmCalls, 1);
  assert.equal(summary.llmSamples, 2, 'a measured zero is a sample; a missing value is not');
});

test('summary: a non-numeric metric is not coerced into a number', () => {
  const summary = summarizeCycleRuns([
    row({ cycleId: 'a', durationMs: '30000', llmCalls: true }),
    row({ cycleId: 'b', durationMs: NaN, llmCalls: Infinity }),
  ]);

  assert.equal(summary.avgDurationMs, null);
  assert.equal(summary.durationSamples, 0);
  assert.equal(summary.avgLlmCalls, null);
});

test('summary: counts a provider failure the pipeline absorbed without failing', () => {
  const summary = summarizeCycleRuns([
    // Completed and healthy as far as the scheduler is concerned, but it hit a
    // rate limit — the one place that is visible.
    row({ cycleId: 'a', outcome: 'idle', providerFailureCode: 'rate_limited' }),
    row({ cycleId: 'b', status: 'failed', outcome: 'failed', providerFailureCode: 'timeout' }),
    row({ cycleId: 'c' }),
    row({ cycleId: 'd', providerFailureCode: '' }),
  ]);

  assert.equal(summary.providerFailures, 2);
  assert.equal(summary.successRate, 0.75, 'an absorbed rate limit is still a completed cycle');
});

test('summary: an unrecognised status is counted as unknown, not silently dropped', () => {
  const summary = summarizeCycleRuns([
    row({ cycleId: 'a', status: 'quantum', outcome: 'transcendent' }),
    row({ cycleId: 'b' }),
  ]);

  assert.equal(summary.total, 2);
  assert.equal(summary.byStatus.unknown, 1);
  assert.equal(summary.byOutcome.unknown, 1);
});

test('summary: a status colliding with an Object prototype key cannot corrupt the counts', () => {
  // `status in byStatus` would be true for "toString" and turn every figure into
  // NaN. Object.hasOwn is what keeps this a plain count.
  const summary = summarizeCycleRuns([
    row({ cycleId: 'a', status: 'toString', outcome: 'constructor' }),
    row({ cycleId: 'b', status: 'completed', outcome: 'published' }),
  ]);

  assert.equal(summary.byStatus.unknown, 1);
  assert.equal(summary.byStatus.completed, 1);
  assert.equal(summary.byOutcome.published, 1);
  assert.equal(Number.isFinite(summary.successRate), true);
  assert.equal(summary.successRate, 1);
});

test('summary: latest is the newest cycle by start time, whatever the input order', () => {
  const summary = summarizeCycleRuns([
    row({ cycleId: 'old', startedAt: '2026-08-11T07:00:00.000Z' }),
    row({ cycleId: 'new', startedAt: '2026-08-11T11:00:00.000Z', status: 'running' }),
    row({ cycleId: 'mid', startedAt: '2026-08-11T09:00:00.000Z' }),
  ]);

  assert.equal(summary.latest.cycleId, 'new');
  assert.equal(summary.latest.status, 'running');
});

// --- latestRun ---------------------------------------------------------------

test('latestRun: a row with an unusable timestamp can never be the latest', () => {
  const rows = [
    row({ cycleId: 'broken', startedAt: 'not a date' }),
    row({ cycleId: 'real', startedAt: '2026-08-11T09:00:00.000Z' }),
    row({ cycleId: 'missing', startedAt: null }),
  ];

  assert.equal(latestRun(rows).cycleId, 'real');
  assert.equal(latestRun([row({ startedAt: undefined })]), null);
  assert.equal(latestRun([]), null);
  assert.equal(latestRun(null), null);
});

// --- statusMeta --------------------------------------------------------------

test('statusMeta: labels the four known states and admits when it does not know', () => {
  assert.deepEqual(statusMeta('completed'), { label: 'Completed', tone: 'good', recorded: true });
  assert.deepEqual(statusMeta('running'), { label: 'Running', tone: 'info', recorded: true });
  assert.deepEqual(statusMeta('failed'), { label: 'Failed', tone: 'bad', recorded: true });
  assert.deepEqual(statusMeta('interrupted'), { label: 'Interrupted', tone: 'warn', recorded: true });

  // An unfamiliar value is shown verbatim rather than relabelled — inventing a
  // friendly name would hide that the backend reported something new.
  assert.deepEqual(statusMeta('quantum'), { label: 'quantum', tone: 'muted', recorded: true });

  for (const absent of [null, undefined, '']) {
    assert.deepEqual(statusMeta(absent), { label: 'Not recorded', tone: 'muted', recorded: false });
  }
});

// --- formatters --------------------------------------------------------------

test('formatRate: a whole percent, or the honest absence', () => {
  assert.equal(formatRate(0.75), '75%');
  assert.equal(formatRate(0), '0%', 'a measured zero rate is a real answer');
  assert.equal(formatRate(1), '100%');
  assert.equal(formatRate(0.666), '67%');
  for (const absent of [null, undefined, NaN, Infinity]) {
    assert.equal(formatRate(absent), NOT_AVAILABLE);
  }
});

test('formatCount: prints a real zero and refuses to invent one', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(12), '12');
  for (const absent of [null, undefined, NaN, '5', true]) {
    assert.equal(formatCount(absent), NOT_AVAILABLE);
  }
});

test('formatAverage: keeps the fraction that carries the meaning', () => {
  // "1.4" says most cycles decline to publish; rounding it to "1" would erase
  // the agent's editorial restraint.
  assert.equal(formatAverage(1.44), '1.4');
  assert.equal(formatAverage(2), '2');
  assert.equal(formatAverage(0), '0');
  assert.equal(formatAverage(null), NOT_AVAILABLE);
  assert.equal(formatAverage(undefined), NOT_AVAILABLE);
});
