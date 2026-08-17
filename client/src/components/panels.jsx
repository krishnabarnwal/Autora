import { Badge, Button, Dot } from './ui.jsx';
import { formatDateTime, formatNumber, hostOf } from '../lib/format.js';
import { DECISION_TONE, LEVEL_TONE, TONE_TEXT } from '../lib/tones.js';
import { decisionMeta, decisionReasoning, NO_REASONING_RECORDED, rejectionLabel } from '../lib/decisions.js';
import { lifecyclePhase, phaseCounts, phaseMeta, PHASE_ORDER } from '../lib/lifecycle.js';

/** Lifetime decision counts. Lives beside MemoryList — the rows it summarizes. */
export function TotalsRow({ totals }) {
  if (!totals) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {['published', 'rejected', 'deferred'].map((key) => (
        <Badge key={key} tone={DECISION_TONE[key]}>
          <span aria-hidden="true">{decisionMeta(key).glyph}</span>
          {key}: <span className="autora-numeric">{formatNumber(totals[key])}</span>
        </Badge>
      ))}
    </div>
  );
}

/**
 * Published posts — the agent's actual product output.
 *
 * The feed route returns toFeedJSON(): exactly {id, createdAt, text, rationale,
 * sources}. There is no title, topic, score, model or provider in this response
 * (they exist on toDetailJSON, which this endpoint does not use), so none is
 * rendered. The body text is the headline here because it is the only prose the
 * contract guarantees, and inventing a title from it would be fabrication.
 *
 * Each post is an article-like card: body first, then the agent's own rationale
 * as a distinct attributed block, then a footer of real metadata and outbound
 * sources. Dense on purpose — this is a control room, not a blog.
 */
