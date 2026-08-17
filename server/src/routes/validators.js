import { badRequest } from '../utils/errors.js';

/**
 * Request validation for the public agent API.
 *
 * Kept out of the route handlers so the rules are unit-testable without HTTP,
 * and so every rejection produces a specific error code the dashboard can act
 * on rather than a generic 400.
 */

const LIMITS = {
  name: 80, // matches personaSchema.name maxlength
  domain: 120, // matches personaSchema.domain maxlength
  agentId: 64,
};

/** Reject non-strings before trimming, so `{name: 123}` fails loudly. */
function requireString(value, field, maxlength) {
  if (typeof value !== 'string') {
    throw badRequest(`${field}_required`, `persona.${field} is required and must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw badRequest(`${field}_required`, `persona.${field} cannot be empty.`);
  }
  if (trimmed.length > maxlength) {
    throw badRequest(`${field}_too_long`, `persona.${field} must be at most ${maxlength} characters.`);
  }
  return trimmed;
}

/**
 * Validate the POST /api/agent/init body.
 *
 * Optional persona fields are accepted but ignored unless well-formed, so a
 * caller sending only { name, domain } is always valid.
 *
 * @returns {{name:string, domain:string, identity?:string, voice?:string,
 *            interests?:string[], editorialStandards?:string[]}}
 */
export function parseInitBody(body) {
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('invalid_body', 'Request body must be a JSON object.');
  }

  const { persona } = body;
  if (persona === undefined || persona === null) {
    throw badRequest('persona_required', 'persona is required.');
  }
  if (typeof persona !== 'object' || Array.isArray(persona)) {
    throw badRequest('persona_invalid', 'persona must be an object with name and domain.');
  }

  const parsed = {
    name: requireString(persona.name, 'name', LIMITS.name),
    domain: requireString(persona.domain, 'domain', LIMITS.domain),
  };

  // Optional enrichment: silently dropped when absent or the wrong type, since
  // the contract only guarantees name and domain.
  if (typeof persona.identity === 'string' && persona.identity.trim()) {
    parsed.identity = persona.identity.trim().slice(0, 1000);
  }
  if (typeof persona.voice === 'string' && persona.voice.trim()) {
    parsed.voice = persona.voice.trim().slice(0, 500);
  }
  for (const field of ['interests', 'editorialStandards']) {
    if (Array.isArray(persona[field])) {
      parsed[field] = persona[field]
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim().slice(0, 200))
        .slice(0, 20);
    }
  }

  return parsed;
}

/** Validate the ?agentId= query parameter shared by feed-style endpoints. */
export function parseAgentId(value) {
  if (Array.isArray(value)) {
    throw badRequest('agent_id_invalid', 'agentId must be given exactly once.');
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw badRequest('agent_id_required', 'agentId query parameter is required.');
  }
  const trimmed = value.trim();
  if (trimmed.length > LIMITS.agentId || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw badRequest('agent_id_invalid', 'agentId is not a valid identifier.');
  }
  return trimmed;
}

/**
 * Shared bounded-integer rule for every `limit` query parameter.
 *
 * One implementation means the feed and the dashboard endpoints reject the same
 * malformed input the same way, with the same `limit_invalid` code.
 */
function parseLimit(value, { fallback, max }) {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw badRequest('limit_invalid', `limit must be an integer between 1 and ${max}.`);
  }
  return limit;
}

/**
 * Bounded pagination for the feed. The default is generous enough that a normal
 * evaluation never paginates, while `before` keeps older posts reachable so the
 * "previously returned posts remain available" guarantee still holds.
 */
export function parseFeedPaging(query = {}) {
  const paging = { limit: parseLimit(query.limit, { fallback: 200, max: 500 }) };

  if (query.before !== undefined) {
    const before = new Date(query.before);
    if (Number.isNaN(before.getTime())) {
      throw badRequest('before_invalid', 'before must be an ISO 8601 timestamp.');
    }
    paging.before = before;
  }

  return paging;
}

/**
 * Paging for GET /api/agent. A dashboard lists a handful of agents, so the cap
 * is deliberately tighter than the feed's.
 */
export function parseAgentListQuery(query = {}) {
  return { limit: parseLimit(query.limit, { fallback: 25, max: 100 }) };
}

/**
 * Query for GET /api/agent/:agentId/activity.
 *
 * `scope=all` widens the read to the process-wide activity buffer (startup,
 * scheduler, and source events that carry no agentId) so the dashboard can show
 * system health from the same source of truth.
 */
export function parseActivityQuery(query = {}) {
  const scope = query.scope === undefined ? 'agent' : query.scope;
  if (scope !== 'agent' && scope !== 'all') {
    throw badRequest('scope_invalid', "scope must be either 'agent' or 'all'.");
  }
  return { limit: parseLimit(query.limit, { fallback: 100, max: 300 }), scope };
}

/**
 * Query for GET /api/agent/:agentId/memory. `decision` is validated by the
 * memory service against its own enum, so it is passed through untouched.
 */
export function parseMemoryQuery(query = {}) {
  const parsed = { limit: parseLimit(query.limit, { fallback: 50, max: 200 }) };

  if (query.days !== undefined) {
    const days = Number(query.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw badRequest('days_invalid', 'days must be an integer between 1 and 365.');
    }
    parsed.days = days;
  }

  if (query.decision !== undefined) {
    if (typeof query.decision !== 'string' || !query.decision.trim()) {
      throw badRequest('decision_invalid', 'decision must be a non-empty string.');
    }
    parsed.decision = query.decision.trim();
  }

  return parsed;
}

/**
 * Query for GET /api/agent/:agentId/cycles — persistent execution history.
 *
 * Unlike the feed, this collection grows forever: one row every cycle, for the
 * life of the agent. So the page size is small by default and firmly capped, and
 * there is no way to ask for the whole history in one request. `before` is the
 * cursor the previous page handed back, and it must be a real timestamp — a
 * junk cursor is a client bug and is rejected rather than silently ignored,
 * which would quietly return page one again forever.
 */
export function parseCycleQuery(query = {}) {
  const parsed = { limit: parseLimit(query.limit, { fallback: 20, max: 100 }) };

  if (query.before !== undefined) {
    const before = new Date(query.before);
    if (Number.isNaN(before.getTime())) {
      throw badRequest('before_invalid', 'before must be an ISO 8601 timestamp.');
    }
    parsed.before = before;
  }

  return parsed;
}
