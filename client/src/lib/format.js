/**
 * Formatting helpers. Every one of these is defensive about missing data: the
 * dashboard shows real backend values or an explicit dash, never a guess and
 * never "NaN".
 */

export function formatInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const minutes = ms / 60_000;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
  }
  // An hour or more carries its remaining minutes. Rounding to whole hours
  // would report the configured 90-minute cadence as "2h" — a third of an hour
  // of drift on the one number that tells the operator how often the agent
  // runs, and enough to contradict the countdown sitting beside it. Whole
  // hours still print bare ("6h"), so the production cadence is unchanged.
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** "4m ago" / "in 2m". Returns null when there is no timestamp to describe. */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;

  const deltaMs = then - now;
  const future = deltaMs > 0;
  const seconds = Math.round(Math.abs(deltaMs) / 1000);

  let text;
  if (seconds < 5) text = 'just now';
  else if (seconds < 60) text = `${seconds}s`;
  else if (seconds < 3600) text = `${Math.round(seconds / 60)}m`;
  else if (seconds < 86_400) text = `${Math.round(seconds / 3600)}h`;
  else text = `${Math.round(seconds / 86_400)}d`;

  if (text === 'just now') return text;
  return future ? `in ${text}` : `${text} ago`;
}

export function formatClock(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString() : '—';
}

/** Hostname only, so a long source URL stays readable in a dense list. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Provider rate-limit terminology, as the backend actually writes it.
 *
 * `rate[\s_-]?limit` covers "rate limit", "rate-limit", "rate_limit" and
 * "ratelimit", and by prefix "rate_limited" and "rate limiting" — the exact
 * string the LLM error taxonomy puts into both a message and `data.code`.
 */
const RATE_LIMIT_TERMS =
  /rate[\s_-]?limit|resource[\s_-]?exhausted|too many requests|retry[\s_-]?after|quota/i;

/**
 * A standalone HTTP 429 — never three digits that merely sit inside a longer
 * number.
 *
 * The guards are the entire point. A relevance score of 0.8429, a request id of
 * 1429 and a count of 4290 all contain "429" as a substring and none of them is
 * a status code. `\b429\b` is not sufficient either: `.` is a non-word
 * character, so a word boundary exists between "." and "4" and `\b429\b` would
 * match the 429 in "0.429". Hence an explicit "not preceded by a digit or a
 * dot", written as a group rather than a lookbehind so the module still parses
 * on older Safari.
 */
const HTTP_429 = /(^|[^\d.])429(?!\.?\d)/;

/** Data fields whose *value* is a status or an error code, and never free text. */
const CODE_FIELDS = ['code', 'errorCode'];

/**
 * Levels at which a bare "429" in prose is a quantity, not a status.
 *
 * Every path that reports a real rate limit logs at warn or error — retry.js,
 * editorial, generation and runCycle all do. So an unadorned 429 inside an
 * info-level line ("Fetched 429 headlines") is a count, while the same digits
 * in a warning are a status code. An event with no level at all is treated as
 * significant: for a degraded-state signal, the safe direction to fail is
 * visible, never silent.
 */
const QUIET_LEVELS = new Set(['debug', 'info']);

/**
 * Recognize the degraded conditions the operator actually needs to see, from the
 * real activity log. Purely a read of what the backend already reported — this
 * never infers a state the server did not log.
 *
 * The message is the primary source. Structured data is consulted only by field
 * name, never as stringified JSON, because a genuine rate limit reaches this
 * buffer two ways: the editorial and generation paths interpolate the code into
 * the message ("Editorial call failed (rate_limited)"), while the retry path
 * logs "gemini call failed, retrying (1/3)" and carries the signal in
 * `data.code` / `data.status` alone. Searching the whole payload would catch
 * both — and also every number that happens to contain 429.
 */
export function classifyEvent(event) {
  const message = String(event?.message ?? '');
  const data = event?.data ?? {};
  const codes = CODE_FIELDS.map((key) => data[key])
    .filter((value) => typeof value === 'string')
    .join(' ');

  // Named terminology is unambiguous prose, so it counts at any level.
  const named = RATE_LIMIT_TERMS.test(message) || RATE_LIMIT_TERMS.test(codes);
  // A field literally called `status` holding 429 is a status code, full stop.
  const status = data.status === 429 || data.status === '429';
  const bareCode = HTTP_429.test(message) && !QUIET_LEVELS.has(event?.level);

  if (named || status || bareCode) return 'rate_limited';

  // Breeth, from the message and the backend's own tag — not from the shape of
  // the payload. `JSON.stringify(data)` used to be searched for "breeth", which
  // matched the *key* `breethEnabled` in the server's startup line and filed a
  // "Listening on http://localhost:5000" event as a Breeth episode. That is the
  // same substring collision that made the 429 test unsafe, so it is closed the
  // same way: a config flag advertising that the feature exists is not evidence
  // that the feature did anything.
  const tag = String(event?.tag ?? '').toUpperCase();
  if (tag === 'BREETH' || /breeth/i.test(message) || /breeth/i.test(codes)) return 'breeth';
  return null;
}
