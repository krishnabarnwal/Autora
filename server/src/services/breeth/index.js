/**
 * Phase 12.5 — Breeth strategic memory. OPTIONAL, non-authoritative, isolated.
 *
 * MongoDB (Phase 11 `services/memory`) remains the authoritative memory: it owns
 * duplicate prevention, the repetition gate, and the audit history, and the
 * `TopicMemory` unique index is still the only real duplicate guarantee. Breeth
 * adds a second, softer layer — semantic cross-cycle recall of what the agent has
 * decided and why — and nothing more. It can never block, allow, or override a
 * deterministic decision.
 *
 * The contract that makes it safe to depend on:
 *
 *   - Every exported call resolves. None of them ever throws or rejects.
 *   - Every result is `{ok, available, ...}`; a caller branches on `ok` and moves
 *     on. Failures are values, so a Breeth outage can never reach the scheduler's
 *     failure counter or trigger exponential backoff.
 *   - Disabled, unkeyed, misconfigured, timed out, rate-limited, 5xx, or
 *     malformed-JSON all collapse to the same shape.
 *   - No HTTP detail (URL, header, status line, provider name) escapes this
 *     directory, mirroring how `services/llm` hides its provider.
 *   - Zero LLM calls. This service talks only to Breeth's REST API.
 *
 * API contract verified against the official docs (docs.thebreeth.com):
 *   POST {baseUrl}/v1/episodes   scope: write   {content, group_id?, source_description?, extract_intent?}
 *   POST {baseUrl}/v1/search     scope: read    {query, group_id?, limit?}
 *   Auth: `Authorization: Bearer <key>`
 *   Errors: {error, message} with slugs invalid_request | unauthenticated |
 *           payment_required | missing_scope | quota_exceeded | internal_error
 *
 * Deliberately NOT used: /v1/facts, /v1/retract, graph traversal, task
 * cancellation, key management. This integration needs read + episode write, so
 * it asks for nothing more.
 */
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

const log = logger('BREETH');

/** Fallbacks used when config is absent or nonsensical (never a throw). */
const DEFAULT_BASE_URL = 'https://api.thebreeth.com';
export const DEFAULT_TIMEOUT_MS = 3_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 30_000;

/** Payload caps. Breeth allows more; these keep episodes small and readable. */
const MAX_CONTENT_CHARS = 1_000;
const MAX_TOPIC_CHARS = 160;
const MAX_REASON_CHARS = 320;
const MAX_SOURCE_DESCRIPTION_CHARS = 120; // Breeth's documented ceiling.
const MAX_SEARCH_LIMIT = 100; // Breeth's documented ceiling.

/** Every failure a caller can see. Stable strings, safe to log and to assert on. */
export const BREETH_ERROR = Object.freeze({
  DISABLED: 'breeth_disabled',
  NOT_CONFIGURED: 'breeth_not_configured',
  INVALID_INPUT: 'breeth_invalid_input',
  TIMEOUT: 'breeth_timeout',
  UNAVAILABLE: 'breeth_unavailable',
  BAD_RESPONSE: 'breeth_bad_response',
  REJECTED: 'breeth_rejected',
});

/** The strategic events worth remembering. Anything else is not sent. */
export const EPISODE = Object.freeze({
  PUBLISHED: 'published',
  DEFERRED: 'deferred',
  REPETITION_SKIP: 'repetition_skip',
  GENERATION_FAILED: 'generation_failed',
});

/**
 * Anything that could carry a credential is stripped before a payload is built.
 *
 * The episode text this service sends is assembled from the agent's own topic
 * titles and editorial reasons, so a secret should never be in scope. This runs
 * anyway, because "should never" is not a guarantee and an episode is durable,
 * third-party, and outside our control once written.
 */
