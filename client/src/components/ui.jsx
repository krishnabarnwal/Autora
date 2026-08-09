/**
 * Shared presentational primitives for the dashboard.
 *
 * Every section renders one of four states — loading, error, empty, or data —
 * and they all come from here so a missing state is a visible omission rather
 * than an accidental blank panel.
 */

const TONES = {
  good: 'text-signal',
  warn: 'text-amber-400',
  bad: 'text-red-400',
  info: 'text-accent',
  muted: 'text-ink-500',
  plain: 'text-white',
};

export function Panel({ title, subtitle, actions, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-ink-700 bg-ink-900/60 ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-ink-800 px-5 py-4">
          <div>
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
  const ring = {
    good: 'border-signal/40 bg-signal/10',
    warn: 'border-amber-400/40 bg-amber-400/10',
    bad: 'border-red-400/40 bg-red-400/10',
    info: 'border-accent/40 bg-accent/10',
    muted: 'border-ink-700 bg-ink-800/60',
    plain: 'border-ink-700 bg-ink-800/60',
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${ring} ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = 'muted', pulse = false }) {
  const bg = {
    good: 'bg-signal',
    warn: 'bg-amber-400',
    bad: 'bg-red-400',
    info: 'bg-accent',
    muted: 'bg-ink-500',
    plain: 'bg-ink-300',
  }[tone];
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${bg} opacity-60`} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${bg}`} />
    </span>
  );
}

export function Metric({ label, value, hint, tone = 'plain' }) {
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950/40 px-4 py-3">
      <p className="font-mono text-[11px] tracking-[0.14em] text-ink-500 uppercase">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums ${TONES[tone]}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

export function Row({ label, value, tone = 'plain' }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-ink-800 pb-2 last:border-0">
      <dt className="text-sm text-ink-500">{label}</dt>
      <dd className={`font-mono text-sm ${TONES[tone]}`}>{value}</dd>
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
        <p className="mb-3 font-mono text-[11px] text-amber-400">
          Showing the last successful read — the most recent refresh failed.
        </p>
      )}
      {children(data)}
    </>
  );
}
