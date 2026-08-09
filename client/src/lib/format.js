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
  return `${Math.round(ms / 3_600_000)}h`;
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

export const STATUS_TONE = {
  autonomous: 'good',
  initializing: 'info',
  paused: 'warn',
  error: 'bad',
};

export const DECISION_TONE = {
  published: 'good',
  rejected: 'bad',
  deferred: 'warn',
};

export const LEVEL_TONE = {
  info: 'muted',
  warn: 'warn',
  error: 'bad',
  debug: 'muted',
};

/**
 * Recognize the degraded conditions the operator actually needs to see, from the
 * real activity log. Purely a read of what the backend already reported — this
 * never infers a state the server did not log.
 */
export function classifyEvent(event) {
  const haystack = `${event?.message ?? ''} ${JSON.stringify(event?.data ?? {})}`.toLowerCase();
  if (haystack.includes('429') || haystack.includes('rate_limit') || haystack.includes('quota')) {
    return 'rate_limited';
  }
  if (haystack.includes('breeth')) return 'breeth';
  return null;
}
