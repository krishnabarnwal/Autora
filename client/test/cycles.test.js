import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCycles, findCycle, STAGE_STATUS } from '../src/lib/cycles.js';

/**
 * The cycle list, where three sources of evidence meet.
 *
 * These cover the tier the persistent history added: a traced cycle that gains a
 * durable row, a cycle the activity buffer no longer reaches that is rebuilt from
 * that row alone, and the guarantee that neither is ever presented as the other.
 *
 * Pure JavaScript under bare `node --test` — no bundler, no DOM, no dependency
 * added to the client. The components that render these objects are verified in
 * the browser instead; see the verification notes in the task report.
 */

/** /activity returns newest-first, so tests declare events in order and reverse. */
const buffer = (...events) => [...events].reverse();

const started = (cycleId, ts) => ({
  ts, level: 'info', tag: 'AGENT', message: 'Cycle started', data: { cycleId },
});

const complete = (cycleId, ts, data = {}) => ({
  ts, level: 'info', tag: 'SCHEDULER', message: 'Cycle complete',
  data: { cycleId, outcome: 'published', failed: false, nextDelayMs: 45_000, ...data },
});

const runRow = (cycleId, overrides = {}) => ({
  cycleId,
  status: 'completed',
  outcome: 'published',
  startedAt: '2026-08-11T09:00:00.000Z',
  completedAt: '2026-08-11T09:00:30.000Z',
  durationMs: 30_000,
  topicsDiscovered: 14,
  llmCalls: 2,
  provider: 'gemini',
  providerFailureCode: null,
  ...overrides,
});

test('cycles: a traced cycle keeps its trace and gains the durable row', () => {
  const cycles = buildCycles({
    events: buffer(
      started('c1', '2026-08-11T09:00:00.000Z'),
      complete('c1', '2026-08-11T09:00:20.000Z')
    ),
    runs: [runRow('c1', { durationMs: 30_000 })],
  });

  assert.equal(cycles.length, 1);
  const [cycle] = cycles;
  assert.equal(cycle.traced, true);
  assert.equal(cycle.partial, false);
  assert.ok(cycle.run, 'the durable row is attached for the drawer to show');
  assert.equal(cycle.run.provider, 'gemini');
  // The trace measured 20s between its own markers; the row must not overwrite it.
  assert.equal(cycle.durationMs, 20_000);
});

test('cycles: a durable row fills only what the trace could not say', () => {
  // The completion marker has aged out of the buffer, so the trace cannot report
  // how this cycle ended — the row can.
  const cycles = buildCycles({
    events: buffer(started('c1', '2026-08-11T09:00:00.000Z')),
    runs: [runRow('c1', { outcome: 'idle', status: 'completed' })],
  });

  const [cycle] = cycles;
  assert.equal(cycle.traced, true);
  assert.equal(cycle.partial, true, 'a missing marker is still a partial trace');
  assert.equal(cycle.outcome, 'idle');
  assert.equal(cycle.failed, false);
  assert.equal(cycle.completedAt, '2026-08-11T09:00:30.000Z');
  assert.equal(cycle.durationMs, 30_000);
});

test('cycles: a failed status fills the failure flag a missing marker left null', () => {
  const cycles = buildCycles({
    events: buffer(started('c1', '2026-08-11T09:00:00.000Z')),
    runs: [runRow('c1', { status: 'failed', outcome: 'failed', failureCode: 'rate_limited' })],
  });

  assert.equal(cycles[0].failed, true);
  assert.equal(cycles[0].outcome, 'failed');
});

test('cycles: an interrupted row leaves the failure flag unknown rather than false', () => {
  // Nobody knows what an interrupted cycle would have done; claiming it did not
  // fail is as wrong as claiming it did.
  const cycles = buildCycles({
    runs: [runRow('c1', { status: 'interrupted', outcome: null, completedAt: null, durationMs: null })],
  });

  assert.equal(cycles[0].failed, null);
  assert.equal(cycles[0].outcome, null);
  assert.equal(cycles[0].durationMs, null);
});

test('cycles: a cycle the buffer no longer reaches is rebuilt as untraced', () => {
  const cycles = buildCycles({ runs: [runRow('gone')] });

  assert.equal(cycles.length, 1);
  const [cycle] = cycles;
  assert.equal(cycle.cycleId, 'gone');
  assert.equal(cycle.traced, false, 'the stage trace is genuinely gone');
  assert.equal(cycle.partial, true);
  assert.equal(cycle.outcome, 'published');
  assert.equal(cycle.durationMs, 30_000);
  assert.equal(cycle.at, '2026-08-11T09:00:00.000Z');
  // Every stage reports "not recorded" — never that the stage did nothing.
  assert.equal(cycle.stages.length, 8);
  assert.ok(cycle.stages.every((s) => s.status === STAGE_STATUS.MISSING));
  assert.deepEqual(cycle.notices, []);
  assert.deepEqual(cycle.events, []);
});

