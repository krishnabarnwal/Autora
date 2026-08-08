/**
 * Shared call wrapper: bounded retries plus usage accounting.
 *
 * Both providers route through this so retry semantics and token counting are
 * identical whether the agent is running against Gemini or the mock — a test
 * that proves retry behaviour against the mock is then evidence about the real
 * provider, not about a second implementation that happens to look similar.
 */
import { asLlmError } from './errors.js';
import { estimateTokens } from './usage.js';
import { logger } from '../../utils/logger.js';

const log = logger('LLM');

/**
 * Run one provider call with bounded retries, recording every attempt.
 *
 * Only `retryable` errors (per the taxonomy in errors.js) are retried: a
 * malformed prompt or a missing key fails the same way on attempt two, and
 * retrying it just doubles the latency and the bill.
 *
 * @param {{
 *   call: () => Promise<{text:string, inputTokens:number, outputTokens:number, estimated?:boolean}>,
 *   prompt: string, provider: string, model: string,
 *   retries?: number, usage: object, secrets?: string[], backoffMs?: number,
 *   sleep?: (ms:number) => Promise<void>
 * }} options
 */
export async function runWithRetries(options) {
  const {
    call, prompt, provider, model, retries = 1, usage, secrets = [],
    backoffMs = 400,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const started = Date.now();
    try {
      const result = await call(attempt);
      usage.record({
        ok: true,
        provider,
        model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimated: Boolean(result.estimated),
        durationMs: Date.now() - started,
      });
      return result;
    } catch (err) {
      const error = asLlmError(err, { provider, model, secrets });
      // A failed call still consumed input tokens at most providers.
      usage.record({
        ok: false,
        provider,
        model,
        inputTokens: estimateTokens(prompt),
        estimated: true,
        durationMs: Date.now() - started,
        errorCode: error.code,
      });
      lastError = error;

      if (!error.retryable || attempt >= retries) throw error;
      log.warn(`${provider} call failed, retrying (${attempt + 1}/${retries})`, {
        code: error.code, status: error.status, model,
      });
      await sleep(backoffMs * (attempt + 1));
    }
  }

  throw lastError;
}