export function FeedList({ data }) {
  const posts = data?.posts || [];
  if (posts.length === 0) {
    return (
      <p className="py-2 text-sm text-ink-500">
        Nothing published yet — the agent publishes on its own schedule.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {posts.map((post, index) => (
        <li
          key={post.id}
          className="autora-rise autora-lift autora-surface overflow-hidden rounded-lg border border-ink-800"
          style={{ '--i': index }}
        >
          <article className="px-4 py-3.5">
            <div className="flex items-center gap-2">
              <Dot tone="good" />
              <span className="font-mono text-[10px] tracking-[0.16em] text-signal uppercase">
                published
              </span>
              <time
                dateTime={post.createdAt}
                className="autora-numeric ml-auto font-mono text-[11px] text-ink-500"
              >
                {formatDateTime(post.createdAt)}
              </time>
            </div>

            <p className="mt-2.5 text-[15px] leading-relaxed font-medium text-white">{post.text}</p>

            {post.rationale && (
              <div className="mt-3 border-l-2 border-accent/40 pl-3">
                <p className="font-mono text-[10px] tracking-[0.14em] text-ink-500 uppercase">
                  Why the agent published this
                </p>
                <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-300">
                  {post.rationale}
                </p>
              </div>
            )}

            <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-ink-800 pt-2.5">
              <span className="font-mono text-[10px] text-ink-500">{post.id}</span>
              {post.sources?.length > 0 && (
                <>
                  <span className="font-mono text-[10px] text-ink-500">
                    {post.sources.length} source{post.sources.length === 1 ? '' : 's'}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {post.sources.map((source) => (
                      <Button key={source} variant="chip" href={source} target="_blank" rel="noreferrer">
                        {hostOf(source)}
                      </Button>
                    ))}
                  </div>
                </>
              )}
            </footer>
          </article>
        </li>
      ))}
    </ul>
  );
}

/**
 * Editorial decisions — the evidence that the agent chooses rather than
 * publishes everything it finds.
 *
 * Each row leads with the decision as an action ("Chose to publish", "Deferred")
 * carrying a glyph, a verb and a plain sentence, so the outcome survives without
 * colour. Everything below it is real: score, rejectionCategory, postId, cycleId,
 * sources and createdAt, each rendered only when the row actually has it.
 *
 * There is deliberately no per-row "reason" prose. TopicMemory.reason is never
 * sent to the client, and a plausible-sounding substitute would be a fabrication
 * attributed to the agent.
 */
export function MemoryList({ data }) {
  const rows = data?.memory || [];
  if (rows.length === 0) {
    return (
      <p className="py-2 text-sm text-ink-500">
        No decisions recorded yet — the first cycle will populate local memory.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {rows.map((row, index) => (
        <li
          key={`${row.normalizedTopic}-${row.createdAt}-${index}`}
          className="autora-rise autora-lift rounded-lg border border-ink-800 bg-ink-950/40 px-3.5 py-3"
          style={{ '--i': index }}
        >
          <DecisionRow row={row} />
        </li>
      ))}
    </ul>
  );
}

function DecisionRow({ row }) {
  const tone = DECISION_TONE[row.decision] || 'muted';
  const meta = decisionMeta(row.decision);
  const reason = rejectionLabel(row.rejectionCategory);
  const hasScore = row.score !== null && row.score !== undefined;
  const { reasons, prose, recorded } = decisionReasoning(row);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>
          {/* Decorative: the badge already says the decision in words. */}
          <span aria-hidden="true">{meta.glyph}</span>
          {meta.label}
        </Badge>
        {hasScore && (
          <span className="autora-numeric font-mono text-[11px] text-ink-500">
            score <span className="text-ink-300">{row.score}</span>
          </span>
        )}
        <time
          dateTime={row.createdAt}
          className="ml-auto font-mono text-[11px] text-ink-500"
        >
          {formatDateTime(row.createdAt)}
        </time>
      </div>

      <p className="mt-2 text-sm leading-snug text-ink-300">{row.topic}</p>

      <p className={`mt-1 text-xs leading-relaxed ${TONE_TEXT[tone]}`}>
        {meta.statement}
        {reason && (
          <>
            {' '}
            <span className="text-ink-300">Category: {reason}</span>{' '}
            <span className="font-mono text-[11px] text-ink-500">({row.rejectionCategory})</span>
          </>
        )}
      </p>

      {/*
        The "why", rendered only from what the backend actually sent. The
        editor's enumerated grounds come first, the recorded prose after, and a
        cycle that captured neither says so in as many words instead of guessing.
        The prose sentence from the statement above is never reused here.
      */}
      {recorded && (
        <div className="mt-2">
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
      )}
      {!recorded && (
        <p className="mt-2 text-xs leading-relaxed text-ink-500 italic">{NO_REASONING_RECORDED}</p>
      )}

      <DecisionRefs row={row} />
    </>
  );
}

/** The real identifiers and sources on a decision row, when present. */
function DecisionRefs({ row }) {
  const sources = row.sources || [];
  if (!row.postId && !row.cycleId && sources.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-ink-800 pt-2 font-mono text-[10px] text-ink-500">
      {row.postId && (
        <span>
          post <span className="text-ink-300">{row.postId}</span>
        </span>
      )}
      {row.cycleId && (
        <span>
          cycle <span className="text-ink-300">{row.cycleId}</span>
        </span>
      )}
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sources.map((source) => (
            <Button key={source} variant="chip" href={source} target="_blank" rel="noreferrer">
              {hostOf(source)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The autonomous loop's own log, grouped by the stage each line belongs to.
 *
 * The stage comes from the backend's tag (and, for the orchestrator's own lines,
 * from the message it wrote) — see lib/lifecycle.js. Nothing is synthesized: an
 * event the server never logged does not appear, and the level shown is the level
 * the server assigned. `filter` is the currently selected stage key, or null for
 * everything.
 */
export function ActivityList({ data, filter = null }) {
  const all = data?.events || [];
  const events = filter ? all.filter((event) => lifecyclePhase(event) === filter) : all;

  if (all.length === 0) {
    return (
      <p className="py-2 text-sm text-ink-500">
        No activity buffered yet — events appear here as cycles run. The buffer is
        process-local and clears on restart.
      </p>
    );
  }
  if (events.length === 0) {
    return (
      <p className="py-2 text-sm text-ink-500">
        No {phaseMeta(filter).label.toLowerCase()} events in the current buffer.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-ink-800">
      {events.map((event, index) => {
        const phase = phaseMeta(lifecyclePhase(event));
        const tone = LEVEL_TONE[event.level] || 'muted';
        return (
          <li key={`${event.ts}-${index}`} className="py-2.5 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <Dot tone={tone} />
              {/* The stage in words, then the backend's own tag. The tag is the
                  raw label and stays visible — the stage is a reading of it, and
                  hiding the source would make that reading unverifiable. */}
              <span className="font-mono text-[10px] tracking-[0.12em] text-ink-300 uppercase">
                {phase.label}
              </span>
              <span className="font-mono text-[10px] text-ink-500">{event.tag}</span>
              {event.level !== 'info' && <Badge tone={tone}>{event.level}</Badge>}
              <span className="text-sm text-ink-300">{event.message}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink-500">
              <span>{formatDateTime(event.ts)}</span>
              {/* `truncate` clips what is drawn, but the element still reports its
                  full text as its minimum width, which propagates up and stretches
                  the panel. `min-w-0` lets it actually shrink; `basis-0 grow` gives
                  it the leftover row instead of its natural width. */}
              {event.data && (
                <span className="min-w-0 grow basis-0 truncate" title={JSON.stringify(event.data)}>
                  {JSON.stringify(event.data)}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Stage filter for the activity log. Only stages that actually occurred are
 * offered, so no chip ever leads to an empty view, and each carries its real
 * count.
 */
export function ActivityFilter({ data, value, onChange }) {
  const events = data?.events || [];
  const counts = phaseCounts(events);
  if (counts.size === 0) return null;

  return (
    <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by lifecycle stage">
      <Button variant="filter" active={!value} aria-pressed={!value} onClick={() => onChange(null)}>
        all <span className="autora-numeric">{formatNumber(events.length)}</span>
      </Button>
      {PHASE_ORDER.filter((phase) => counts.has(phase.key)).map((phase) => (
        <Button
          key={phase.key}
          variant="filter"
          active={value === phase.key}
          aria-pressed={value === phase.key}
          title={phase.blurb}
          onClick={() => onChange(value === phase.key ? null : phase.key)}
        >
          {phase.label} <span className="autora-numeric">{formatNumber(counts.get(phase.key))}</span>
        </Button>
      ))}
    </div>
  );
}
