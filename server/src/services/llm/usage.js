/**
 * Runtime LLM usage accounting.
 *
 * Provider-agnostic by construction: providers report token counts if they have
 * them, and the tracker estimates otherwise, so the dashboard renders the same
 * numbers whether the agent ran against Gemini or the mock.
 *
 * In-memory and bounded. Nothing here is persisted, and nothing here is allowed
 * to hold a prompt, a completion, or a credential — only counts and timings.
 */

/**
 * Rough token estimate for providers that do not report usage.
 *
 * ~4 characters per token is the usual English approximation. Deliberately an
 * estimate and labelled as one; the dashboard shows "estimated tokens".
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const value = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(value.length / 4);
}

export class UsageTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.calls = 0;
    this.successful = 0;
    this.failed = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.estimated = false;
    this.lastCallAt = null;
    this.lastError = null;
    this.totalDurationMs = 0;
    /** @type {Record<string, number>} */
    this.byProvider = {};
    /** @type {Record<string, number>} */
    this.errorsByCode = {};
  }

  /**
   * Record one completed call, successful or not.
   *
   * @param {{ok: boolean, provider?: string, model?: string, inputTokens?: number,
   *          outputTokens?: number, estimated?: boolean, durationMs?: number,
   *          errorCode?: string, at?: number}} entry
   */
  record(entry = {}) {
    const {
      ok, provider = 'unknown', inputTokens = 0, outputTokens = 0,
      estimated = false, durationMs = 0, errorCode, at = Date.now(),
    } = entry;

    this.calls += 1;
    if (ok) this.successful += 1;
    else {
      this.failed += 1;
      this.lastError = errorCode || 'unknown';
      this.errorsByCode[this.lastError] = (this.errorsByCode[this.lastError] || 0) + 1;
    }

    // Failed calls still burn input tokens at most providers, so count them.
    this.inputTokens += Math.max(0, inputTokens);
    this.outputTokens += Math.max(0, outputTokens);
    if (estimated) this.estimated = true;
    this.totalDurationMs += Math.max(0, durationMs);
    this.byProvider[provider] = (this.byProvider[provider] || 0) + 1;
    this.lastCallAt = new Date(at).toISOString();

    return this;
  }

  /** Serializable view for the dashboard. Contains no prompt text and no key. */
  snapshot(now = Date.now()) {
    const totalTokens = this.inputTokens + this.outputTokens;
    return {
      calls: this.calls,
      successful: this.successful,
      failed: this.failed,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens,
      tokensAreEstimated: this.estimated,
      lastCallAt: this.lastCallAt,
      lastCallAgoMs: this.lastCallAt ? Math.max(0, now - Date.parse(this.lastCallAt)) : null,
      averageDurationMs: this.calls ? Math.round(this.totalDurationMs / this.calls) : 0,
      lastError: this.lastError,
      errorsByCode: { ...this.errorsByCode },
      byProvider: { ...this.byProvider },
    };
  }
}

/** Process-wide tracker. Providers default to this unless a test injects its own. */
export const usageTracker = new UsageTracker();
