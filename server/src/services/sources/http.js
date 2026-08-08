/**
 * Network helpers for source adapters.
 *
 * Every request is bounded: a timeout, a response size cap, and a bounded
 * retry. A source that hangs or floods must degrade into one skipped source,
 * never a stalled agent cycle.
 */

export const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BYTES = 3 * 1024 * 1024;
const USER_AGENT = 'AutonomousAICreator/1.0 (+topic discovery agent)';

class HttpError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    if (status) this.status = status;
  }
}

/** Read a response body with a hard byte cap so one source cannot exhaust memory. */
async function readCapped(response) {
  const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new HttpError(`Response too large (${declared} bytes)`, 'response_too_large');
  }

  if (!response.body) return await response.text();

  const decoder = new TextDecoder('utf-8');
  let size = 0;
  let text = '';
  for await (const chunk of response.body) {
    size += chunk.byteLength ?? chunk.length ?? 0;
    if (size > MAX_BYTES) throw new HttpError('Response exceeded size cap', 'response_too_large');
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * GET a URL as text.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, retries?: number, accept?: string, fetchImpl?: Function}} options
 * @returns {Promise<{text: string, status: number, url: string, contentType: string}>}
 * @throws {HttpError} codes: `timeout`, `http_error`, `network_error`, `response_too_large`
 */
export async function fetchText(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 1,
    accept = 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    fetchImpl = globalThis.fetch,
  } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept, 'user-agent': USER_AGENT, 'accept-encoding': 'gzip, deflate' },
      });

      if (!response.ok) {
        const error = new HttpError(`HTTP ${response.status}`, 'http_error', response.status);
        // 4xx (except rate limiting) will not change on a retry.
        if (response.status < 500 && response.status !== 429) throw error;
        lastError = error;
      } else {
        return {
          text: await readCapped(response),
          status: response.status,
          url: response.url || url,
          contentType: response.headers.get('content-type') || '',
        };
      }
    } catch (err) {
      if (err.code === 'http_error' && err.status < 500 && err.status !== 429) throw err;
      if (err.code === 'response_too_large') throw err;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        lastError = new HttpError(`Request timed out after ${timeoutMs}ms`, 'timeout');
      } else {
        // One taxonomy for callers; the underlying code (ENOTFOUND, ECONNRESET)
        // stays in the message so logs still say what actually broke.
        const detail = err.code ? ` (${err.code})` : '';
        lastError = new HttpError(`${err.message || 'Network request failed'}${detail}`, 'network_error');
      }
    }

    // Brief linear backoff; the cycle has minutes to spare, upstreams do not.
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }

  throw lastError || new HttpError('Request failed', 'network_error');
}

/**
 * Run tasks with a bounded concurrency and collect every outcome.
 * Rejections are captured, never thrown: one failed source must not abort the rest.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @returns {Promise<Array<{ok: boolean, value?: T, error?: Error}>>}
 */
export async function runPooled(tasks, limit = 6) {
  const results = new Array(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { ok: true, value: await tasks[index]() };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });

  await Promise.all(workers);
  return results;
}
