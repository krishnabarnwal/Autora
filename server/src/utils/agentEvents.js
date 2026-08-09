/**
 * A one-slot notification seam between the HTTP layer and the autonomous
 * scheduler.
 *
 * The feed/init route must never depend on the scheduler: a static import from
 * routes to scheduler would drag the worker, runCycle, and the whole LLM stack
 * into the request path's dependency graph, and test/routes/feed.test.js guards
 * against exactly that. So the dependency is inverted here instead. This module
 * is a leaf — it imports nothing — and both sides depend only on it:
 *
 *   routes/agent.js  ->  notifyAgentInitialized(agentId)
 *   bootstrap.js     ->  setAgentInitializedHandler(id => scheduler.register(id))
 *
 * Until bootstrap installs a handler there is none, so the notification is a
 * no-op. That is what keeps POST /api/agent/init inert and instant in every test
 * (no worker, no timer) while the real server still starts an agent's cycles the
 * moment it is created.
 */

/** @type {((agentId: string) => unknown) | null} */
let handler = null;

/** Install (or clear, with null) the agent-initialized handler. */
export function setAgentInitializedHandler(fn) {
  handler = typeof fn === 'function' ? fn : null;
  return handler;
}

/** The installed handler, or null when nothing is listening. */
export function getAgentInitializedHandler() {
  return handler;
}

/**
 * Announce that an agent was initialized (created, or re-initialized with the
 * same persona). Safe to call when nothing is listening.
 *
 * Errors propagate to the caller rather than being swallowed here, so the route
 * can log them with its own tag; the route treats a failure as non-fatal because
 * the agent is already persisted and the scheduler would resume it on restart.
 *
 * @returns {boolean} whether a handler was invoked.
 */
export function notifyAgentInitialized(agentId) {
  if (!handler || !agentId) return false;
  handler(agentId);
  return true;
}
