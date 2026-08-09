/**
 * Single place that knows how to reach the backend.
 *
 * Locally VITE_API_BASE_URL is empty and Vite proxies /api to :5000.
 * In production it is set to the deployed backend origin.
 *
 * Every function here is a read except initAgent. The dashboard never asks the
 * backend to run a cycle, publish, or change the agent's lifecycle — the agent
 * decides that on its own schedule, and the UI only reports what it did.
 */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

/**
 * Failures carry the backend's error slug so a caller can distinguish "this
 * agent does not exist" from "the server is down" without parsing prose.
 */
export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? null;
    this.code = code ?? null;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (cause) {
    // fetch only rejects when the request never completed: server down, DNS,
    // or a dropped connection. Say that plainly rather than "failed to fetch".
    throw new ApiError('Cannot reach the backend.', { code: 'network_error' });
  }

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message = body?.message || body?.error || `Request failed (${response.status})`;
    throw new ApiError(message, { status: response.status, code: body?.error });
  }
  return body;
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
};

/** Health, config flags, and database reachability. 503 when the DB is down. */
export function getHealth() {
  return request('/api/health');
}

/** Every agent, newest first. */
export function listAgents({ limit } = {}) {
  return request(`/api/agent${qs({ limit })}`);
}

/** One agent's persisted state plus on-disk post and memory counts. */
export function getAgent(agentId) {
  return request(`/api/agent/${encodeURIComponent(agentId)}`);
}

/** Published posts, newest first — the same contract feed judges evaluate. */
export function getFeed(agentId, { limit, before } = {}) {
  return request(`/api/agent/feed${qs({ agentId, limit, before })}`);
}

/** The worker's in-memory activity log. Process-local, wiped on restart. */
export function getActivity(agentId, { limit, scope } = {}) {
  return request(`/api/agent/${encodeURIComponent(agentId)}/activity${qs({ limit, scope })}`);
}

/** Editorial decisions (published, rejected, deferred) plus totals by outcome. */
export function getMemory(agentId, { limit, days, decision } = {}) {
  return request(`/api/agent/${encodeURIComponent(agentId)}/memory${qs({ limit, days, decision })}`);
}

/** Idempotent by persona: returns the existing agentId if one already matches. */
export function initAgent(persona) {
  return request('/api/agent/init', { method: 'POST', body: JSON.stringify({ persona }) });
}
