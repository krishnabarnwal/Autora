import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import {
  CycleRun,
  CYCLE_RUN_DECISIONS,
  CYCLE_RUN_OUTCOMES,
  CYCLE_RUN_STATUS,
} from '../../src/models/index.js';
import { OUTCOME } from '../../src/services/agent/runCycle.js';
import { DECISIONS } from '../../src/services/editorial/schema.js';

/**
 * The durable execution record.
 *
 * These run against a real MongoDB so the unique constraint on cycleId and the
 * history index are exercised by the engine rather than asserted from the schema
 * definition — a declared index that was never built would pass the second kind
 * of test and fail in production.
 */

const AGENT_ID = 'agt_7777777777777777';
const OTHER_AGENT = 'agt_8888888888888888';

function makeRun(overrides = {}) {
  return {
    agentId: AGENT_ID,
    cycleId: 'cyc_000000000001',
    status: 'completed',
    outcome: 'published',
    startedAt: new Date('2026-08-11T09:00:00.000Z'),
    completedAt: new Date('2026-08-11T09:00:42.000Z'),
    durationMs: 42_000,
    topicsDiscovered: 24,
    topicsAfterFilter: 9,
    topicsSelected: 1,
    postsPublished: 1,
    llmCalls: 2,
    decision: 'publish',
    decisionScore: 84,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    postId: 'p_abcdef123456',
    ...overrides,
  };
}

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

test('cycleRun: stores one completed execution with its metrics', async () => {
  const run = await CycleRun.create(makeRun());
  assert.equal(run.agentId, AGENT_ID);
  assert.equal(run.status, 'completed');
  assert.equal(run.outcome, 'published');
  assert.equal(run.durationMs, 42_000);
  assert.equal(run.llmCalls, 2);
  assert.equal(run.decisionScore, 84);
  assert.equal(run.postId, 'p_abcdef123456');
});

test('cycleRun: agentId, cycleId and startedAt are required', async () => {
  await assert.rejects(CycleRun.create(makeRun({ agentId: undefined })));
  await assert.rejects(CycleRun.create(makeRun({ cycleId: undefined })));
  await assert.rejects(CycleRun.create(makeRun({ startedAt: undefined })));
});

test('cycleRun: a row opens as running with no outcome and no metrics', async () => {
  // What the worker writes at cycle start: everything downstream is genuinely
  // unknown at that moment, and null says so where 0 would be a measurement.
  const run = await CycleRun.create({
    agentId: AGENT_ID,
    cycleId: 'cyc_000000000002',
    startedAt: new Date(),
  });
  assert.equal(run.status, 'running');
  assert.equal(run.outcome, null);
  assert.equal(run.completedAt, null);
  assert.equal(run.durationMs, null);
  assert.equal(run.topicsDiscovered, null);
  assert.equal(run.llmCalls, null);
  assert.equal(run.decision, null);
  assert.equal(run.decisionScore, null);
});

test('cycleRun: rejects an unknown status, outcome or decision', async () => {
  await assert.rejects(CycleRun.create(makeRun({ status: 'finished' })));
  await assert.rejects(CycleRun.create(makeRun({ outcome: 'posted' })));
  await assert.rejects(CycleRun.create(makeRun({ decision: 'maybe' })));
});

test('cycleRun: rejects a negative metric', async () => {
  await assert.rejects(CycleRun.create(makeRun({ topicsDiscovered: -1 })));
  await assert.rejects(CycleRun.create(makeRun({ durationMs: -5 })));
});

test('cycleRun: cycleId is unique, so a cycle cannot be recorded twice', async () => {
  await CycleRun.create(makeRun());
  await assert.rejects(
    CycleRun.create(makeRun({ agentId: OTHER_AGENT, cycleId: 'cyc_000000000001' })),
    /duplicate key|E11000/
  );
});

test('cycleRun: the declared indexes exist in the database', async () => {
  const names = (await mongoose.connection.db.collection('cycleruns').indexes()).map((i) =>
    JSON.stringify(i.key)
  );
  // The history query and the recovery sweep both depend on a compound index;
  // without them this collection degrades to a collection scan per poll.
  assert.ok(names.includes(JSON.stringify({ cycleId: 1 })), 'cycleId index missing');
  assert.ok(names.includes(JSON.stringify({ agentId: 1, startedAt: -1 })), 'history index missing');
  assert.ok(names.includes(JSON.stringify({ status: 1, startedAt: 1 })), 'recovery index missing');
});

