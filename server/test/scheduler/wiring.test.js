import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { startTestServer, stopTestServer, post } from '../helpers/http.js';
import {
  setAgentInitializedHandler,
  getAgentInitializedHandler,
  notifyAgentInitialized,
} from '../../src/utils/agentEvents.js';
import { Scheduler } from '../../src/scheduler/index.js';

/**
 * Phase 12 — how a newly created agent reaches the scheduler.
 *
 * The route must not import the scheduler (test/routes/feed.test.js enforces
 * that: a static edge from the request path to the worker would pull the whole
 * LLM stack into it), so the dependency is inverted through a leaf event module.
 * These tests pin every side of that contract: the route announces an init, an
 * installed handler receives it, bootstrap's handler shape registers a worker,
 * and with nothing listening the endpoint stays inert.
 */

const ADA = { persona: { name: 'Ada', domain: 'AI Security' } };
const silent = { debug() {}, info() {}, warn() {}, error() {} };

test.before(async () => {
  await startTestDb();
  await startTestServer();
});
test.after(async () => {
  setAgentInitializedHandler(null); // never leak a handler into another suite
  await stopTestServer();
  await stopTestDb();
});
test.beforeEach(async () => {
  await clearTestDb();
  setAgentInitializedHandler(null);
});

// --- The seam itself ----------------------------------------------------------

test('the event seam is empty by default, so a notification is a no-op', () => {
  assert.equal(getAgentInitializedHandler(), null);
  assert.equal(notifyAgentInitialized('agt_nobody'), false, 'nothing is listening');
});

test('the seam invokes an installed handler and can be cleared again', () => {
  const seen = [];
  setAgentInitializedHandler((id) => seen.push(id));

  assert.equal(notifyAgentInitialized('agt_a'), true);
  assert.deepEqual(seen, ['agt_a']);

  setAgentInitializedHandler(null);
  assert.equal(notifyAgentInitialized('agt_b'), false);
  assert.deepEqual(seen, ['agt_a'], 'a cleared handler receives nothing');
});

// --- The route side -----------------------------------------------------------

test('init announces the new agent to whatever is listening', async () => {
  const announced = [];
  setAgentInitializedHandler((id) => announced.push(id));

  const res = await post('/api/agent/init', ADA);

  assert.equal(res.status, 201);
  assert.deepEqual(announced, [res.body.agentId], 'the new agent begins cycling at once');
});

test('a repeat init announces the same agentId again (the scheduler dedupes)', async () => {
  const announced = [];
  setAgentInitializedHandler((id) => announced.push(id));

  const first = await post('/api/agent/init', ADA);
  const second = await post('/api/agent/init', ADA);

  assert.equal(second.status, 200, 'the second call reuses the agent');
  assert.equal(second.body.agentId, first.body.agentId);
  // The route announces every init; register()'s own idempotency (proved in
  // index.test.js) is what guarantees a single worker, so a repeat is harmless.
  assert.deepEqual(announced, [first.body.agentId, first.body.agentId]);
});

test('a handler that throws never fails the request', async () => {
  setAgentInitializedHandler(() => { throw new Error('scheduler exploded'); });

  const res = await post('/api/agent/init', ADA);

  assert.equal(res.status, 201, 'the agent is persisted and the contract shape is returned');
  assert.match(res.body.agentId, /^agt_[0-9a-f]{16}$/);
});

test('with nothing listening the route is inert', async () => {
  assert.equal(getAgentInitializedHandler(), null);

  const res = await post('/api/agent/init', ADA);

  assert.equal(res.status, 201, 'the API behaves identically with no autonomous loop running');
  assert.deepEqual(Object.keys(res.body), ['agentId']);
});

// --- Bootstrap's wiring shape, without booting a server ----------------------

test('bootstrap\'s handler shape registers an immediate worker for a new agent', async () => {
  // Exactly what bootstrap installs: id => scheduler.register(id). The worker is
  // faked so no timer is armed and no cycle runs.
  const started = [];
  const scheduler = new Scheduler({
    findResumable: async () => [],
    logger: silent,
    createWorker: (agentId) => ({
      agentId,
      stopped: true,
      start() { this.stopped = false; started.push(agentId); return this; },
      stop() { this.stopped = true; return this; },
    }),
  });
  scheduler.start();
  setAgentInitializedHandler((agentId) => scheduler.register(agentId));

  const res = await post('/api/agent/init', ADA);
  const agentId = res.body.agentId;

  assert.equal(scheduler.size, 1, 'the agent has exactly one worker');
  assert.deepEqual(started, [agentId], 'and it was started immediately');

  // A second init must not produce a rival worker for the same agent.
  await post('/api/agent/init', ADA);
  assert.equal(scheduler.size, 1);
  assert.deepEqual(started, [agentId], 'the running loop was not restarted');

  scheduler.stopAll();
});
