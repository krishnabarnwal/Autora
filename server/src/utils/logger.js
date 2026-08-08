/**
 * Structured tagged logger with a bounded in-memory activity buffer.
 *
 * The buffer backs the dashboard's "Agent Activity" view, so the frontend can
 * show what the autonomous worker is doing without tailing server stdout.
 * Never pass secrets (API keys, connection strings) into these calls.
 */

const MAX_EVENTS = 300;

/** @type {Array<{ts:string, level:string, tag:string, message:string, agentId?:string, data?:object}>} */
const events = [];

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVEL_ORDER[process.env.LOG_LEVEL] ?? LEVEL_ORDER.info;

const SECRET_KEY_PATTERN = /(key|token|secret|password|uri|authorization)/i;

/** Strip anything that looks like a credential before it reaches a log sink. */
function scrub(data) {
  if (!data || typeof data !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = '[redacted]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = scrub(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function record(level, tag, message, meta = {}) {
  const { agentId, ...data } = meta;
  const entry = {
    ts: new Date().toISOString(),
    level,
    tag,
    message,
    ...(agentId ? { agentId } : {}),
    ...(Object.keys(data).length ? { data: scrub(data) } : {}),
  };

  events.push(entry);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  if (LEVEL_ORDER[level] < minLevel) return entry;

  const suffix = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  const line = `${entry.ts} [${tag}] ${message}${suffix}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  return entry;
}

/** Create a logger bound to a fixed tag, e.g. logger('SOURCE'). */
export function logger(tag) {
  return {
    debug: (message, meta) => record('debug', tag, message, meta),
    info: (message, meta) => record('info', tag, message, meta),
    warn: (message, meta) => record('warn', tag, message, meta),
    error: (message, meta) => record('error', tag, message, meta),
  };
}

/** Recent activity, newest first. Optionally scoped to one agent. */
export function recentActivity({ agentId, limit = 100 } = {}) {
  const filtered = agentId ? events.filter((e) => e.agentId === agentId) : events;
  return filtered.slice(-limit).reverse();
}

export function clearActivity() {
  events.length = 0;
}
