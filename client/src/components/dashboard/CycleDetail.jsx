/**
 * One autonomous cycle, in detail.
 *
 * A reader should get four answers in about ten seconds: what the agent did this
 * cycle, why it decided what it decided, what it published, and what it
 * remembered. So the drawer is ordered that way — outcome, then the eight-stage
 * trace, then the decision and its reasoning, then the post, then anything that
 * went wrong.
 *
 * Every value comes from lib/cycles.js, which reads the existing /activity,
 * /memory and /feed responses and nothing else. A field the backend did not send
 * renders as "Not recorded" through <Fact>; no number here is derived, inferred
 * from a neighbouring cycle, or made up to fill a slot.
 *
 * The activity buffer is process-local and capped, so cycles older than it keep
 * their persisted decision and report the stage trace as unavailable. That is
 * shown as a stated limit of the buffer, never as a cycle that did nothing.
 */

import { useEffect, useRef } from 'react';
import { Badge, Button, Dot } from '../ui.jsx';
import {
  outcomeMeta,
  STAGE_STATUS,
  STAGE_STATUS_LABEL,
  STAGE_STATUS_TONE,
} from '../../lib/cycles.js';
import { decisionMeta, decisionReasoning, NO_REASONING_RECORDED, rejectionLabel } from '../../lib/decisions.js';
import { formatCount, statusMeta } from '../../lib/cycleAnalytics.js';
import { DECISION_TONE, LEVEL_TONE, TONE_TEXT } from '../../lib/tones.js';
import { formatDateTime, formatInterval, formatNumber, hostOf, relativeTime } from '../../lib/format.js';

/**
 * A label and a value that may not exist.
 *
 * The absent case is the reason this component exists: a stage that logged no
 * count must not render a 0, because 0 is a measurement and absence is not. So
 * null, undefined and '' all become "Not recorded" in muted type.
 */
function Fact({ label, value, tone = 'plain', mono = true }) {
  const missing = value === null || value === undefined || value === '';
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] tracking-[0.14em] text-ink-500 uppercase">{label}</dt>
      <dd
        className={`mt-0.5 min-w-0 text-sm wrap-anywhere ${mono ? 'font-mono' : ''} ${
          missing ? 'text-ink-500 italic' : TONE_TEXT[tone]
        }`}
      >
        {missing ? 'Not recorded' : value}
      </dd>
    </div>
  );
}

/** The cycle's headline: what happened, when, and when the next one is due. */
function CycleSummary({ cycle }) {
  const meta = outcomeMeta(cycle.outcome);
  const failed = cycle.failed === true;

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950/40 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={failed ? 'bad' : meta.tone}>
          {meta.recorded === false ? 'Outcome not recorded' : meta.label}
        </Badge>
        {failed && <Badge tone="bad">failed</Badge>}
        {!cycle.traced && <Badge tone="muted">Historical execution</Badge>}
        {cycle.traced && cycle.partial && <Badge tone="warn">partial trace</Badge>}
        {cycle.at && (
          <time dateTime={cycle.at} className="ml-auto font-mono text-[11px] text-ink-500">
            {relativeTime(cycle.at) ?? formatDateTime(cycle.at)}
          </time>
        )}
      </div>

      {meta.blurb && <p className="mt-2 text-sm leading-snug text-ink-300">{meta.blurb}.</p>}

      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Cycle ID" value={cycle.cycleId} />
        <Fact label="Started" value={cycle.startedAt ? formatDateTime(cycle.startedAt) : null} />
        <Fact label="Completed" value={cycle.completedAt ? formatDateTime(cycle.completedAt) : null} />
        <Fact
          label="Duration"
          value={cycle.durationMs === null ? null : formatInterval(cycle.durationMs)}
        />
        <Fact
          label="Consecutive failures"
          value={cycle.consecutiveFailures === null ? null : formatNumber(cycle.consecutiveFailures)}
          tone={cycle.consecutiveFailures > 0 ? 'warn' : 'plain'}
        />
        <Fact
          label="Next cycle due"
          value={cycle.nextCycleAt ? formatDateTime(cycle.nextCycleAt) : null}
        />
      </dl>

      {cycle.nextDelayMs !== null && (
        <p className="mt-2.5 font-mono text-[11px] text-ink-500">
          the worker slept {formatInterval(cycle.nextDelayMs)} after this cycle
        </p>
      )}
    </div>
  );
}

