/**
 * LLM error taxonomy and secret redaction.
 *
 * Every failure in this layer surfaces as an LlmError with one of the codes
 * below, so callers branch on a small closed set instead of sniffing provider
 * strings. `retryable` is decided here, once, rather than at each call site.
 *
 * Redaction is not decoration. An API key reaches this layer on every request,
 * and provider SDKs habitually echo the request (URL, headers, body) into error
 * messages. Every message that leaves this module is scrubbed, so a key cannot
 * escape into logs, HTTP responses, or a stored document by accident.
 */

/** @type {Record<string, {retryable: boolean, description: string}>} */
export const LLM_ERROR_CODES = {
  not_configured: { retryable: false, description: 'Provider selected but credentials or model are missing' },
  timeout: { retryable: true, description: 'Provider did not respond within the time budget' },
  rate_limited: { retryable: true, description: 'Provider rejected the call for quota or rate reasons' },
  provider_error: { retryable: true, description: 'Provider returned a server-side failure' },
  bad_request: { retryable: false, description: 'Provider rejected the request as invalid' },
  network_error: { retryable: true, description: 'The request never reached the provider' },
  empty_response: { retryable: false, description: 'Provider returned no usable content' },
  content_blocked: { retryable: false, description: 'Provider refused to produce content for this prompt' },
  invalid_response: { retryable: false, description: 'Provider output could not be parsed as JSON' },
  schema_invalid: { retryable: false, description: 'Provider JSON did not match the requested schema' },
};

export class LlmError extends Error {
  /**
   * @param {string} message
   * @param {keyof LLM_ERROR_CODES} code
   * @param {{status?: number, provider?: string, model?: string, details?: any}} [meta]
   */
  constructor(message, code, meta = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.retryable = LLM_ERROR_CODES[code]?.retryable ?? false;
    if (meta.status !== undefined) this.status = meta.status;
    if (meta.provider) this.provider = meta.provider;
    if (meta.model) this.model = meta.model;
    if (meta.details !== undefined) this.details = meta.details;
  }

  /** Shape safe to log or return over HTTP: no message interpolation of secrets. */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.status ? { status: this.status } : {}),
      ...(this.provider ? { provider: this.provider } : {}),
    };
  }
}

/** Anything shorter than this is not a credential and must not be blanket-replaced. */
const MIN_SECRET_LENGTH = 8;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove known secrets and key-shaped query parameters from a string.
 *
 * Two passes on purpose: exact replacement catches the key we hold, and the
 * pattern pass catches a key we were never given — a proxy's URL, a nested
 * provider message — which exact matching would miss.
 *
 * @param {string} text
 * @param {string[]} [secrets] literal values to remove
 * @returns {string}
 */
export function redactSecrets(text, secrets = []) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;

  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) {
      out = out.replaceAll(secret, '[redacted]');
      // A key can arrive URL-encoded inside a serialized request.
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) out = out.replaceAll(encoded, '[redacted]');
    }
  }

  // key=..., api_key=..., x-goog-api-key: ..., "apiKey": "..." — whatever shape.
  // The optional scheme word covers `authorization: Bearer <token>`, where the
  // credential is not adjacent to the label.
  out = out.replace(
    /((?:api[-_]?key|apikey|key|access[-_]?token|token|authorization)["'\s]*[:=]\s*["']?(?:bearer\s+)?)([A-Za-z0-9._\-]{8,})/gi,
    (_match, prefix) => `${prefix}[redacted]`);

  // A bare `Bearer <token>`, with no label in front of it.
  out = out.replace(/(\bbearer\s+)([A-Za-z0-9._\-]{8,})/gi, (_match, prefix) => `${prefix}[redacted]`);

  // Provider-prefixed tokens are recognizable on sight even without a label.
  out = out.replace(/\bAIza[0-9A-Za-z._\-]{10,}/g, '[redacted]');
  out = out.replace(/\b(?:sk|gsk|xai|ghp|glpat)-[A-Za-z0-9._\-]{12,}/gi, '[redacted]');

  return out;
}

/**
 * Wrap an arbitrary thrown value as a redacted LlmError.
 *
 * @param {any} err
 * @param {{code?: string, provider?: string, model?: string, secrets?: string[]}} meta
 * @returns {LlmError}
 */
export function asLlmError(err, meta = {}) {
  const { code = 'provider_error', provider, model, secrets = [] } = meta;
  if (err instanceof LlmError) {
    err.message = redactSecrets(err.message, secrets);
    return err;
  }
  const message = redactSecrets(err?.message || String(err ?? 'Unknown provider failure'), secrets);
  const error = new LlmError(message, code, { provider, model });
  // Deliberately not attaching `cause`: the original often carries the request,
  // headers included, and anything attached here can reach a log sink.
  return error;
}

/** Escape hatch for building a redacted error inline. */
export function llmError(message, code, meta = {}) {
  const { secrets = [], ...rest } = meta;
  return new LlmError(redactSecrets(message, secrets), code, rest);
}

export { escapeRegExp };