function stripSecrets(value) {
  return String(value ?? '')
    // Connection strings and any other URI with embedded credentials.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]*/gi, '[url]')
    // Bearer/authorization fragments.
    .replace(/\bbearer\s+[\w.\-]+/gi, '[redacted]')
    .replace(/\b(authorization|api[_-]?key|apikey|token|secret|password|passwd|pwd)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
    // Long opaque tokens, including Breeth's own ck_live_ prefix.
    .replace(/\b(?:ck|sk|pk)_[a-z]+_[A-Za-z0-9]{6,}/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]');
}

/** Collapse whitespace, strip secrets, and cap length. Never throws. */
function normalizeText(value, maxChars) {
  const clean = stripSecrets(value).replace(/\s+/g, ' ').trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1).trimEnd()}…` : clean;
}

/** Breeth accepts letters, digits, dashes, and underscores in a group id. */
function normalizeGroupId(value) {
  const clean = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return clean || 'default';
}

function clampTimeout(value) {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/** Read live config each call so a test can flip settings without re-importing. */
function settings(overrides = {}) {
  const base = config.breeth ?? {};
  const merged = { ...base, ...overrides };
  return {
    enabled: Boolean(merged.enabled),
    apiKey: typeof merged.apiKey === 'string' ? merged.apiKey.trim() : '',
    baseUrl: (typeof merged.baseUrl === 'string' && /^https?:\/\//.test(merged.baseUrl)
      ? merged.baseUrl
      : DEFAULT_BASE_URL).replace(/\/+$/, ''),
    groupId: normalizeGroupId(merged.groupId || 'default'),
    timeoutMs: clampTimeout(merged.timeoutMs),
    extractIntent: Boolean(merged.extractIntent),
    fetchImpl: merged.fetchImpl || globalThis.fetch,
  };
}

/**
 * Whether a real Breeth call is possible: opted in, keyed, and with a usable
 * transport. Callers use this to skip work entirely rather than to handle an
 * error, so a disabled Breeth costs nothing at all.
 */
export function isEnabled(overrides = {}) {
  const s = settings(overrides);
  return Boolean(s.enabled && s.apiKey && typeof s.fetchImpl === 'function');
}

/** A resolved failure. `available:false` means "Breeth could not be reached or used". */
function unavailable(errorCode, extra = {}) {
  return { ok: false, available: false, errorCode, ...extra };
}

/**
 * One bounded, authenticated POST. Returns a result object; never throws.
 *
 * The Authorization header is constructed here and nowhere else, is never
 * logged, and is never attached to a returned value or an error.
 */
async function request(path, body, s) {
  const controller = new AbortController();
  // An explicit timer, not AbortSignal.timeout, so an injected fake fetch in the
  // suite can observe the abort without waiting on a real clock.
  const timer = setTimeout(() => controller.abort(), s.timeoutMs);

  try {
    const response = await s.fetchImpl(`${s.baseUrl}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${s.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    const status = Number(response?.status) || 0;
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null; // A non-JSON body is a bad response, not a crash.
    }

    if (!response?.ok) {
      // Breeth's documented envelope is {error, message}. Keep only the slug:
      // `message` is provider prose we neither need nor want in our logs.
      const slug = typeof payload?.error === 'string' ? payload.error.slice(0, 60) : 'http_error';
      return unavailable(BREETH_ERROR.REJECTED, { status, reason: slug });
    }

    if (!payload || typeof payload !== 'object') {
      return unavailable(BREETH_ERROR.BAD_RESPONSE, { status });
    }

    return { ok: true, available: true, status, payload };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
    return unavailable(aborted ? BREETH_ERROR.TIMEOUT : BREETH_ERROR.UNAVAILABLE);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a strategic event into one concise sentence for Breeth's graph.
 *
 * Prose, not JSON: Breeth extracts entities and edges from natural language, so
 * a sentence naming the persona, the event, and the topic is what makes the
 * memory searchable later. Structured detail is appended compactly.
 */
export function buildEpisodeContent({ event, persona, topic, reason, confidence, category } = {}) {
  const who = normalizeText(persona || 'The agent', 80) || 'The agent';
  const what = normalizeText(topic, MAX_TOPIC_CHARS);
  const why = normalizeText(reason, MAX_REASON_CHARS);

  let sentence;
  switch (event) {
    case EPISODE.PUBLISHED:
      sentence = `${who} published a post about "${what}".`;
      break;
    case EPISODE.DEFERRED:
      sentence = `${who} decided not to publish "${what}" this cycle.`;
      break;
    case EPISODE.REPETITION_SKIP:
      sentence = `${who} skipped "${what}" because it repeats a topic already covered.`;
      break;
    case EPISODE.GENERATION_FAILED:
      sentence = `${who} failed to generate a post about "${what}".`;
      break;
    default:
      sentence = `${who} recorded a decision about "${what}".`;
  }

  const parts = [sentence];
  if (why) parts.push(`Reason: ${why}`);
  if (Number.isFinite(confidence)) parts.push(`Editorial confidence: ${confidence.toFixed(2)}.`);
  const topicCategory = normalizeText(category, 60);
  if (topicCategory) parts.push(`Category: ${topicCategory}.`);

  return normalizeText(parts.join(' '), MAX_CONTENT_CHARS);
}

