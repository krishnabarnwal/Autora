import test from 'node:test';
import assert from 'node:assert/strict';
import { productStatus, PRODUCT_STATUS } from '../src/lib/agentStatus.js';

/**
 * The product-level status a visitor reads: online / degraded / offline /
 * connecting. Pure JavaScript under bare `node --test`, like the other client
 * lib tests — no bundler, no DOM, no dependency added.
 *
 * What is under test is mostly restraint: it never claims "online" without a
 * cycling agent behind a reachable backend, never claims "offline" when it simply
 * has not heard yet, and surfaces a failure streak as degradation rather than a
 * green light.
 */

/** A health query that answers ok. */
const healthOk = { data: { ok: true, service: 'api' }, error: null };
/** A scheduler completion event carrying a consecutive-failure count. */
const streakEvent = (n, ts = '2026-08-11T09:00:00.000Z') => ({
  ts, level: 'info', tag: 'SCHEDULER', message: 'Cycle complete',
  data: { consecutiveFailures: n },
});

test('status: a cycling agent behind a healthy backend is online', () => {
  const s = productStatus({ agent: { status: 'autonomous' }, health: healthOk, events: [] });
  assert.equal(s.state, 'online');
  assert.equal(s.label, PRODUCT_STATUS.online.label);
  assert.equal(s.tone, 'good');
});

test('status: a failure streak makes a running agent degraded, not offline', () => {
  const s = productStatus({
    agent: { status: 'autonomous' },
    health: healthOk,
    events: [streakEvent(3)],
  });
  assert.equal(s.state, 'degraded');
  assert.equal(s.tone, 'warn');
  assert.match(s.detail, /3 recent cycle attempt/);
  assert.equal(s.streak.value, 3);
});

test('status: a streak of zero is not degradation', () => {
  const s = productStatus({
    agent: { status: 'autonomous' },
    health: healthOk,
    events: [streakEvent(0)],
  });
  assert.equal(s.state, 'online');
});

test('status: an errored last cycle is degraded — the loop still retries', () => {
  const s = productStatus({ agent: { status: 'error' }, health: healthOk, events: [] });
  assert.equal(s.state, 'degraded');
  assert.match(s.detail, /backoff/);
});

test('status: a paused loop is offline', () => {
  const s = productStatus({ agent: { status: 'paused' }, health: healthOk, events: [] });
  assert.equal(s.state, 'offline');
  assert.equal(s.tone, 'bad');
});

test('status: an unreachable backend is offline', () => {
  const s = productStatus({
    agent: { status: 'autonomous' },
    health: { data: null, error: { code: 'network' } },
    events: [],
  });
  assert.equal(s.state, 'offline');
});

test('status: a backend that answers not-ready is offline', () => {
  const s = productStatus({ agent: { status: 'autonomous' }, health: { data: { ok: false } } });
  assert.equal(s.state, 'offline');
});

test('status: no health response yet is connecting, not offline', () => {
  const s = productStatus({ agent: null, health: { data: null, error: null }, events: [] });
  assert.equal(s.state, 'connecting');
});

test('status: backend up but no agent yet is connecting', () => {
  const s = productStatus({ agent: null, health: healthOk, events: [] });
  assert.equal(s.state, 'connecting');
  assert.match(s.detail, /No agent/);
});

test('status: an initializing agent is connecting', () => {
  const s = productStatus({ agent: { status: 'initializing' }, health: healthOk, events: [] });
  assert.equal(s.state, 'connecting');
});

test('status: an unrecognised agent status is never claimed as online or offline', () => {
  const s = productStatus({ agent: { status: 'quantum' }, health: healthOk, events: [] });
  assert.equal(s.state, 'connecting');
  assert.match(s.detail, /quantum/);
});

test('status: called with nothing, it connects rather than throwing', () => {
  const s = productStatus();
  assert.equal(s.state, 'connecting');
  const s2 = productStatus({});
  assert.equal(s2.state, 'connecting');
});
