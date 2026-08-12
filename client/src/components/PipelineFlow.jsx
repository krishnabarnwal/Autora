import { Badge, Dot } from './ui.jsx';
import { formatNumber, relativeTime } from '../lib/format.js';
import {
  buildStages,
  PIPELINE_PHASES,
  STAGE_STATE,
  STAGE_STATE_GLYPH,
  STAGE_STATE_LABEL,
} from '../lib/pipeline.js';

/**
 * The autonomous loop as a connected flow, rendered from real counters and the
 * real activity log.
 *
 * Two layouts, one data model: a horizontal track on large screens and a
 * vertical timeline on small ones, because ten stages in a horizontal row is
 * unreadable on a phone. Both come from the same buildStages() result, so they
 * cannot disagree.
 *
 * The reading order is the loop's order, and the phase band above it groups the
 * ten stages into the six words that describe what the agent does — ingest,
 * decide, create, publish, remember, repeat. The band is a label over stages
 * that already exist; it introduces no data of its own.
 *
 * What the state colours mean is deliberately narrow — see lib/pipeline.js.
 * Nothing here reports a "currently executing" stage, because the backend
 * exposes no such field; the highlighted stage is the one that logged most
 * recently, and the caption says exactly that.
 */
export function PipelineFlow({
  stats,
  counts,
  breethEnabled,
  breethActivity,
  events = [],
  status,
  now,
  stale = false,
}) {
  const { stages, latestAt, live } = buildStages({
    stats,
    counts,
    events,
    breethEnabled,
    breethActivity,
    status,
    // Recomputed on each poll-driven render. No timer of its own: the 5s
    // activity poll is what makes this move, and a stale window just means the
    // highlight retires a few seconds late.
    now: now ?? Date.now(),
  });

  return (
    <div>
      {/* Desktop: a phase band over a single connected track. */}
      <div className="hidden lg:block">
        <PhaseBand />
        <ol className="grid grid-cols-10 gap-0">
          {stages.map((stage, index) => (
            <li key={stage.key} className="autora-rise relative min-w-0 pt-7" style={{ '--i': index }}>
              <Rail
                first={index === 0}
                last={index === stages.length - 1}
                state={stage.state}
                stale={stale}
              />
              {/* The node sits on the track, above the card — the same marker the
                  vertical timeline uses, so one visual vocabulary covers both. */}
              <div className="absolute top-0 left-1/2 -translate-x-1/2">
                <StageMarker state={stage.state} tone={stage.tone} stale={stale} />
              </div>
              <StageCard stage={stage} index={index} stale={stale} />
            </li>
          ))}
        </ol>
      </div>

      {/* Mobile and tablet: a vertical timeline, one readable row per stage. */}
      <ol className="lg:hidden">
        {stages.map((stage, index) => (
          <li key={stage.key} className="autora-rise relative flex gap-3" style={{ '--i': index }}>
            <div className="relative flex w-6 shrink-0 flex-col items-center">
              <StageMarker state={stage.state} tone={stage.tone} stale={stale} className="mt-1" />
              {index < stages.length - 1 && <VerticalRail state={stage.state} stale={stale} />}
            </div>
            <div className="min-w-0 flex-1 pb-4">
              <StageBody stage={stage} index={index} />
            </div>
          </li>
        ))}
      </ol>

      <Caption live={live} latestAt={latestAt} now={now} stale={stale} />
    </div>
  );
}

/**
 * The six words the ten stages add up to. Each band spans the stages beneath it
 * (spans total ten), so it labels the flow without claiming anything extra.
 */