test('cycles: traced and historical cycles interleave newest-first', () => {
  const cycles = buildCycles({
    events: buffer(
      started('live', '2026-08-11T12:00:00.000Z'),
      complete('live', '2026-08-11T12:00:30.000Z')
    ),
    runs: [
      runRow('older', { startedAt: '2026-08-11T09:00:00.000Z' }),
      runRow('newest', { startedAt: '2026-08-11T15:00:00.000Z' }),
      runRow('live', { startedAt: '2026-08-11T12:00:00.000Z' }),
    ],
  });

  assert.deepEqual(cycles.map((c) => c.cycleId), ['newest', 'live', 'older']);
  assert.deepEqual(cycles.map((c) => c.recency), [1, 2, 3]);
  assert.deepEqual(cycles.map((c) => c.traced), [false, true, false]);
});

test('cycles: a cycle with both a history row and a decision row appears once', () => {
  const cycles = buildCycles({
    runs: [runRow('c1', { outcome: 'idle' })],
    memory: [{ cycleId: 'c1', decision: 'rejected', reason: 'thin sourcing', createdAt: '2026-08-11T09:00:00.000Z' }],
  });

  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].outcome, 'idle');
  assert.equal(cycles[0].decision.reason, 'thin sourcing');
  assert.ok(cycles[0].run);
});

test('cycles: a traced cycle is never duplicated by its own history row', () => {
  const cycles = buildCycles({
    events: buffer(
      started('c1', '2026-08-11T09:00:00.000Z'),
      complete('c1', '2026-08-11T09:00:20.000Z')
    ),
    runs: [runRow('c1')],
    memory: [{ cycleId: 'c1', decision: 'published', reason: 'strong sourcing' }],
  });

  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].traced, true);
});

test('cycles: a repeated history row is read once, first occurrence winning', () => {
  const cycles = buildCycles({
    runs: [runRow('c1', { outcome: 'published' }), runRow('c1', { outcome: 'idle' })],
  });

  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].outcome, 'published');
});

test('cycles: a row with no cycleId cannot be joined and is not listed', () => {
  // Nothing can be said about which execution it belongs to, and inventing a
  // cycle for it would put an unidentifiable entry in the list.
  const cycles = buildCycles({ runs: [runRow(null), runRow(undefined), runRow('real')] });

  assert.deepEqual(cycles.map((c) => c.cycleId), ['real']);
});

test('cycles: a historical cycle joins the post it published', () => {
  const cycles = buildCycles({
    runs: [runRow('c1', { postId: 'p_1' })],
    posts: [{ id: 'p_1', topic: 'A published topic' }],
  });

  assert.equal(cycles[0].postId, 'p_1');
  assert.equal(cycles[0].post.topic, 'A published topic');
});

test('cycles: with no history rows the list behaves exactly as it did before', () => {
  // The pre-existing tiers, unchanged: a traced cycle, and a decision-only cycle
  // whose postId is the only proof it published.
  const cycles = buildCycles({
    events: buffer(
      started('live', '2026-08-11T12:00:00.000Z'),
      complete('live', '2026-08-11T12:00:30.000Z')
    ),
    memory: [{ cycleId: 'remembered', postId: 'p_9', createdAt: '2026-08-11T09:00:00.000Z' }],
    posts: [{ id: 'p_9', topic: 'Older topic' }],
  });

  assert.deepEqual(cycles.map((c) => c.cycleId), ['live', 'remembered']);
  assert.equal(cycles[0].run, null, 'no history row means no persistent record to show');
  assert.equal(cycles[1].run, null);
  assert.equal(cycles[1].traced, false);
  assert.equal(cycles[1].outcome, 'published');
});

test('cycles: an empty input produces an empty list, not a placeholder cycle', () => {
  assert.deepEqual(buildCycles({}), []);
  assert.deepEqual(buildCycles(), []);
  assert.deepEqual(buildCycles({ events: [], memory: [], posts: [], runs: [] }), []);
});

test('cycles: the drawer can still find a historical cycle by id', () => {
  const cycles = buildCycles({
    events: buffer(
      started('live', '2026-08-11T12:00:00.000Z'),
      complete('live', '2026-08-11T12:00:30.000Z')
    ),
    runs: [runRow('gone', { startedAt: '2026-08-11T06:00:00.000Z' })],
  });

  assert.equal(findCycle(cycles, 'gone').cycleId, 'gone');
  assert.equal(findCycle(cycles, 'live').traced, true);
  assert.equal(findCycle(cycles, 'never'), null);
  assert.equal(findCycle(cycles, null), null);
});
