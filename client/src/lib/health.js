/**
 * Per-subsystem health, derived from what the backend already reports.
 *
 * Five subsystems, five sources of truth, no third one invented:
 *
 *   Backend / API   GET /api/health — `ok`, plus the query's own error state.
 *   MongoDB         health.database — `status`, `healthy`, `ping`.
 *   LLM provider    health.llmConfigured, plus the provider failures the LLM,
 *                   EDITOR and WRITER tags actually logged.
 *   Scheduler       the Agent document — status, lastCycleAt, nextCycleAt,
 *                   cycleIntervalMs, stats, lastError — plus the failure streak
 *                   the scheduler puts in its own 'Cycle complete' event.
 *   Breeth          health.breethEnabled, plus BREETH-tagged failures.
 *
 * Every function here is pure and total: given no data it returns the `unknown`
 * verdict rather than a healthy-looking default. A subsystem the dashboard has
 * not heard from says so — it never reads as green by omission.
 */

import { classifyEvent } from './format.js';

/** The verdict vocabulary, and the tone each verdict is drawn in. */
export const VERDICT = {
  healthy: { label: 'Healthy', tone: 'good' },
  degraded: { label: 'Degraded', tone: 'warn' },
  error: { label: 'Error', tone: 'bad' },
  paused: { label: 'Paused', tone: 'warn' },
  starting: { label: 'Starting', tone: 'info' },
  rate_limited: { label: 'Rate limited', tone: 'warn' },
  not_configured: { label: 'Not configured', tone: 'warn' },
  enabled: { label: 'Enabled', tone: 'info' },
  disabled: { label: 'Disabled', tone: 'muted' },
  unreachable: { label: 'Unreachable', tone: 'bad' },
  unknown: { label: 'Unknown', tone: 'muted' },
};

function verdict(key, extra = {}) {
  const { label, tone } = VERDICT[key] || VERDICT.unknown;
  return { state: key, label, tone, ...extra };
}

/** Backend / API — the health endpoint answering at all, and what it says. */
export function backendHealth(health) {
  const data = health?.data;
  if (!data) {
    if (health?.error) return verdict('unreachable', { detail: 'The health endpoint did not answer.' });
    return verdict('unknown', { detail: 'No health response read yet.' });
  }
  if (data.ok === false) {
    return verdict('error', { detail: 'The service reports it is not ready to serve.' });
  }
  if (health.stale) {
    return verdict('degraded', { detail: 'Answering, but the most recent refresh failed.' });
  }
  return verdict('healthy', { detail: `Serving ${data.service || 'the API'} in ${data.env || 'an unnamed'} mode.` });
}

/** MongoDB — the persistence the whole autonomy claim rests on. */
export function databaseHealth(health) {
  const data = health?.data;
  if (!data) return verdict('unknown', { detail: 'No health response read yet.' });
  if (data.databaseConfigured === false) {
    return verdict('not_configured', { detail: 'No connection string is configured.' });
  }

  const db = data.database || {};
  const status = db.status || 'unknown';
  if (db.healthy) {
    const latency = db.ping?.ok ? `ping ${db.ping.latencyMs}ms` : null;
    return verdict('healthy', { detail: `Connection ${status}.`, hint: latency });
  }
  return verdict('error', {
    detail: `Connection ${status}.`,
    hint: db.ping?.error || 'The ping did not succeed.',
  });
}

/**
 * Provider failures, exactly as the backend logs them.
 *
 * Three real call sites reach the activity buffer with a failed provider call:
 * retry.js logs '<provider> call failed, retrying (n/m)' under LLM, editorial
 * logs 'Editorial call failed (code)' under EDITOR, and generation logs
 * 'Generation call failed (code -> code)' under WRITER. All three carry the
 * sanitized taxonomy code in `data.code`. Matching on those tags and that phrase
 * is a read of the backend's own wording, not a guess about it.
 */