/**
 * Record one strategic episode. Fire-and-forget from the caller's perspective:
 * the result is informational, and ignoring it is a valid use.
 *
 * @param {{event:string, persona?:string, topic?:string, reason?:string,
 *   confidence?:number, category?:string, agentId?:string, groupId?:string}} episode
 * @param {object} [overrides] config overrides, incl. `fetchImpl` for tests
 * @returns {Promise<{ok:boolean, available:boolean, errorCode?:string, episodeName?:string}>}
 */
export async function addEpisode(episode = {}, overrides = {}) {
  const s = settings(overrides);
  if (!s.enabled) return unavailable(BREETH_ERROR.DISABLED);
  if (!s.apiKey || typeof s.fetchImpl !== 'function') return unavailable(BREETH_ERROR.NOT_CONFIGURED);

  // A topic is what makes an episode findable later. Without one the episode
  // would read `about ""` — junk in a durable third-party graph — so reject it
  // here rather than spending a request and a quota credit on it.
  if (!normalizeText(episode.topic, MAX_TOPIC_CHARS)) return unavailable(BREETH_ERROR.INVALID_INPUT);

  const content = buildEpisodeContent(episode);
  if (!content) return unavailable(BREETH_ERROR.INVALID_INPUT);

  const result = await request('/v1/episodes', {
    content,
    group_id: normalizeGroupId(episode.groupId || s.groupId),
    source_description: normalizeText(
      `autonomous-ai-creator/${episode.event || 'decision'}`,
      MAX_SOURCE_DESCRIPTION_CHARS
    ),
    // Metered, so reserved for the highest-signal event: an actual publish.
    extract_intent: Boolean(s.extractIntent && episode.event === EPISODE.PUBLISHED),
  }, s);

  if (!result.ok) {
    // Sanitized and quiet: an optional memory layer being down is a warning, and
    // the scheduler is never told. `reason` is a Breeth error slug, not prose.
    log.warn('Breeth memory write unavailable', {
      agentId: episode.agentId,
      event: episode.event,
      errorCode: result.errorCode,
      ...(result.status ? { status: result.status } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    });
    return result;
  }

  const episodeName = typeof result.payload.episode_name === 'string' ? result.payload.episode_name : null;
  log.info('Recorded a strategic memory in Breeth', {
    agentId: episode.agentId,
    event: episode.event,
    episodeName,
    entities: Array.isArray(result.payload.extracted?.entities) ? result.payload.extracted.entities.length : 0,
    edges: Array.isArray(result.payload.extracted?.edges) ? result.payload.extracted.edges.length : 0,
  });

  return { ok: true, available: true, episodeName };
}

/**
 * Search strategic memory for context about a topic.
 *
 * Read-only and advisory. The returned facts are context for a human reading the
 * activity log or for a future phase; nothing in the current pipeline treats them
 * as a gate, and an empty result is indistinguishable in effect from a failure.
 *
 * @returns {Promise<{ok:boolean, available:boolean, errorCode?:string, facts:string[], count:number}>}
 */
export async function searchMemory(query, overrides = {}) {
  const s = settings(overrides);
  const empty = { facts: [], count: 0 };
  if (!s.enabled) return unavailable(BREETH_ERROR.DISABLED, empty);
  if (!s.apiKey || typeof s.fetchImpl !== 'function') return unavailable(BREETH_ERROR.NOT_CONFIGURED, empty);

  const text = normalizeText(query, MAX_TOPIC_CHARS);
  if (!text) return unavailable(BREETH_ERROR.INVALID_INPUT, empty);

  const requested = Number.isFinite(overrides.limit) ? Math.trunc(overrides.limit) : 5;
  const result = await request('/v1/search', {
    query: text,
    group_id: normalizeGroupId(overrides.groupId || s.groupId),
    limit: Math.min(Math.max(requested, 1), MAX_SEARCH_LIMIT),
  }, s);

  if (!result.ok) {
    log.warn('Breeth retrieval unavailable', {
      errorCode: result.errorCode,
      ...(result.status ? { status: result.status } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    });
    return { ...result, ...empty };
  }

  // Defensive: a malformed `edges` must yield an empty list, not a throw.
  const edges = Array.isArray(result.payload.edges) ? result.payload.edges : [];
  const facts = edges
    .map((edge) => normalizeText(edge?.fact, MAX_REASON_CHARS))
    .filter(Boolean)
    .slice(0, MAX_SEARCH_LIMIT);

  return { ok: true, available: true, facts, count: facts.length };
}

/** The injectable surface. runCycle receives this object, never the HTTP details. */
export const breethService = Object.freeze({ isEnabled, addEpisode, searchMemory });
