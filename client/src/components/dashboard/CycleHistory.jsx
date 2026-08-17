/**
 * Historical execution summary — what the persistent cycle history adds up to.
 *
 * The panel this sits in already shows the loop as it is running now. This is the
 * same agent measured over the cycles it has already run, read from
 * GET /api/agent/:agentId/cycles, which survives the restarts that clear the
 * activity buffer.
 *
 * Three honesty rules the components below enforce rather than assume:
 *
 *   - Every figure is over the rows *loaded*, and the card says so. It is not the
 *     agent's lifetime total; history began when the history collection did, and
 *     the list is paginated.
 *   - A rate with no denominator, or an average with no samples, renders as
 *     "Not available" — never as 0%, and never as a dash that a reader could
 *     mistake for zero.
 *   - Nothing here is a trace. These rows carry counts and timings; the drawer
 *     labels them as a persistent record precisely so they cannot be read as a
 *     stage-by-stage account of a cycle.
 */

import { Button, Metric } from '../ui.jsx';
import {
  formatAverage,
  formatRate,
  NOT_AVAILABLE,
  statusMeta,
} from '../../lib/cycleAnalytics.js';
import { formatInterval, formatNumber, relativeTime } from '../../lib/format.js';

/** An average duration, or the honest absence — formatInterval's dash is not one. */
function durationLabel(ms) {
  return ms === null || !Number.isFinite(ms) ? NOT_AVAILABLE : formatInterval(ms);
}

/**
 * The five headline figures, plus the sample each was measured over.
 *
 * The hints are load-bearing: "over 11 of 14 cycles" is the difference between a
 * publish rate a reader can trust and one they cannot, and a card that showed the
 * percentage alone would be claiming a confidence the data does not support.
 */
export function HistorySummary({ summary, loading, error }) {
  if (error) {
    return (
      <p className="text-sm leading-relaxed text-amber-400">
        Execution history could not be loaded ({error.code || 'request failed'}). The
        cycles below are whatever the activity buffer and decision history still
        hold.
      </p>
    );
  }

  if (loading) {
    return <p className="font-mono text-xs text-ink-500">Loading execution history…</p>;
  }

  if (!summary || summary.total === 0) {
    return (
      <p className="text-sm leading-relaxed text-ink-500">
        No cycles have been recorded yet. A row is written when a cycle starts, so
        the first one appears as soon as the agent begins working.
      </p>
    );
  }

  const latest = summary.latest ? statusMeta(summary.latest.status) : null;
  const sampleOf = (n) => `over ${formatNumber(n)} of ${formatNumber(summary.total)} cycles`;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Metric
          label="Cycle success rate"
          value={formatRate(summary.successRate)}
          hint={summary.successSamples === 0 ? 'no cycle has finished yet' : sampleOf(summary.successSamples)}
          tone={summary.successRate !== null && summary.successRate < 0.5 ? 'warn' : 'good'}
        />
        <Metric
          label="Publish rate"
          value={formatRate(summary.publishRate)}
          hint={
            summary.publishSamples === 0
              ? 'no cycle has recorded an outcome yet'
              : `${sampleOf(summary.publishSamples)} with an outcome`
          }
        />
        <Metric
          label="Avg cycle duration"
          value={durationLabel(summary.avgDurationMs)}
          hint={summary.durationSamples === 0 ? 'no cycle has completed yet' : sampleOf(summary.durationSamples)}
        />
        <Metric
          label="LLM calls / cycle"
          value={formatAverage(summary.avgLlmCalls)}
          hint={summary.llmSamples === 0 ? 'no cycle recorded a call count' : sampleOf(summary.llmSamples)}
        />
        <Metric
          label="Provider failures"
          value={formatNumber(summary.providerFailures)}
          hint="cycles that hit a provider error, including absorbed rate limits"
          tone={summary.providerFailures > 0 ? 'warn' : 'plain'}
        />
        <Metric
          label="Cycles recorded"
          value={formatNumber(summary.total)}
          hint="rows loaded from persistent history, not the lifetime total"
        />
      </div>

      <p className="mt-3 text-xs leading-relaxed text-ink-500">
        {latest ? (
          <>
            Latest recorded cycle:{' '}
            <span className="font-mono text-ink-300">{latest.label.toLowerCase()}</span>
            {summary.latest.startedAt && <> · started {relativeTime(summary.latest.startedAt)}</>}.
          </>
        ) : (
          'No cycle in this window carries a usable start time.'
        )}
        {summary.interrupted > 0 && (
          <>
            {' '}
            <span className="text-amber-400">
              {formatNumber(summary.interrupted)}{' '}
              {summary.interrupted === 1 ? 'cycle was' : 'cycles were'} interrupted
            </span>{' '}
            by a restart before they could finish, so they have no outcome and are
            counted in neither rate.
          </>
        )}
        {summary.byStatus.running > 0 && (
          <> {formatNumber(summary.byStatus.running)} in flight right now.</>
        )}
      </p>
    </>
  );
}

/**
 * The control that reaches further back through persisted history.
 *
 * A single fetch per click, on demand — not a second polling loop. The live first
 * page keeps refreshing on the dashboard's existing cadence; older pages are
 * static once loaded, because a cycle that finished hours ago cannot change.
 *
 * Every state is spelled out: loading, the end of history, and a failed request
 * that says so instead of looking like an agent with no past.
 */
export function LoadOlderCycles({ hasMore, loading, error, onLoad, loaded }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {hasMore ? (
        <Button
          variant="filter"
          onClick={onLoad}
          disabled={loading}
          aria-busy={loading}
          className={loading ? 'cursor-progress opacity-60' : ''}
        >
          {loading ? 'loading…' : 'load older cycles'}
        </Button>
      ) : (
        <span className="font-mono text-[11px] text-ink-500">
          {loaded > 0 ? 'end of recorded history' : ''}
        </span>
      )}
      {error && (
        <span className="font-mono text-[11px] text-amber-400">
          could not load older cycles ({error.code || 'request failed'})
        </span>
      )}
    </div>
  );
}