const PROVIDER_TAGS = new Set(['LLM', 'EDITOR', 'WRITER']);
const PROVIDER_FAILURE = /call failed/i;
const LOUD_LEVELS = new Set(['warn', 'error']);

export function isProviderFailure(event) {
  const tag = String(event?.tag ?? '').toUpperCase();
  if (!PROVIDER_TAGS.has(tag)) return false;
  if (!LOUD_LEVELS.has(event?.level)) return false;
  return PROVIDER_FAILURE.test(String(event?.message ?? ''));
}

/** Milliseconds for an event, or -Infinity so a timestamped event always wins. */
function eventTime(event) {
  const parsed = Date.parse(event?.ts ?? '');
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

/**
 * The newest matching event by its own timestamp.
 *
 * The API already returns the buffer newest-first, but ordering is its promise
 * rather than this module's, and a health verdict that silently inverts if that
 * promise ever changes is not worth the saved comparison.
 */
function newestMatch(events, predicate) {
  let best = null;
  let bestAt = -Infinity;
  for (const event of events || []) {
    if (!predicate(event)) continue;
    const at = eventTime(event);
    if (best === null || at > bestAt) {
      best = event;
      bestAt = at;
    }
  }
  return best;
}

/** The scheduler's own completion events, which carry the cycle's verdict. */
const isCycleComplete = (event) =>
  String(event?.tag ?? '').toUpperCase() === 'SCHEDULER' &&
  String(event?.message ?? '') === 'Cycle complete';

/**
 * The consecutive-failure streak, read from the scheduler's own log line.
 *
 * The worker holds this counter in process memory and folds no copy of it into
 * the Agent document, so the buffered 'Cycle complete' event — which logs it
 * alongside the outcome — is the only place it is observable. That makes it
 * genuinely ephemeral: absent after a restart, and absent once 300 newer events
 * have pushed it out. Returning null for "not observed" rather than 0 keeps the
 * UI from reporting a clean streak it never actually saw.
 */
export function failureStreak(events) {
  const event = newestMatch(
    events,
    (e) =>
      String(e?.tag ?? '').toUpperCase() === 'SCHEDULER' &&
      Number.isFinite(e?.data?.consecutiveFailures)
  );
  if (!event) return null;
  return { value: event.data.consecutiveFailures, at: event.ts };
}

/**
 * LLM provider — configured, and whether its last observed call failed.
 *
 * Recovery is the interesting half. A rate limit ten minutes ago followed by a
 * clean cycle is not a current outage, so a completed cycle that came *after*
 * the newest provider failure clears the verdict back to healthy and keeps the
 * failure visible as a count. The 429s are never hidden; they are dated.
 */
export function providerHealth({ health, events }) {
  const data = health?.data;
  if (!data) return verdict('unknown', { detail: 'No health response read yet.' });
  if (!data.llmConfigured) {
    return verdict('not_configured', {
      detail: 'No API key is set, so the agent cannot call a model.',
    });
  }

  const model = `${data.llmProvider || 'provider'} · ${data.llmModel || 'model'}`;
  const failure = newestMatch(events, (e) => classifyEvent(e) === 'rate_limited' || isProviderFailure(e));
  if (!failure) {
    return verdict('healthy', { detail: model, hint: 'No provider failure in the current buffer.' });
  }

  const cleanCycle = newestMatch(events, (e) => isCycleComplete(e) && e?.data?.failed === false);
  if (cleanCycle && eventTime(cleanCycle) > eventTime(failure)) {
    return verdict('healthy', {
      detail: model,
      hint: 'A cycle completed cleanly after the last provider failure.',
      since: failure.ts,
    });
  }

  const state = classifyEvent(failure) === 'rate_limited' ? 'rate_limited' : 'error';
  return verdict(state, {
    detail: model,
    hint: failure.message,
    since: failure.ts,
    code: typeof failure.data?.code === 'string' ? failure.data.code : null,
  });
}

/**
 * The autonomous loop: is it running, recovering, broken, or stopped?
 *
 * `status` is the persisted verdict — the worker writes 'error' after a failed
 * cycle and 'autonomous' after a clean one — so it answers most of this on its
 * own. The streak adds the one case status cannot express: a worker that is
 * failing to even reload its agent increments the counter and writes nothing, so
 * the document still reads 'autonomous' while the loop is not actually turning.
 */
export function schedulerHealth({ agent, lastError, events }) {
  const streak = failureStreak(events);

  if (!agent) {
    return { ...verdict('unknown', { detail: 'No agent has been initialized.' }), streak };
  }

  if (agent.status === 'paused') {
    return {
      ...verdict('paused', { detail: 'The loop is stopped. It resumes when the agent is set active again.' }),
      streak,
    };
  }

  if (agent.status === 'error') {
    return {
      ...verdict('error', {
        detail: 'The last cycle failed.',
        hint: lastError?.message || null,
        since: lastError?.at || null,
      }),
      streak,
    };
  }

  if (agent.status === 'initializing' || !agent.lastCycleAt) {
    return {
      ...verdict('starting', { detail: 'No cycle has completed yet.' }),
      streak,
    };
  }

  if (streak && streak.value > 0) {
    return {
      ...verdict('degraded', {
        detail: `The last recorded cycle succeeded, but ${streak.value} attempt(s) have failed since.`,
        hint: 'The worker backs off exponentially and retries on its own.',
      }),
      streak,
    };
  }

  return {
    ...verdict('healthy', { detail: 'The loop is running on its configured cadence.' }),
    streak,
  };
}

/** Breeth — optional by design, so "off" is a configuration state, not a fault. */
export function breethHealth({ health, events }) {
  const data = health?.data;
  if (!data) return verdict('unknown', { detail: 'No health response read yet.' });
  if (!data.breethEnabled) {
    return verdict('disabled', { detail: 'Strategic memory is off. The agent runs without it.' });
  }

  const latest = newestMatch(events, (e) => String(e?.tag ?? '').toUpperCase() === 'BREETH');
  if (!latest) {
    return verdict('enabled', { detail: 'Enabled. No strategic-memory call in the current buffer.' });
  }
  if (LOUD_LEVELS.has(latest.level)) {
    return verdict('degraded', {
      detail: 'The last strategic-memory call did not succeed.',
      hint: `${latest.message} — the cycle continues without strategic memory.`,
      since: latest.ts,
    });
  }
  return verdict('healthy', { detail: 'The last strategic-memory call succeeded.', since: latest.ts });
}

/**
 * The five subsystems, in dependency order: the API answers, the database backs
 * it, the provider feeds the loop, the loop drives the agent, and Breeth is the
 * optional layer on top.
 */
export function deriveSubsystems({ health, agent, lastError, events }) {
  return [
    { key: 'api', name: 'Backend / API', source: 'GET /api/health', ...backendHealth(health) },
    { key: 'database', name: 'MongoDB', source: 'health.database', ...databaseHealth(health) },
    { key: 'provider', name: 'LLM provider', source: 'health + activity', ...providerHealth({ health, events }) },
    { key: 'scheduler', name: 'Autonomous scheduler', source: 'GET /api/agent/:id', ...schedulerHealth({ agent, lastError, events }) },
    { key: 'breeth', name: 'Strategic memory', source: 'health + activity', ...breethHealth({ health, events }) },
  ];
}

/** The worst verdict across the five, for a one-line summary. */
const SEVERITY = {
  error: 4,
  unreachable: 4,
  degraded: 3,
  rate_limited: 3,
  paused: 3,
  not_configured: 2,
  starting: 1,
  unknown: 1,
  disabled: 0,
  enabled: 0,
  healthy: 0,
};

export function worstOf(subsystems) {
  let worst = null;
  for (const item of subsystems) {
    if (!worst || (SEVERITY[item.state] ?? 0) > (SEVERITY[worst.state] ?? 0)) worst = item;
  }
  return worst;
}
