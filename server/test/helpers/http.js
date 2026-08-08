import { createApp } from '../../src/app.js';

/**
 * Minimal HTTP harness: binds the real Express app to an ephemeral port and
 * drives it with global fetch. Avoids adding supertest, and exercises actual
 * request parsing, status codes, and JSON serialization rather than calling
 * handlers directly.
 */

let server = null;
let base = '';

export async function startTestServer() {
  const app = createApp();
  server = await new Promise((resolve, reject) => {
    const httpServer = app.listen(0);
    httpServer.once('listening', () => resolve(httpServer));
    httpServer.once('error', reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

export async function stopTestServer() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  base = '';
}

/** @returns {Promise<{status:number, body:any, headers:Headers}>} */
export async function request(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const options = { method, headers: { ...headers } };

  if (raw !== undefined) {
    // Bypass JSON.stringify so tests can send a malformed payload.
    options.body = raw;
    options.headers['content-type'] ??= 'application/json';
  } else if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers['content-type'] = 'application/json';
  }

  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

export const post = (path, body) => request(path, { method: 'POST', body });
export const get = (path) => request(path, { method: 'GET' });

/**
 * Run a function with global fetch replaced by a recording stub.
 *
 * Used to prove the feed endpoint performs no outbound network call: an LLM
 * request or a live source fetch would have to go through fetch to leave the
 * process, so a zero call count is real evidence, not an assumption.
 *
 * The harness's own request() runs on the captured original, so in-test HTTP
 * still works while application code sees the stub.
 */
export async function withFetchSpy(fn) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = (...args) => {
    const target = String(args[0]);
    // Requests to our own test server are the test driving the API. Anything
    // else is application code reaching off-box, which the feed must never do.
    if (!target.startsWith(base)) calls.push(target);
    return original(...args);
  };

  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = original;
  }
}