/**
 * The eight stages, in the order runCycle executes them.
 *
 * Each row is that stage's own log line plus whatever counts it reported. A stage
 * that logged nothing says "Not recorded" rather than borrowing a plausible value
 * — which matters most on a cycle whose trace has aged out, where every row says
 * so at once and the reason is stated above.
 */
function StageTrace({ cycle }) {
  return (
    <ol className="space-y-1.5">
      {cycle.stages.map((stage, index) => {
        const tone = STAGE_STATUS_TONE[stage.status];
        const facts = (stage.facts || []).filter(([, value]) => value !== null && value !== undefined);
        const missing = stage.status === STAGE_STATUS.MISSING;

        return (
          <li
            key={stage.key}
            className="autora-rise rounded-lg border border-ink-800 bg-ink-950/40 px-3.5 py-2.5"
            style={{ '--i': index }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Dot tone={tone} />
              <span className="font-mono text-[11px] tracking-[0.12em] text-ink-300 uppercase">
                {stage.label}
              </span>
              {/* The status in words beside the dot: colour is never the only
                  signal for whether a stage ran, was skipped, or failed. */}
              <span className={`font-mono text-[10px] ${TONE_TEXT[tone]}`}>
                {STAGE_STATUS_LABEL[stage.status]}
              </span>
              {stage.at && (
                <time dateTime={stage.at} className="ml-auto font-mono text-[10px] text-ink-500">
                  {formatDateTime(stage.at)}
                </time>
              )}
            </div>

            <p className={`mt-1 text-sm leading-snug ${missing ? 'text-ink-500 italic' : 'text-ink-300'}`}>
              {stage.headline || (missing ? 'Not recorded' : stage.blurb)}
            </p>

            {/* The stage's own error code, verbatim. It is the most useful thing
                on a failed cycle and is never summarised away. */}
            {stage.code && (
              <p className="mt-1 font-mono text-[11px] wrap-anywhere text-red-400">code: {stage.code}</p>
            )}

            {/* The editor's sentence, when the model gave one. */}
            {stage.note && <p className="mt-1 text-xs leading-relaxed text-ink-500">{stage.note}</p>}

            {facts.length > 0 && (
              <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {facts.map(([label, value]) => (
                  <div key={label} className="flex items-baseline gap-1.5">
                    <dt className="font-mono text-[10px] text-ink-500">{label}</dt>
                    <dd className="autora-numeric font-mono text-[11px] text-ink-300">
                      {typeof value === 'number' ? formatNumber(value) : value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {/* The shortlist the editor actually judged. */}
            {stage.topics && stage.topics.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {stage.topics.map((topic, i) => (
                  <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink-500">
                    <span className="font-mono text-ink-700">{i + 1}</span>
                    <span className="min-w-0">{topic}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Why the agent decided what it did.
 *
 * Read from the persisted memory row, which is where runCycle wrote it — so it
 * survives the restart that empties the activity buffer. Reasoning is rendered
 * through decisionReasoning(), the same reader the decisions list uses, which
 * returns `recorded: false` rather than substituting a sentence when the backend
 * captured none. Nothing on this screen is generated in the frontend.
 */
function DecisionExplain({ decision }) {
  if (!decision) {
    return (
      <p className="rounded-lg border border-dashed border-ink-700 px-4 py-5 text-center text-sm text-ink-500">
        No decision row is joined to this cycle. Either the cycle recorded none, or
        its row is outside the window this dashboard reads.
      </p>
    );
  }

  const tone = DECISION_TONE[decision.decision] || 'muted';
  const meta = decisionMeta(decision.decision);
  const { reasons, prose, recorded } = decisionReasoning(decision);
  const category = rejectionLabel(decision.rejectionCategory);
  const hasScore = decision.score !== null && decision.score !== undefined;

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950/40 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>
          <span aria-hidden="true">{meta.glyph}</span>
          {meta.label}
        </Badge>
        {hasScore && (
          <span className="autora-numeric font-mono text-[11px] text-ink-500">
            score <span className="text-ink-300">{decision.score}</span>
          </span>
        )}
        {decision.createdAt && (
          <time dateTime={decision.createdAt} className="ml-auto font-mono text-[11px] text-ink-500">
            {formatDateTime(decision.createdAt)}
          </time>
        )}
      </div>

      {decision.topic && <p className="mt-2 text-sm leading-snug text-ink-300">{decision.topic}</p>}

      <p className={`mt-1 text-xs leading-relaxed ${TONE_TEXT[tone]}`}>
        {meta.statement}
        {category && (
          <>
            {' '}
            <span className="text-ink-300">Category: {category}</span>{' '}
            <span className="font-mono text-[11px] text-ink-500">({decision.rejectionCategory})</span>
          </>
        )}
      </p>

      {recorded ? (
        <div className="mt-3">
          <p className="font-mono text-[10px] tracking-[0.16em] text-ink-500 uppercase">Why</p>
          {reasons.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-ink-300">
              {reasons.map((entry, index) => (
                <li key={index}>{entry}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-ink-300">{prose}</p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-ink-500 italic">{NO_REASONING_RECORDED}</p>
      )}

      {decision.sources?.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] tracking-[0.16em] text-ink-500 uppercase">Sources</span>
          {decision.sources.map((url) => (
            <Button key={url} variant="chip" href={url} target="_blank" rel="noreferrer noopener">
              {hostOf(url)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The post this cycle published, if it published one. */
function PublishedPost({ cycle }) {
  if (!cycle.postId) {
    // "Nothing" and "nothing recorded" are different claims. A persisted decision
    // row records the post id it published, so its absence there is evidence. With
    // neither a decision row nor a trace there is no evidence either way, and the
    // panel says that instead.
    const knowable = cycle.traced || Boolean(cycle.decision);
    return (
      <p className="rounded-lg border border-dashed border-ink-700 px-4 py-5 text-center text-sm text-ink-500">
        {knowable
          ? 'This cycle published nothing.'
          : 'No post is recorded for this cycle, and neither its trace nor a decision row is available to confirm whether it published one.'}
      </p>
    );
  }
  if (!cycle.post) {
    return (
      <div className="rounded-lg border border-ink-800 bg-ink-950/40 px-4 py-3.5">
        <p className="text-sm text-ink-300">
          This cycle published post <span className="font-mono wrap-anywhere">{cycle.postId}</span>.
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          Its text is outside the feed window this dashboard reads, so it is not shown here.
        </p>
      </div>
    );
  }

  const post = cycle.post;
  return (
    <article className="rounded-lg border border-ink-800 bg-ink-950/40 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="good">published</Badge>
        {post.createdAt && (
          <time dateTime={post.createdAt} className="ml-auto font-mono text-[11px] text-ink-500">
            {formatDateTime(post.createdAt)}
          </time>
        )}
      </div>
      <p className="mt-2.5 text-sm leading-relaxed whitespace-pre-wrap text-ink-300">{post.text}</p>
      {post.rationale && (
        <div className="mt-3">
          <p className="font-mono text-[10px] tracking-[0.16em] text-ink-500 uppercase">Rationale</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">{post.rationale}</p>
        </div>
      )}
      {post.sources?.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] tracking-[0.16em] text-ink-500 uppercase">Sources</span>
          {post.sources.map((url) => (
            <Button key={url} variant="chip" href={url} target="_blank" rel="noreferrer noopener">
              {hostOf(url)}
            </Button>
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * Everything that went wrong in this cycle, unedited.
 *
 * Rate limits, provider errors, failed sources and Breeth outages all surface
 * here with their own level, tag and message. Nothing is downgraded or hidden:
 * a cycle that published *and* hit a retry shows both, because the retry is real
 * and a reader deciding whether to trust the system should see it.
 */
function Notices({ notices, traced }) {
  if (notices.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-ink-700 px-4 py-5 text-center text-sm text-ink-500">
        {traced
          ? 'No warnings or errors were logged during this cycle.'
          : 'Whether this cycle logged a warning or an error is not recorded — warnings live only in the activity buffer, and this cycle has aged out of it.'}
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {notices.map((notice, index) => {
        const tone = LEVEL_TONE[notice.level] || 'warn';
        return (
          <li
            key={`${notice.ts}-${index}`}
            className="rounded-lg border border-ink-800 bg-ink-950/40 px-3.5 py-2.5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Dot tone={tone} />
              <Badge tone={tone}>{notice.level}</Badge>
              <span className="font-mono text-[10px] text-ink-500">{notice.tag}</span>
              {notice.kind === 'rate_limited' && <Badge tone="warn">rate limit</Badge>}
              {notice.provider && notice.kind !== 'rate_limited' && <Badge tone="warn">provider</Badge>}
              {notice.ts && (
                <time dateTime={notice.ts} className="ml-auto font-mono text-[10px] text-ink-500">
                  {formatDateTime(notice.ts)}
                </time>
              )}
            </div>
            <p className="mt-1 text-sm leading-snug wrap-anywhere text-ink-300">{notice.message}</p>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The clickable list of cycles.
 *
 * A real <button> per row, so keyboard and screen-reader users get the control
 * for free rather than a div with a click handler. Each row states the outcome in
 * words, so the list is readable without colour.
 *
 * `recency` is a position in this list, not the agent's cycle number: the list is
 * bounded by what the buffer and the memory window still hold, so a global
 * ordinal cannot honestly be derived from it. agent.stats.cyclesRun is the total.
 */
export function CycleList({ cycles, selectedId, onSelect }) {
  if (cycles.length === 0) {
    return (
      <p className="py-2 text-sm text-ink-500">
        No cycles to inspect yet. A cycle appears here once the agent has run one
        and recorded it.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {cycles.map((cycle, index) => {
        const meta = outcomeMeta(cycle.outcome);
        const outcomeKnown = meta.recorded !== false;
        const failed = cycle.failed === true;
        const tone = failed ? 'bad' : meta.tone;
        const selected = cycle.cycleId === selectedId;
        const warnings = cycle.notices.length;

        return (
          <li key={cycle.cycleId ?? index}>
            <button
              type="button"
              onClick={() => onSelect(cycle.cycleId)}
              aria-expanded={selected}
              className={`autora-rise autora-lift w-full min-w-0 rounded-lg border px-3.5 py-2.5 text-left transition ${
                selected
                  ? 'border-accent/50 bg-accent/10'
                  : 'border-ink-800 bg-ink-950/40 hover:border-ink-500'
              }`}
              style={{ '--i': Math.min(index, 12) }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Dot tone={tone} />
                {/* A traced cycle leads with the scheduler's outcome. An untraced
                    one has no outcome to lead with, so it leads with the decision
                    it persisted — the fact that is actually known — rather than
                    with a badge reading "Not recorded" beside it. */}
                {outcomeKnown ? (
                  <Badge tone={tone}>{failed ? 'Failed' : meta.label}</Badge>
                ) : (
                  cycle.decision && (
                    <Badge tone={DECISION_TONE[cycle.decision.decision] || 'muted'}>
                      {decisionMeta(cycle.decision.decision).label}
                    </Badge>
                  )
                )}
                {outcomeKnown && cycle.decision && (
                  <span className="font-mono text-[10px] text-ink-500">
                    {decisionMeta(cycle.decision.decision).label.toLowerCase()}
                  </span>
                )}
                {warnings > 0 && (
                  <span className="font-mono text-[10px] text-amber-400">
                    {formatNumber(warnings)} {warnings === 1 ? 'notice' : 'notices'}
                  </span>
                )}
                {!cycle.traced && (
                  <span className="font-mono text-[10px] text-ink-500">historical</span>
                )}
                {cycle.at && (
                  <time dateTime={cycle.at} className="ml-auto font-mono text-[10px] text-ink-500">
                    {relativeTime(cycle.at) ?? formatDateTime(cycle.at)}
                  </time>
                )}
              </div>
              <p className="mt-1 min-w-0 truncate text-sm text-ink-300">
                {cycle.decision?.topic || cycle.cycleId || 'Cycle'}
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-ink-500">
                {cycle.durationMs === null ? 'duration not recorded' : `took ${formatInterval(cycle.durationMs)}`}
                {' · '}
                {cycle.postId ? 'published a post' : 'no post'}
              </p>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The durable row this cycle wrote — an aggregate, and labelled as one.
 *
 * This is the only part of the drawer that survives a restart, and the whole
 * reason it is a separate block rather than folded into the trace above: counts
 * and timings are not a narrative. A reader must be able to tell at a glance that
 * "6 topics discovered" came from a summary row, not from a discovery log line
 * that is still in the buffer.
 *
 * Every value is rendered through <Fact>, so a metric the cycle never measured —
 * a cycle that died before discovery, or one still running — says "Not recorded"
 * instead of a zero that would read as a real measurement.
 */
function PersistedRun({ run }) {
  if (!run) {
    return (
      <p className="text-sm leading-relaxed text-ink-500">
        No persistent record for this cycle. Execution history began when the
        history collection did, so cycles that ran before it have only whatever
        their decision row still holds.
      </p>
    );
  }

  const status = statusMeta(run.status);
  const failure = run.failureMessage || run.failureCode || null;

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950/40 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone={status.tone} />
        <Badge tone={status.tone}>{status.label}</Badge>
        {run.status === 'interrupted' && (
          <span className="font-mono text-[10px] text-amber-400">
            the process ended before this cycle closed
          </span>
        )}
      </div>

      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Topics discovered" value={formatCount(run.topicsDiscovered)} />
        <Fact label="After filtering" value={formatCount(run.topicsAfterFilter)} />
        <Fact label="Rejected" value={formatCount(run.topicsRejected)} />
        <Fact label="Candidates selected" value={formatCount(run.topicsSelected)} />
        <Fact label="Posts published" value={formatCount(run.postsPublished)} />
        <Fact label="LLM calls" value={formatCount(run.llmCalls)} />
        <Fact label="Provider" value={run.provider} />
        <Fact label="Model" value={run.model} />
        <Fact
          label="Provider failure"
          value={run.providerFailureCode}
          tone={run.providerFailureCode ? 'warn' : 'plain'}
        />
      </dl>

      {failure && (
        <p className="mt-3 min-w-0 font-mono text-[11px] wrap-anywhere text-red-300">{failure}</p>
      )}

      {run.providerFailureCode && !failure && (
        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          The provider failed during this cycle and the pipeline handled it without
          failing the cycle — a rate limit becomes a deliberate skip rather than an
          error. Recorded here so the failure stays visible.
        </p>
      )}
    </div>
  );
}

/**
 * A titled block inside the drawer.
 */
function Block({ title, hint, children }) {
  return (
    <section className="mt-5 first:mt-0">
      <h3 className="font-mono text-[11px] tracking-[0.18em] text-ink-500 uppercase">{title}</h3>
      {hint && <p className="mt-1 text-xs leading-relaxed text-ink-500">{hint}</p>}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/**
 * The drawer.
 *
 * A dialog rather than a page: the cycle list stays where it was, so closing
 * returns the reader to their place in it. Escape closes, focus moves to the
 * close button on open and returns to the row that opened it, and the background
 * is inert to a screen reader via aria-hidden on the app root — all of which are
 * hand-rolled here because the dashboard has no dialog primitive and this change
 * is not the place to add a dependency for one.
 */
export function CycleDrawer({ cycle, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    if (!cycle) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    // The page behind must not scroll under the drawer.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Return focus where it came from, so keyboard use is not thrown to the top
    // of the document on close.
    const opener = document.activeElement;
    closeRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [cycle, onClose]);

  if (!cycle) return null;

  const meta = outcomeMeta(cycle.outcome);
  const label = `Cycle ${cycle.recency}, ${
    meta.recorded === false ? 'outcome not recorded' : meta.label
  }`;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* The scrim. Presentational — Escape and the close button are the real
          affordances, and both are reachable without a pointer. */}
      <button
        type="button"
        aria-label="Close cycle detail"
        tabIndex={-1}
        onClick={onClose}
        className="autora-fade absolute inset-0 h-full w-full cursor-default bg-ink-950/80 backdrop-blur-sm"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="autora-drawer relative flex h-full w-full flex-col border-l border-ink-700 bg-ink-900 shadow-2xl sm:max-w-xl lg:max-w-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-ink-800 px-5 py-4">
          <div className="min-w-0">
            <h2 className="font-mono text-xs tracking-[0.18em] text-ink-500 uppercase">
              Cycle detail
            </h2>
            <p className="mt-1 text-sm text-ink-300">
              What the agent did, why it decided, what it published, what it remembered.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-ink-700 px-3 py-1.5 font-mono text-[11px] text-ink-300 transition hover:border-ink-500 hover:text-white"
          >
            close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <CycleSummary cycle={cycle} />

          <Block
            title="Pipeline"
            hint={
              cycle.traced
                ? 'Each stage as the backend logged it during this cycle.'
                : 'Detailed activity trace unavailable. This is a historical execution: the stage-by-stage log is process-local, capped at 300 entries, and cleared on restart. What survives is the persistent record and the decision below.'
            }
          >
            <StageTrace cycle={cycle} />
          </Block>

          <Block
            title="Persistent record"
            hint="The durable row this cycle wrote: counts, timings and outcome. An aggregate, not a trace — it cannot say what happened inside a stage."
          >
            <PersistedRun run={cycle.run} />
          </Block>

          <Block title="The decision" hint="Persisted at decision time; not generated here.">
            <DecisionExplain decision={cycle.decision} />
          </Block>

          <Block title="Published post">
            <PublishedPost cycle={cycle} />
          </Block>

          <Block title="Failures and degradation">
            <Notices notices={cycle.notices} traced={cycle.traced} />
          </Block>
        </div>
      </div>
    </div>
  );
}
