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
 * Bounded pagination for the feed. The default is generous enough that a normal
 * evaluation never paginates, while `before` keeps older posts reachable so the
 * "previously returned posts remain available" guarantee still holds.
 */
export function parseFeedPaging(query = {}) {
  const paging = { limit: 200 };

  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw badRequest('limit_invalid', 'limit must be an integer between 1 and 500.');
    }
    paging.limit = limit;
  }

  if (query.before !== undefined) {
    const before = new Date(query.before);
    if (Number.isNaN(before.getTime())) {
      throw badRequest('before_invalid', 'before must be an ISO 8601 timestamp.');
    }
    paging.before = before;
  }

  return paging;
}