function PhaseBand() {
  return (
    <ol aria-hidden="true" className="grid grid-cols-10 gap-0">
      {PIPELINE_PHASES.map((phase) => (
        <li
          key={phase.key}
          className="mx-1 border-b border-ink-800 pb-1.5"
          style={{ gridColumn: `span ${phase.span} / span ${phase.span}` }}
        >
          <span className="font-mono text-[9px] tracking-[0.18em] text-ink-500 uppercase">
            {phase.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The horizontal track behind one stage: a dashed spine, drifting only through
 * the segment that leads into the stage the agent most recently reached, plus a
 * chevron at each midpoint so the flow reads left-to-right even when nothing is
 * moving.
 *
 * Stale data freezes the drift: a moving connector is a claim about right now,
 * and a failed refresh means we no longer know that.
 */
function Rail({ first, last, state, stale }) {
  const flowing = state === STAGE_STATE.ACTIVE && !stale;
  return (
    <div aria-hidden="true" className="absolute inset-x-0 top-2 h-px">
      {!first && (
        <span
          className={`absolute right-1/2 left-0 h-px ${flowing ? 'autora-connector' : 'autora-spine'}`}
        />
      )}
      {!last && (
        <>
          <span className="autora-spine absolute right-0 left-1/2 h-px" />
          {/* Direction, stated statically. The midpoint between this node and
              the next sits at 100% of this column. */}
          <span className="absolute top-0 left-full -translate-x-1/2 -translate-y-1/2 bg-ink-950 px-0.5 font-mono text-[10px] leading-none text-ink-500">
            ›
          </span>
        </>
      )}
    </div>
  );
}

function VerticalRail({ state, stale }) {
  const flowing = state === STAGE_STATE.ACTIVE && !stale;
  return (
    <span
      aria-hidden="true"
      className={`w-px flex-1 ${flowing ? 'autora-connector-y' : 'autora-spine-y'}`}
    />
  );
}

/**
 * The dot on the rail. Its treatment is the state, at a glance.
 *
 * The ring is identical in both layouts; only the caller's positioning differs,
 * which is why the offset arrives as `className` rather than being baked in.
 * Completed stages get a static signal dot and no halo — a permanent glow on
 * nine finished stages would be decoration competing with the one stage that
 * actually has something to say.
 */
function StageMarker({ state, tone, stale, className = '' }) {
  const ring = `relative z-10 flex h-4 w-4 items-center justify-center rounded-full bg-ink-950 ${className}`;

  if (state === STAGE_STATE.ACTIVE) {
    return (
      <span className={`${ring} border border-accent/60`}>
        <span className={`h-2 w-2 rounded-full bg-accent ${stale ? '' : 'autora-pulse'}`} />
      </span>
    );
  }
  if (state === STAGE_STATE.DEGRADED) {
    return (
      <span className={`${ring} border border-amber-400/60`}>
        <Dot tone="warn" />
      </span>
    );
  }
  if (state === STAGE_STATE.DONE) {
    return (
      <span className={`${ring} border border-signal/40`}>
        <Dot tone={tone === 'warn' ? 'warn' : 'good'} />
      </span>
    );
  }
  return (
    <span className={`${ring} border border-ink-700`}>
      <Dot tone="muted" />
    </span>
  );
}

const CARD_STATE = {
  [STAGE_STATE.ACTIVE]: 'border-accent/50 bg-accent/5',
  [STAGE_STATE.DEGRADED]: 'border-amber-400/40 bg-amber-400/5',
  [STAGE_STATE.DONE]: 'border-ink-700 bg-ink-950/60',
  [STAGE_STATE.WAITING]: 'border-ink-800 bg-ink-950/40',
  [STAGE_STATE.OFF]: 'border-ink-800 bg-ink-950/30',
};

function StageCard({ stage, index, stale }) {
  // The travelling light is a claim that this is where the agent is right now.
  // A failed refresh withdraws the claim while keeping the border and the label.
  const active = stage.state === STAGE_STATE.ACTIVE && !stale;
  return (
    <div
      className={`autora-lift relative mx-1 overflow-hidden rounded-lg border px-2.5 py-2.5 ${
        CARD_STATE[stage.state]
      } ${stage.state === STAGE_STATE.OFF ? 'opacity-60' : ''} ${active ? 'autora-stage-active' : ''}`}
    >
      <StageBody stage={stage} index={index} compact />
    </div>
  );
}

/** Shared content, so the two layouts can never show different numbers. */
function StageBody({ stage, index, compact = false }) {
  const active = stage.state === STAGE_STATE.ACTIVE;
  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-ink-500">{String(index + 1).padStart(2, '0')}</span>
        <StageStateTag state={stage.state} />
      </div>

      <p
        className={`mt-1 leading-snug font-medium ${active ? 'text-white' : 'text-ink-300'} ${
          compact ? 'text-[11px]' : 'text-sm'
        }`}
        title={stage.label}
      >
        {compact ? stage.short : stage.label}
      </p>

      {Number.isFinite(stage.value) && (
        <p
          className={`autora-numeric mt-1 font-mono ${compact ? 'text-base' : 'text-lg'} ${
            active ? 'text-accent' : 'text-white'
          }`}
        >
          {formatNumber(stage.value)}
        </p>
      )}

      <p className="mt-1 text-[10px] leading-snug text-ink-500">{stage.note}</p>
    </>
  );
}

const TAG_TONE = {
  [STAGE_STATE.ACTIVE]: 'text-accent',
  [STAGE_STATE.DEGRADED]: 'text-amber-400',
  [STAGE_STATE.DONE]: 'text-signal',
  [STAGE_STATE.WAITING]: 'text-ink-500',
  [STAGE_STATE.OFF]: 'text-ink-500',
};

/**
 * The state as a word, always. Colour and the glyph are redundant signals on
 * top of it, so the state survives with neither.
 */
function StageStateTag({ state }) {
  return (
    <span className={`font-mono text-[9px] tracking-wide uppercase ${TAG_TONE[state]}`}>
      <span aria-hidden="true" className="mr-0.5">
        {STAGE_STATE_GLYPH[state]}
      </span>
      {STAGE_STATE_LABEL[state]}
    </span>
  );
}

/**
 * Says precisely what the highlight means. The distinction matters: the buffer
 * is process-local, so "no recent line" is not "the agent is stopped".
 */
function Caption({ live, latestAt, now, stale }) {
  const when = live ? relativeTime(new Date(latestAt).toISOString(), now ?? Date.now()) : null;
  return (
    <p className="mt-3 border-t border-ink-800 pt-3 text-[11px] leading-relaxed text-ink-500">
      {stale && (
        <span className="text-amber-400">
          Showing the last known state — the most recent refresh failed.{' '}
        </span>
      )}
      {live ? (
        <>
          Highlighted stage is the newest entry in the activity log
          {when ? <span className="text-ink-300"> ({when})</span> : null} — the latest stage observed, not a
          live read of the running process.
        </>
      ) : (
        'No recent activity in the log buffer. Counters below each stage are cumulative and persist; the log itself is process-local and clears on restart.'
      )}
    </p>
  );
}

/** Compact legend explaining the states and where the numbers come from. */
export function PipelineLegend() {
  return (
    <div className="space-y-2.5">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {[STAGE_STATE.ACTIVE, STAGE_STATE.DONE, STAGE_STATE.WAITING, STAGE_STATE.DEGRADED, STAGE_STATE.OFF].map(
          (state) => (
            <li key={state} className="flex items-center gap-1.5 text-[11px] text-ink-500">
              <StageStateTag state={state} />
              <span>{LEGEND_NOTE[state]}</span>
            </li>
          )
        )}
      </ul>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
        <Badge tone="good">no human prompt after init</Badge>
        <Badge tone="muted">counters come from the agent record</Badge>
        <Badge tone="muted">stages without a counter show none</Badge>
      </div>
    </div>
  );
}

const LEGEND_NOTE = {
  [STAGE_STATE.ACTIVE]: 'logged most recently',
  [STAGE_STATE.DONE]: 'has run — proven by a counter or a log line',
  [STAGE_STATE.WAITING]: 'no evidence yet',
  [STAGE_STATE.DEGRADED]: 'its newest line was a warning or error',
  [STAGE_STATE.OFF]: 'disabled by configuration',
};
