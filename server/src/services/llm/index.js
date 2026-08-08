/**
 * LLM provider factory — the seam the rest of the application depends on.
 *
 * Nothing outside this directory imports Gemini, mentions a model endpoint, or
 * knows how a key is passed. Callers ask for a provider and get an object with
 * two methods:
 *
 *   generateText(prompt, options)  -> { text, usage }
 *   generateJSON(prompt, options)  -> { data, usage }   // options.schema enforced
 *
 * Swapping providers is then a config change, and Phase 9's editorial call can
 * be tested against the mock with no network and no key.
 *
 * On token economics: this layer never sees a raw feed. Phase 6-7 narrows
 * thousands of articles to ~8 candidates deterministically, and
 * `compactCandidates` caps what may be put in a prompt. See candidates.js.
 */
import { config } from '../../config/env.js';
import { LlmError } from './errors.js';
import { createGeminiProvider, DEFAULT_MODEL } from './geminiProvider.js';
import { createMockProvider } from './mockProvider.js';
import { usageTracker } from './usage.js';
import { logger } from '../../utils/logger.js';

const log = logger('LLM');

export const SUPPORTED_PROVIDERS = ['gemini', 'mock'];

/**
 * Build a provider.
 *
 * @param {{provider?: string, apiKey?: string, model?: string, usage?: object,
 *          timeoutMs?: number, retries?: number, fetchImpl?: Function,
 *          script?: any, requireCredentials?: boolean}} [options]
 *   Defaults come from config; every field is overridable so tests never touch env.
 */
export function createLlmProvider(options = {}) {
  const {
    provider = config.llm.provider,
    apiKey = config.llm.apiKey,
    model = config.llm.model || DEFAULT_MODEL,
    usage = usageTracker,
    requireCredentials = false,
    ...rest
  } = options;

  const name = String(provider || '').toLowerCase();

  if (!SUPPORTED_PROVIDERS.includes(name)) {
    throw new LlmError(
      `Unsupported LLM_PROVIDER "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}.`,
      'not_configured'
    );
  }

  if (name === 'mock') {
    // The one provider that must work with no credentials at all.
    return createMockProvider({ model: model === DEFAULT_MODEL ? 'mock-1' : model, usage, ...rest });
  }

  // Construction stays permissive so a missing key surfaces as a typed error at
  // call time (or immediately, when the caller asks to fail fast at startup).
  if (requireCredentials && !apiKey) {
    throw new LlmError(
      'LLM_PROVIDER=gemini requires LLM_API_KEY. Set the key, or set LLM_PROVIDER=mock '
        + 'to run the agent without an external model.',
      'not_configured',
      { provider: name, model }
    );
  }

  return createGeminiProvider({ apiKey, model, usage, ...rest });
}

/** @type {object|null} */
let cached = null;

/**
 * Process-wide provider, built once.
 *
 * The scheduler, routes, and scripts share one instance so usage accounting is
 * a single running total rather than a per-caller fragment.
 */
export function getLlmProvider(options = {}) {
  if (!cached || options.fresh) {
    cached = createLlmProvider(options);
    log.info(`LLM provider ready: ${cached.name}`, {
      model: cached.model,
      configured: cached.isConfigured,
      // Never the key itself, and never a prefix of it.
    });
  }
  return cached;
}

/** Drop the cached provider (tests, and config reloads). */
export function resetLlmProvider() {
  cached = null;
}

/**
 * Startup readiness, without making a call.
 *
 * @returns {{ok: boolean, provider: string, model: string, reason?: string}}
 */
export function checkLlmReadiness(cfg = config) {
  const provider = String(cfg.llm.provider || '').toLowerCase();

  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return { ok: false, provider, model: cfg.llm.model, reason: `Unsupported provider "${provider}"` };
  }
  if (provider === 'mock') {
    return { ok: true, provider, model: 'mock-1' };
  }
  if (!cfg.llm.apiKey) {
    return { ok: false, provider, model: cfg.llm.model, reason: 'LLM_API_KEY is not set' };
  }
  return { ok: true, provider, model: cfg.llm.model };
}

export { LlmError, LLM_ERROR_CODES, redactSecrets } from './errors.js';
export { extractJson, validateSchema, parseJsonWithSchema, assertSchema } from './json.js';
export { UsageTracker, usageTracker, estimateTokens } from './usage.js';
export { compactCandidates, assertBounded, MAX_CANDIDATES, MAX_SUMMARY_CHARS } from './candidates.js';
export { createGeminiProvider } from './geminiProvider.js';
export { createMockProvider } from './mockProvider.js';
