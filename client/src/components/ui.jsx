/**
 * Shared presentational primitives for the dashboard.
 *
 * Every section renders one of four states — loading, error, empty, or data —
 * and they all come from here so a missing state is a visible omission rather
 * than an accidental blank panel.
 */

import { TONE_DOT, TONE_RING, TONE_TEXT } from '../lib/tones.js';
import { formatClock, relativeTime } from '../lib/format.js';

/**
 * Every clickable control in the dashboard, in one component.
 *
 * The three variants are the three shapes the UI already uses: `nav` for the
 * sidebar sections, `filter` for the decision chips, and `chip` for an outbound
 * source link. Callers still own their own semantics — `aria-current` on the
 * nav, `target`/`rel` on a link — because those differ per call site and are
 * passed straight through.
 */
const BUTTON_VARIANTS = {
  nav: {
    base: 'relative w-full rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap transition',
    active: 'autora-nav-active border border-accent/40 bg-accent/10 text-white',
    inactive: 'border border-transparent text-ink-500 hover:bg-ink-900 hover:text-ink-300',
  },
  filter: {
    base: 'rounded-full border px-3 py-1 font-mono text-[11px] transition',
    active: 'border-accent/50 bg-accent/10 text-white',
    inactive: 'border-ink-700 text-ink-500 hover:border-ink-500 hover:text-ink-300',
  },
  chip: {
    base: 'rounded-full border px-2 py-0.5 font-mono text-[11px] transition',
    // No active state: a source chip is a link, never a selected control.
    inactive: 'border-ink-700 text-ink-500 hover:border-accent hover:text-accent',
  },
};

export function Button({ variant = 'filter', active = false, href, className = '', children, ...props }) {
  const styles = BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.filter;
  const classes = [styles.base, (active && styles.active) || styles.inactive, className]
    .filter(Boolean)
    .join(' ');

  // An href means a real link: it must stay an anchor so it keeps link
  // semantics, middle-click, and the browser's own affordances.
  if (href) {
    return (
      <a href={href} className={classes} {...props}>
        {children}
      </a>
    );
  }

  return (
    <button type="button" className={classes} {...props}>
      {children}
    </button>
  );
}

/**
 * How fresh a section's data is: "live · 3s ago", or "stale · last read 14:32:05".
 *
 * The relative age is computed at render time and needs no timer of its own —
 * every successful poll calls setLastUpdated(new Date()), which re-renders this
 * component, so the figure is never more than one interval behind. Adding an
 * interval here would be a second clock reporting on the first.
 *
 * The dot flashes on the transition between live and stale, and only then: it is
 * keyed on `stale` rather than on the timestamp, so a steady stream of
 * successful polls does not restart the animation every few seconds.
 */
export function RefreshTag({ query }) {
  if (!query?.lastUpdated) return null;

  const iso = query.lastUpdated.toISOString();
  const ago = relativeTime(iso);

  if (query.stale) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-amber-400">
        <span key="stale" className="autora-flash inline-flex">
          <Dot tone="warn" />
        </span>
        stale · last read {formatClock(iso)}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-500">
      <span key="live" className="autora-flash inline-flex">
        <Dot tone="good" />
      </span>
      <span className="text-ink-300">live</span>
      <span aria-hidden="true">·</span>
      <time dateTime={iso} title={`Last successful read at ${formatClock(iso)}`}>
        {ago ?? `updated ${formatClock(iso)}`}
      </time>
    </span>
  );
}

export function Panel({ title, subtitle, actions, children, className = '' }) {
  return (
    // `min-w-0` is structural, not cosmetic: a panel is frequently a grid item,
    // and a grid item's default `min-width: auto` refuses to shrink below its
    // content's minimum. One long unbroken string inside — a stringified JSON
    // payload in the activity log, say — would otherwise stretch the panel, its
    // grid, and the whole document far past the viewport.
    <section
      className={`autora-panel min-w-0 rounded-xl border border-ink-700 bg-ink-900/60 ${className}`}
    >
      {(title || actions) && (
        <header className="autora-panel-head flex flex-wrap items-baseline justify-between gap-3 border-b border-ink-800 px-5 py-4">
          <div className="min-w-0">
            {title && (
              <h2 className="font-mono text-xs tracking-[0.18em] text-ink-500 uppercase">{title}</h2>
            )}
            {subtitle && <p className="mt-1 text-xs text-ink-500">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Badge({ children, tone = 'muted', className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${TONE_RING[tone]} ${TONE_TEXT[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = 'muted', pulse = false }) {
  const bg = TONE_DOT[tone];
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${bg} opacity-60`} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${bg}`} />
    </span>
  );
}

export function Metric({ label, value, hint, tone = 'plain' }) {
  return (
    <div className="autora-surface autora-lift min-w-0 rounded-lg border border-ink-800 px-4 py-3">
      <p className="font-mono text-[11px] tracking-[0.14em] text-ink-500 uppercase">{label}</p>
      <p className={`autora-numeric mt-1.5 text-2xl font-semibold ${TONE_TEXT[tone]}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

export function Row({ label, value, tone = 'plain' }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-ink-800 pb-2 last:border-0">
      <dt className="text-sm text-ink-500">{label}</dt>
      {/* `wrap-anywhere` (overflow-wrap: anywhere), not `break-words`: only the
          former stops a long unbreakable token from setting the element's
          min-content width. Without it a mono error code like
          [generation:generation_rate_limited] widens the whole grid and pushes
          the panel past the viewport at 375px. `min-w-0` lets it shrink. */}
      <dd className={`min-w-0 text-right font-mono text-sm wrap-anywhere ${TONE_TEXT[tone]}`}>{value}</dd>
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center gap-3 py-6 text-sm text-ink-500" role="status">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-700 border-t-accent" />
      {label}
    </div>
  );
}

export function Empty({ title, hint }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-700 px-4 py-8 text-center">
      <p className="text-sm text-ink-300">{title}</p>
      {hint && <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-ink-500">{hint}</p>}
    </div>
  );
}

export function ErrorNote({ error, hint }) {
  const message = error?.message || String(error);
  return (
    <div role="alert" className="rounded-lg border border-red-400/30 bg-red-400/5 px-4 py-3">
      <p className="text-sm text-red-400">{message}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

/**
 * The one place that decides which of the four states a section shows.
 * `stale` data still renders — a failed refresh must not blank the panel.
 */
export function AsyncSection({ query, empty, emptyHint, loadingLabel, errorHint, children }) {
  const { data, error, loading, stale } = query;

  if (loading && !data) return <Loading label={loadingLabel} />;
  if (error && !data) return <ErrorNote error={error} hint={errorHint} />;
  if (!data) return <Empty title={empty} hint={emptyHint} />;

  return (
    <>
      {stale && (
        <p
          role="status"
          className="mb-3 flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 font-mono text-[11px] text-amber-400"
        >
          <Dot tone="warn" />
          Showing the last successful read — the most recent refresh failed.
        </p>
      )}
      {children(data)}
    </>
  );
}