test('cycleRun: the status vocabulary matches what the worker can write', async () => {
  assert.deepEqual(CYCLE_RUN_STATUS, ['running', 'completed', 'failed', 'interrupted']);
  // Outcome and decision are the pipeline's own vocabularies. If runCycle gains
  // an outcome, this fails rather than silently recording it as null.
  assert.deepEqual([...CYCLE_RUN_OUTCOMES].sort(), [...Object.values(OUTCOME)].sort());
  assert.deepEqual([...CYCLE_RUN_DECISIONS].sort(), [...Object.values(DECISIONS)].sort());
});

test('cycleRun: historyFor returns newest first, scoped to one agent', async () => {
  await CycleRun.create(makeRun({ cycleId: 'c1', startedAt: new Date('2026-08-11T07:00:00Z') }));
  await CycleRun.create(makeRun({ cycleId: 'c2', startedAt: new Date('2026-08-11T08:00:00Z') }));
  await CycleRun.create(makeRun({ cycleId: 'c3', startedAt: new Date('2026-08-11T09:00:00Z') }));
  await CycleRun.create(
    makeRun({ agentId: OTHER_AGENT, cycleId: 'other', startedAt: new Date('2026-08-11T10:00:00Z') })
  );

  const rows = await CycleRun.historyFor(AGENT_ID, { limit: 10 });
  assert.deepEqual(
    rows.map((r) => r.cycleId),
    ['c3', 'c2', 'c1']
  );
});

test('cycleRun: historyFor honours the before cursor and the limit', async () => {
  for (let i = 1; i <= 5; i += 1) {
    await CycleRun.create(
      makeRun({ cycleId: `c${i}`, startedAt: new Date(Date.UTC(2026, 7, 11, i, 0, 0)) })
    );
  }

  const firstPage = await CycleRun.historyFor(AGENT_ID, { limit: 2 });
  assert.deepEqual(
    firstPage.map((r) => r.cycleId),
    ['c5', 'c4']
  );

  // The cursor is exclusive: paging must not repeat the row it was taken from.
  const secondPage = await CycleRun.historyFor(AGENT_ID, {
    limit: 2,
    before: firstPage[1].startedAt,
  });
  assert.deepEqual(
    secondPage.map((r) => r.cycleId),
    ['c3', 'c2']
  );
});

test('cycleRun: markInterrupted closes rows a dead process left open', async () => {
  await CycleRun.create(
    makeRun({ cycleId: 'stranded', status: 'running', outcome: null, completedAt: null, durationMs: null })
  );
  await CycleRun.create(makeRun({ cycleId: 'finished' }));

  const result = await CycleRun.markInterrupted({ startedBefore: new Date('2026-08-11T12:00:00Z') });
  assert.equal(result.modifiedCount, 1);

  const stranded = await CycleRun.findOne({ cycleId: 'stranded' });
  assert.equal(stranded.status, 'interrupted');
  assert.equal(stranded.failureCode, 'process_restart');
  // No invented completion: nobody knows when or whether that cycle ended.
  assert.equal(stranded.completedAt, null);
  assert.equal(stranded.durationMs, null);

  const finished = await CycleRun.findOne({ cycleId: 'finished' });
  assert.equal(finished.status, 'completed', 'a completed row must not be rewritten');
});

test('cycleRun: markInterrupted leaves a cycle started after the cutoff alone', async () => {
  // The sweep runs at boot and must not touch a row the new process just opened.
  await CycleRun.create(
    makeRun({ cycleId: 'live', status: 'running', outcome: null, completedAt: null, durationMs: null })
  );
  const result = await CycleRun.markInterrupted({
    startedBefore: new Date('2026-08-11T08:00:00.000Z'),
  });
  assert.equal(result.modifiedCount, 0);
  const live = await CycleRun.findOne({ cycleId: 'live' });
  assert.equal(live.status, 'running');
});

test('cycleRun: toPublicJSON exposes counts and codes, never prompts or bodies', async () => {
  const run = await CycleRun.create(
    makeRun({ failureCode: null, failureMessage: null, providerFailureCode: 'rate_limited' })
  );
  const json = run.toPublicJSON();

  assert.equal(json.cycleId, 'cyc_000000000001');
  assert.equal(json.providerFailureCode, 'rate_limited');
  assert.equal(json.startedAt, run.startedAt.toISOString());

  // The schema has nowhere to put a prompt or an article body, and the response
  // shape is the place that guarantee is enforced.
  const serialized = JSON.stringify(json);
  for (const forbidden of ['prompt', 'content', 'body', 'apiKey', 'markdown']) {
    assert.ok(!serialized.includes(forbidden), `toPublicJSON leaked a ${forbidden} field`);
  }
});
