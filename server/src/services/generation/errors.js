/**
 * Post-generation error taxonomy.
 *
 * Phase 8 already has an LlmError taxonomy for the transport (timeout, rate
 * limited, bad JSON, schema mismatch). This layer sits above it and speaks in
 * generation terms, so a caller — the future scheduler, the dashboard, the
 * smoke script — branches on "the post was too long" rather than re-deriving it
 * from a transport code. Every failure is one of these codes; nothing here
 * repairs model output, so a failure is always a skipped post, never a patched
 * one.
 *
 * Two error classes, deliberately separated:
 *
 *  - GenerationInputError: the *caller* passed something wrong (a non-publish
 *    decision handed to the publish path, a candidate with no URL, an unknown
 *    platform). These are bugs in the surrounding code and throw, exactly like
 *    the editorial layer's EditorialInputError.
 *  - GenerationError: the *model* produced something we will not publish. These
 *    are expected at runtime and are turned into a "failed" result by
 *    generatePost — the cycle ends, nothing is published, and the reason is
 *    legible. They never escape as thrown exceptions from generatePost.
 */
import { LlmError } from '../llm/errors.js';

/**
 * The closed set named in the Phase 10 spec. Callers may compare against these
 * constants instead of matching strings.
 */
export const GENERATION_ERROR_CODES = Object.freeze({
  /** The editorial decision was not a publish, so there is nothing to generate. */
  NOT_ALLOWED: 'generation_not_allowed',
  /** A provider or internal failure with no more specific code. */
  FAILED: 'generation_failed',
  /** The provider did not answer within the time budget. */
  TIMEOUT: 'generation_timeout',
  /** The provider refused the call for quota or rate reasons. */
  RATE_LIMITED: 'generation_rate_limited',
  /** The model's output could not be parsed as JSON. */
  INVALID_JSON: 'generation_invalid_json',
  /** The model's JSON did not match the strict FinalPost schema. */
  SCHEMA_INVALID: 'generation_schema_invalid',
  /** The output parsed and matched the schema but failed a coherence check. */
  VERIFICATION_FAILED: 'generation_verification_failed',
  /** The post exceeds the target platform's character limit. */
  TOO_LONG: 'generation_too_long',
  /** The output cited a source that was not in the candidate. */
  INVALID_SOURCE: 'generation_invalid_source',
});

const GENERATION_ERROR_VALUES = Object.freeze(Object.values(GENERATION_ERROR_CODES));

/**
 * A model output we will not publish.
 *
 * `code` is one of GENERATION_ERROR_CODES; `details` carries the specific
 * findings for the dashboard without ever quoting a credential (verify.js only
 * ever puts candidate-derived text and counts here).
 */
export class GenerationError extends Error {
  constructor(message, code, details = []) {
    super(message);
    this.name = 'GenerationError';
    this.code = GENERATION_ERROR_VALUES.includes(code) ? code : GENERATION_ERROR_CODES.FAILED;
    this.details = details;
  }
}

/** The caller passed malformed input. A bug in the surrounding code, so it throws. */
export class GenerationInputError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'GenerationInputError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Translate a transport-layer LlmError code into a generation code.
 *
 * The mapping keeps the two failures the model can control distinct (bad JSON,
 * schema mismatch) and collapses the operational ones (network, 5xx, bad
 * request) into generation_failed — a caller retries or waits for the next
 * cycle the same way for all of them.
 *
 * @param {string} code an LLM_ERROR_CODES value
 * @returns {string} a GENERATION_ERROR_CODES value
 */
export function mapLlmErrorCode(code) {
  switch (code) {
    case 'timeout':
      return GENERATION_ERROR_CODES.TIMEOUT;
    case 'rate_limited':
      return GENERATION_ERROR_CODES.RATE_LIMITED;
    case 'empty_response':
    case 'invalid_response':
      return GENERATION_ERROR_CODES.INVALID_JSON;
    case 'schema_invalid':
      return GENERATION_ERROR_CODES.SCHEMA_INVALID;
    default:
      // provider_error, network_error, bad_request, not_configured, content_blocked.
      return GENERATION_ERROR_CODES.FAILED;
  }
}

/** True when a thrown value is the transport layer's error type. */
export const isLlmError = (error) => error instanceof LlmError;

export { GENERATION_ERROR_VALUES };
