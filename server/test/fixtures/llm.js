/**
 * Fixtures for the LLM provider tests.
 *
 * The API key here is fake and exists so tests can assert it never escapes into
 * a log line, an error message, or a thrown object. It authenticates nothing.
 */

/** Shaped like a real Google API key so redaction is tested against the real pattern. */
export const FAKE_API_KEY = 'AIzaSyD-FAKE-KEY-FOR-TESTS-0123456789abc';

/** A schema in the style Phase 9 will use, without any editorial semantics. */
export const DECISION_SCHEMA = {
  type: 'object',
  required: ['selectedId', 'publish', 'rationale'],
  additionalProperties: false,
  properties: {
    selectedId: { type: 'integer', minimum: 1, maximum: 10 },
    publish: { type: 'boolean' },
    rationale: { type: 'string', minLength: 10, maxLength: 400 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    tags: { type: 'array', maxItems: 5, items: { type: 'string' } },
  },
};

export const VALID_DECISION = {
  selectedId: 2,
  publish: true,
  rationale: 'The disclosure names a reproducible mechanism rather than restating a vendor advisory.',
  confidence: 0.8,
  tags: ['prompt-injection', 'agents'],
};

/** Build a Gemini generateContent response body. */
export function geminiResponse(text, usageMetadata = { promptTokenCount: 120, candidatesTokenCount: 45 }) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata,
  };
}

/**
 * A fetch double that records requests and replays scripted responses.
 *
 * @param {Array<object|Function>} script entries: {status, body, json} or a thrown Error
 */
export function fakeFetch(script) {
  const entries = Array.isArray(script) ? script : [script];
  const requests = [];
  let cursor = 0;

  const impl = async (url, init = {}) => {
    requests.push({
      url: String(url),
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
      rawBody: init.body ?? null,
    });

    const entry = entries[Math.min(cursor, entries.length - 1)];
    cursor += 1;

    if (typeof entry === 'function') return entry(url, init);
    if (entry instanceof Error) throw entry;

    const { status = 200, json, body } = entry;
    const payload = json !== undefined ? JSON.stringify(json) : (body ?? '');
    return new Response(payload, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  impl.requests = requests;
  return impl;
}

/** An error shaped like the one AbortSignal.timeout produces. */
export function timeoutError() {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}

/** Capture console output so tests can assert on what was logged. */
export function captureConsole() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));

  console.log = record;
  console.warn = record;
  console.error = record;

  return {
    lines,
    text: () => lines.join('\n'),
    restore() {
      Object.assign(console, original);
    },
  };
}
