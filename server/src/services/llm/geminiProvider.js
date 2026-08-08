/**
 * Gemini provider (Generative Language REST API).
 *
 * Hand-rolled against the REST endpoint rather than pulling in the SDK: this is
 * one POST with one JSON body, and the SDK would add a dependency plus its own
 * error and retry behaviour on top of the taxonomy in errors.js.
 *
 * The key travels in the `x-goog-api-key` header, never as a `?key=` query
 * parameter. Both authenticate; only one keeps the credential out of URLs,
 * which are the string most likely to end up in a log line or an error message.
 */
import { LlmError, asLlmError, llmError, redactSecrets } from './errors.js';
import { parseJsonWithSchema } from './json.js';
import { estimateTokens, usageTracker } from './usage.js';
import { runWithRetries } from './retry.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/**
 * Pinned rather than an alias like `gemini-flash-latest`: a 48-hour evaluation
 * run should not have the model shift under it. Verified callable by the live
 * smoke check — note that ListModels advertises models the account cannot
 * actually use, so "it appears in the list" is not evidence it works.
 */
export const DEFAULT_MODEL = 'gemini-3.5-flash';
export const DEFAULT_TIMEOUT_MS = 30_000;
/** One retry: transport blips are common, and a stalled cycle is worse than a skipped one. */
export const DEFAULT_RETRIES = 1;

/** Map an HTTP status onto the shared taxonomy. */
function codeForStatus(status) {
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 404) return 'bad_request';
  if (status === 401 || status === 403) return 'not_configured';
  if (status >= 500) return 'provider_error';
  return 'provider_error';
}

/** Gemini reports refusals through finishReason/blockReason rather than an error status. */
function assertNotBlocked(payload, meta) {
  const blockReason = payload?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new LlmError(`Provider blocked the prompt (${blockReason})`, 'content_blocked', meta);
  }
  const finishReason = payload?.candidates?.[0]?.finishReason;
  if (finishReason && !['STOP', 'MAX_TOKENS'].includes(finishReason)) {
    throw new LlmError(`Provider stopped early (${finishReason})`, 'content_blocked', meta);
  }
}

function textFromPayload(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => part?.text ?? '').join('').trim();
}

/**
 * @param {{apiKey?: string, model?: string, timeoutMs?: number, retries?: number,
 *          fetchImpl?: Function, usage?: object, temperature?: number,
 *          maxOutputTokens?: number}} options
 */
export function createGeminiProvider(options = {}) {
  const {
    apiKey = '',
    model = DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    fetchImpl,
    usage = usageTracker,
    temperature = 0.4,
    maxOutputTokens = 2048,
    // Injectable so tests exercise the retry path without paying the backoff.
    sleep,
  } = options;

  const secrets = apiKey ? [apiKey] : [];
  const meta = { provider: 'gemini', model };

  /** Fail before the network when the provider cannot possibly work. */
  function assertConfigured() {
    if (!apiKey) {
      throw new LlmError(
        'LLM_API_KEY is not set, so the Gemini provider cannot make a request. '
          + 'Set LLM_API_KEY, or set LLM_PROVIDER=mock to run without an external model.',
        'not_configured',
        meta
      );
    }
    if (!model) throw new LlmError('LLM_MODEL is empty', 'not_configured', meta);
  }

  async function callOnce(prompt, callOptions) {
    const fetcher = callOptions.fetchImpl || fetchImpl || globalThis.fetch;
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: callOptions.temperature ?? temperature,
        maxOutputTokens: callOptions.maxOutputTokens ?? maxOutputTokens,
        // Constrains the decoder itself, which removes most prose-around-JSON
        // failures at the source rather than repairing them after the fact.
        ...(callOptions.json ? { responseMimeType: 'application/json' } : {}),
      },
      ...(callOptions.systemInstruction
        ? { systemInstruction: { parts: [{ text: callOptions.systemInstruction }] } }
        : {}),
    };

    let response;
    try {
      response = await fetcher(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(callOptions.timeoutMs ?? timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw llmError(`Provider did not respond within ${callOptions.timeoutMs ?? timeoutMs}ms`, 'timeout', { ...meta, secrets });
      }
      throw asLlmError(err, { ...meta, code: 'network_error', secrets });
    }

    if (!response.ok) {
      // Read the body for diagnostics, but redact it: provider error payloads
      // routinely echo the request, headers included.
      const detail = await response.text().catch(() => '');
      const reason = redactSecrets(detail.slice(0, 300).replace(/\s+/g, ' '), secrets);
      throw new LlmError(
        `Gemini request failed with HTTP ${response.status}${reason ? `: ${reason}` : ''}`,
        codeForStatus(response.status),
        { ...meta, status: response.status }
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw asLlmError(err, { ...meta, code: 'invalid_response', secrets });
    }

    assertNotBlocked(payload, meta);

    const text = textFromPayload(payload);
    if (!text) throw new LlmError('Provider returned no content', 'empty_response', meta);

    const reported = payload?.usageMetadata;
    return {
      text,
      inputTokens: reported?.promptTokenCount ?? estimateTokens(prompt),
      outputTokens: reported?.candidatesTokenCount ?? estimateTokens(text),
      estimated: !reported?.promptTokenCount,
    };
  }

  const withRetries = (prompt, callOptions) => runWithRetries({
    call: () => callOnce(prompt, callOptions),
    prompt,
    provider: 'gemini',
    model,
    retries: callOptions.retries ?? retries,
    usage,
    secrets,
    sleep: callOptions.sleep ?? sleep,
  });

  return {
    name: 'gemini',
    model,
    isConfigured: Boolean(apiKey),
    usage,

    /**
     * @param {string} prompt
     * @param {{timeoutMs?:number, retries?:number, temperature?:number,
     *          maxOutputTokens?:number, systemInstruction?:string, fetchImpl?:Function}} [callOptions]
     * @returns {Promise<{text:string, usage:{inputTokens:number, outputTokens:number, estimated:boolean}}>}
     */
    async generateText(prompt, callOptions = {}) {
      assertConfigured();
      const result = await withRetries(prompt, callOptions);
      return {
        text: result.text,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimated: result.estimated,
        },
      };
    },

    /**
     * @param {string} prompt
     * @param {{schema?:object, stripUnknown?:boolean} & Record<string, any>} [callOptions]
     * @returns {Promise<{data:any, usage:object}>}
     */
    async generateJSON(prompt, callOptions = {}) {
      assertConfigured();
      const result = await withRetries(prompt, { ...callOptions, json: true });
      const data = parseJsonWithSchema(result.text, callOptions.schema, {
        stripUnknown: callOptions.stripUnknown ?? true,
      });
      return {
        data,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimated: result.estimated,
        },
      };
    },
  };
}
