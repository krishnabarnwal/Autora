import { AsyncSection, Panel, RefreshTag } from '../ui.jsx';
import { PipelineFlow } from '../PipelineFlow.jsx';
import { ActivityList, FeedList, MemoryList, TotalsRow } from '../panels.jsx';
import { BreethSummary } from './BreethPanel.jsx';
import { HistorySummary } from './CycleHistory.jsx';
import { CycleList } from './CycleDetail.jsx';
import { Hero } from '../Hero.jsx';
import { LOOP_STEPS, LOOP_TAGLINE, PIPELINE_SUBTITLE, PRODUCT_NAME } from '../../lib/vocabulary.js';

/** How many recent runs the Overview previews; the full list lives in Autonomous loop. */
const RECENT_RUNS = 5;

/**
 * A visitor should read this one line and understand what Autora is. Kept short
 * on purpose: the loop row beneath it carries the detail, and the live pipeline
 * below proves it.
 */
function HowItWorks() {
  return (
    <Panel title={`How ${PRODUCT_NAME} works`} subtitle="A closed loop, run on its own schedule">
      <p className="max-w-2xl text-sm leading-relaxed text-ink-300">
        {PRODUCT_NAME} is an autonomous agent, not a chatbot. On its own timer it discovers
        what is new in its domain, decides whether any of it is worth writing about, creates
        and publishes a post when it is, remembers what it did so it never repeats itself, and
        reflects before sleeping until the next cycle. {LOOP_TAGLINE}
      </p>

      <ol className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2">
        {LOOP_STEPS.map((step, index) => (
          <li key={step} className="flex items-center gap-2">
            <span className="rounded-md border border-ink-700 bg-ink-950/50 px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] text-ink-300">
              {step}
            </span>
            {index < LOOP_STEPS.length - 1 && (
              <span aria-hidden="true" className="font-mono text-xs text-ink-500">
                →
              </span>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/**
 * The landing section, and the one a recruiter reads first. It is ordered to
 * answer, top to bottom: what is Autora, is it autonomous, is it reliable, and
 * what has it actually done.
 *
 *   Hero            — the name, whether it is running now, and the lifetime counters.
 *   How it works    — the loop in one paragraph, for someone who has never seen it.
 *   Autonomous loop — the same loop, live, stage by stage.
 *   Historical performance / Recent runs — the durable record that it works, and
 *                     the last few cycles, each opening the same detail drawer the
 *                     Autonomous loop section uses.
 *   The four live surfaces — activity, feed, decisions, strategic memory — each
 *                     truncated to the newest rows and reading the same polled
 *                     query its dedicated section does, so the short list and the
 *                     full list can never disagree.
 *
 * The hero reads `health` and `events` alongside `detail` because "is the agent
 * running" is a different question from "can we reach the backend": productStatus
 * needs all three to tell Online from Degraded from Offline.
 */
export function Overview({
  detail,
  feed,
  memory,
  activity,
  events,
  cycles,
  selectedCycleId,
  onSelectCycle,
  historySummary,
  history,
  breethEvents,
  breethEnabled,
  health,
}) {
  const agent = detail.data?.agent;
  const totals = memory.data?.totals;
  const recentRuns = (cycles || []).slice(0, RECENT_RUNS);

  return (
    <div className="space-y-5">
      <Hero agent={agent} health={health} counts={detail.data?.counts} events={events} />

      <HowItWorks />

      <Panel
        title="Autonomous loop"
        subtitle={PIPELINE_SUBTITLE}
        actions={<RefreshTag query={detail} />}
      >
        <PipelineFlow
          stats={agent?.stats}
          counts={detail.data?.counts}
          breethEnabled={breethEnabled}
          breethActivity={breethEvents.length}
          events={activity.data?.events || []}
          status={agent?.status}
          // Stage recency is read from the activity log, so it is that query's
          // freshness that decides whether the highlight is still a claim about
          // now. Reuses the existing poll state — no second timer.
          stale={activity.stale}
        />
      </Panel>

      <Panel
        title="Historical performance"
        subtitle="Measured over the durable record, which outlives restarts"
        actions={<RefreshTag query={history} />}
      >
        <HistorySummary
          summary={historySummary}
          loading={history.loading && !history.data}
          error={history.data ? null : history.error}
        />
      </Panel>

      <Panel title="Recent autonomous runs" subtitle="Select a cycle to inspect its stages, decision and output">
        <CycleList cycles={recentRuns} selectedId={selectedCycleId} onSelect={onSelectCycle} />
        {cycles && cycles.length > RECENT_RUNS && (
          <p className="mt-3 text-xs leading-relaxed text-ink-500">
            Showing the {RECENT_RUNS} most recent. The full history, with older cycles, is under{' '}
            <span className="text-ink-300">Autonomous loop</span>.
          </p>
        )}
      </Panel>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Latest activity" subtitle="Newest first" actions={<RefreshTag query={activity} />}>
          <AsyncSection query={activity} loadingLabel="Loading activity…" empty="No activity data.">
            {(data) => <ActivityList data={{ events: (data.events || []).slice(0, 8) }} />}
          </AsyncSection>
        </Panel>

        <Panel title="Latest posts" subtitle="Most recent published output" actions={<RefreshTag query={feed} />}>
          <AsyncSection query={feed} loadingLabel="Loading the feed…" empty="No feed data.">
            {(data) => <FeedList data={{ posts: (data.posts || []).slice(0, 4) }} />}
          </AsyncSection>
        </Panel>

        <Panel title="Latest decisions" subtitle="What the agent chose to publish or skip" actions={<RefreshTag query={memory} />}>
          <AsyncSection query={memory} loadingLabel="Loading memory…" empty="No memory data.">
            {(data) => (
              <>
                <TotalsRow totals={totals} />
                <MemoryList data={{ memory: (data.memory || []).slice(0, 6) }} />
              </>
            )}
          </AsyncSection>
        </Panel>

        <Panel title="Strategic memory" subtitle="Optional, non-authoritative">
          <BreethSummary enabled={breethEnabled} events={breethEvents} />
        </Panel>
      </div>
    </div>
  );
}
