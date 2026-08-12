/**
 * The six dashboard tones, in one place.
 *
 * `good warn bad info muted plain` are the only tones any component accepts.
 * The three class maps are the same six keys rendered three ways — text colour,
 * badge ring, status dot — and the semantic maps below translate a backend
 * value (an agent status, an editorial decision, a log level) into one of the
 * six. Nothing here decides meaning; it is the vocabulary the UI already speaks,
 * collected so a tone is defined once rather than in every component that draws
 * one.
 */

export const TONE_TEXT = {
  good: 'text-signal',
  warn: 'text-amber-400',
  bad: 'text-red-400',
  info: 'text-accent',
  muted: 'text-ink-500',
  plain: 'text-white',
};

export const TONE_RING = {
  good: 'border-signal/40 bg-signal/10',
  warn: 'border-amber-400/40 bg-amber-400/10',
  bad: 'border-red-400/40 bg-red-400/10',
  info: 'border-accent/40 bg-accent/10',
  muted: 'border-ink-700 bg-ink-800/60',
  plain: 'border-ink-700 bg-ink-800/60',
};

export const TONE_DOT = {
  good: 'bg-signal',
  warn: 'bg-amber-400',
  bad: 'bg-red-400',
  info: 'bg-accent',
  muted: 'bg-ink-500',
  plain: 'bg-ink-300',
};

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
