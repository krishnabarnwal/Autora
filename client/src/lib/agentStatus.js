/**
 * The agent's status as a visitor should read it: one of four plain words.
 *
 * The dashboard already derives rich per-subsystem health (lib/health.js) and the
 * scheduler's own failure streak. This module answers the blunter question a
 * recruiter asks in the first ten seconds — "is this thing actually running?" —
 * and answers it honestly, without hiding a failure behind a green light.
 *
 * Four states, and the rule for each:
 *
 *   online      the backend answers and the agent is cycling with no recent
 *               failure streak.
 *   degraded    it is still running, but the last cycle failed or a streak of
 *               attempts has failed since — the loop retries on its own, so this
 *               is "struggling", not "stopped".
 *   offline     the backend is unreachable or reports not-ready, or the loop is
 *               paused. Nothing is turning.
 *   connecting  we have not heard enough yet — no health response, no agent, or a
 *               status we do not recognise. Never claimed as online or offline.
 *
 * Pure and total: given nothing it returns `connecting`, never a healthy-looking
 * default. Everything it reads is a real backend field.
 */

import { failureStreak } from './health.js';

/** The four product-level states, and the tone each is drawn in. */
export const PRODUCT_STATUS = {
  online: { label: 'Online', tone: 'good' },
  degraded: { label: 'Degraded', tone: 'warn' },
  offline: { label: 'Offline', tone: 'bad' },
  connecting: { label: 'Connecting', tone: 'muted' },
};

function status(state, extra = {}) {
  const { label, tone } = PRODUCT_STATUS[state] || PRODUCT_STATUS.connecting;
  return { state, label, tone, ...extra };
}

/**
 * @param {object}  input
 * @param {object=} input.agent   the agent record (reads `.status` only).
 * @param {object=} input.health  the /api/health polling query ({data,error,stale}).
 * @param {Array=}  input.events  /activity events, for the scheduler failure streak.
 * @returns {{state:string,label:string,tone:string,detail?:string,streak?:object}}
 */
export function productStatus({ agent, health, events } = {}) {
  const backendReachable = Boolean(health?.data);
  const backendOk = health?.data?.ok === true;

  // Can't reach the backend at all. An errored query is offline; a query that
  // simply has not answered yet is still connecting.
  if (!backendReachable) {
    if (health?.error) return status('offline', { detail: 'The backend is not answering.' });
    return status('connecting', { detail: 'Contacting the backend…' });
  }

  // The backend answers but reports it is not ready to serve.
  if (!backendOk) return status('offline', { detail: 'The backend reports it is not ready.' });

  const agentStatus = agent?.status ?? null;

  // Backend is up, but no agent has been created yet.
  if (!agentStatus) return status('connecting', { detail: 'No agent has been initialized yet.' });

  if (agentStatus === 'paused') {
    return status('offline', { detail: 'The autonomous loop is paused.' });
  }
  if (agentStatus === 'error') {
    return status('degraded', {
      detail: 'The last cycle failed. Autora retries on its backoff policy.',
    });
  }
  if (agentStatus === 'initializing') {
    return status('connecting', { detail: 'Starting up — no cycle has completed yet.' });
  }

  // Cycling. A recorded streak of consecutive failures means it is running but
  // struggling; that is degradation the reader should see, not an outage.
  const streak = failureStreak(events);
  if (streak && streak.value > 0) {
    return status('degraded', {
      detail: `Running, but ${streak.value} recent cycle attempt(s) failed. Autora retries on its backoff policy.`,
      streak,
    });
  }
  if (agentStatus === 'autonomous') {
    return status('online', { detail: 'Running autonomously on its configured cadence.', streak });
  }

  // A status the backend introduced that this file has not been taught. Do not
  // pretend to know whether it is up or down.
  return status('connecting', { detail: `Reported status: ${agentStatus}.` });
}
