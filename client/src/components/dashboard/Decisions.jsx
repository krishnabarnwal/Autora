import { AsyncSection, Button, Empty, Panel, RefreshTag } from '../ui.jsx';
import { MemoryList } from '../panels.jsx';
import { formatNumber } from '../../lib/format.js';
import { DECISION_META } from '../../lib/decisions.js';

// These strings are the ?decision= query parameter, not display labels. 'all'
// is the absence of the parameter; the other three are TOPIC_DECISIONS on the
// server, which validates them against its own enum. Do not prettify them here.
const FILTERS = ['all', 'published', 'rejected', 'deferred'];

const OUTCOMES = ['published', 'rejected', 'deferred'];

/**
 * Every candidate the agent judged.
 *
 * The filter is a query parameter, not a view preference — see the note beside
 * the `decision` state in App. `onFilter` therefore changes what is fetched,
 * and the rows below are already the decision the user asked for.
 *
 * The legend exists because two of the three outcomes are decisions *not* to
 * publish, which is the point of the section: a rejection is the agent applying
 * an editorial standard, not a failure.
 */
export function Decisions({ memory, filter, onFilter }) {
  return (
    <Panel
      title="AI editorial decisions"
      subtitle="Every candidate the agent judged — published, rejected, or deferred"
      actions={<RefreshTag query={memory} />}
    >
      <AsyncSection query={memory} loadingLabel="Loading decisions…" empty="No decision data.">
        {(data) => {
          // The rows are already the decision the user asked for: the filter is
          // sent to /memory rather than applied here, so a decision with few
          // recent rows still shows them.
          const rows = data.memory || [];
          return (
            <>
              <div className="mb-4 grid gap-2 sm:grid-cols-3">
                {OUTCOMES.map((key) => (
                  <p
                    key={key}
                    className="rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2 text-[11px] leading-relaxed text-ink-500"
                  >
                    <span aria-hidden="true" className="mr-1.5 font-mono">
                      {DECISION_META[key].glyph}
                    </span>
                    <span className="text-ink-300">{DECISION_META[key].label}</span> —{' '}
                    {DECISION_META[key].statement}
                  </p>
                ))}
              </div>

              <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter by decision">
                {FILTERS.map((key) => (
                  <Button
                    key={key}
                    active={filter === key}
                    aria-pressed={filter === key}
                    onClick={() => onFilter(key)}
                  >
                    {key}
                    {key !== 'all' && data.totals ? ` (${formatNumber(data.totals[key])})` : ''}
                  </Button>
                ))}
              </div>
              {rows.length === 0 ? (
                <Empty
                  title={`No ${filter} decisions recorded yet.`}
                  hint="Totals above cover the agent's whole history; the list shows the most recent window."
                />
              ) : (
                <MemoryList data={{ memory: rows }} />
              )}
            </>
          );
        }}
      </AsyncSection>
    </Panel>
  );
}
