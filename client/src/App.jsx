import { useEffect, useMemo, useState } from 'react';
import { getActivity, getAgent, getCycles, getFeed, getHealth, getMemory, listAgents } from './services/api.js';
import { usePolling } from './hooks/usePolling.js';
import { AsyncSection, Empty, Panel, RefreshTag } from './components/ui.jsx';
import { PipelineFlow, PipelineLegend } from './components/PipelineFlow.jsx';
import { ActivityFilter, ActivityList, FeedList, MemoryList, TotalsRow } from './components/panels.jsx';
import { IdentityStrip } from './components/IdentityStrip.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { DegradedBanners } from './components/DegradedBanners.jsx';
import { Overview } from './components/dashboard/Overview.jsx';
import { Decisions } from './components/dashboard/Decisions.jsx';
import { BreethPanel } from './components/dashboard/BreethPanel.jsx';
import { SystemHealth } from './components/dashboard/SystemHealth.jsx';
import { CycleDrawer, CycleList } from './components/dashboard/CycleDetail.jsx';
import { HistorySummary, LoadOlderCycles } from './components/dashboard/CycleHistory.jsx';
import { classifyEvent, formatNumber } from './lib/format.js';
import { isProviderFailure } from './lib/health.js';
import { buildCycles, findCycle } from './lib/cycles.js';
import { summarizeCycleRuns } from './lib/cycleAnalytics.js';
import { PIPELINE_SUBTITLE } from './lib/vocabulary.js';

/**
 * The operator dashboard.
 *
 * Every number on screen is read from the backend: /api/health, /api/agent,
 * /api/agent/:id, /api/agent/feed, /api/agent/:id/activity,
 * /api/agent/:id/memory, and /api/agent/:id/cycles. Nothing is simulated, and the
 * UI issues no write beyond the init call the user explicitly triggers. Sections
 * are client-side state rather than routes, so no router dependency is needed.
 *
 * This file owns the data: the polled queries, the selected agent, and which
 * section is showing. Each section renders itself from components/dashboard/.
 */

const FAST_MS = 5000;
const SLOW_MS = 10_000;

/** Cycle history rows per page — the endpoint's own default, kept explicit here. */
const HISTORY_PAGE = 20;

export default function App() {
  const [section, setSection] = useState('overview');
  const [agentId, setAgentId] = useState(null);
  // The decision filter lives here, not in <Decisions>, because it is a query
  // parameter rather than a view preference: /memory returns a bounded recent
  // window, so filtering the fetched page client-side would show "no published
  // decisions" whenever the newest rows happen to all be deferred. Asking the
  // endpoint for the decision it should return is the only filter that agrees
  // with the totals rendered beside it.
  const [decision, setDecision] = useState('all');
  // Which lifecycle stage the activity log is filtered to, or null for all. Held
  // here for the same reason as `decision`: it is cleared on the way out of the
  // section so the Overview's activity preview is never a filtered subset.
  const [phase, setPhase] = useState(null);
  // Which cycle the detail drawer is showing, by cycleId, or null for none.
  // Holding the id rather than the built cycle means each poll re-renders the
  // drawer from fresh data instead of pinning a snapshot taken when it opened.
  const [cycleId, setCycleId] = useState(null);
  // Pages of cycle history fetched on demand, beyond the polled first page.
  //
  // These are deliberately not polled. The first page keeps refreshing with the
  // rest of the dashboard because its newest row can still be running; a cycle
  // that finished hours ago cannot change, so re-fetching page four every ten
  // seconds would spend requests to receive identical bytes. `agent` is carried
  // in the state so a page that arrives after the operator has switched agents
  // can be dropped instead of appended to the wrong history.
  const [older, setOlder] = useState({
    agent: null,
    rows: [],
    pages: 0,
    cursor: null,
    hasMore: false,
    loading: false,
    error: null,
  });

  const health = usePolling(() => getHealth(), { intervalMs: SLOW_MS });
  const agents = usePolling(() => listAgents({ limit: 25 }), { intervalMs: SLOW_MS });

  // Default to the newest agent once the list arrives, without overriding a
  // selection the user has already made.
  const agentList = agents.data?.agents || [];
  useEffect(() => {
    if (!agentId && agentList.length > 0) setAgentId(agentList[0].agentId);
  }, [agentId, agentList]);

  const enabled = Boolean(agentId);
  const deps = [agentId];

  const detail = usePolling(() => getAgent(agentId), { intervalMs: FAST_MS, enabled, deps });
  const feed = usePolling(() => getFeed(agentId, { limit: 50 }), { intervalMs: SLOW_MS, enabled, deps });
  const memory = usePolling(
    () => getMemory(agentId, { limit: 60, decision: decision === 'all' ? undefined : decision }),
    { intervalMs: SLOW_MS, enabled, deps: [agentId, decision] }
  );
  const activity = usePolling(() => getActivity(agentId, { limit: 150, scope: 'all' }), {
    intervalMs: FAST_MS,
    enabled,
    deps,
  });
  // The newest page of persistent history. One more polled query on the existing
  // hook — not a second polling loop — so it pauses with the tab and refreshes on
  // the same cadence as everything else.
  const history = usePolling(() => getCycles(agentId, { limit: HISTORY_PAGE }), {
    intervalMs: SLOW_MS,
    enabled,
    deps,
  });

  // Switching agents discards the pages fetched for the previous one. Recording
  // the new agent here is what lets an in-flight request identify itself as stale.
  useEffect(() => {
    setOlder({
      agent: agentId,
      rows: [],
      pages: 0,
      cursor: null,
      hasMore: false,
      loading: false,
      error: null,
    });
  }, [agentId]);

  const historyPage = history.data?.pagination ?? null;
  // Before any manual page has loaded the cursor comes from the polled page;
  // afterwards it comes from the last page fetched. `pages` is the discriminator
  // rather than the cursor itself, because reaching the end of history sets the
  // cursor to null and falling back to the first page's cursor there would offer
  // to load the same page again forever.
  const olderCursor = older.pages > 0 ? older.cursor : (historyPage?.nextCursor ?? null);
  const hasOlder = Boolean(olderCursor) && (older.pages > 0 ? older.hasMore : Boolean(historyPage?.hasMore));

  async function loadOlder() {
    if (!agentId || !olderCursor || older.loading) return;
    const forAgent = agentId;
    setOlder((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const page = await getCycles(forAgent, { limit: HISTORY_PAGE, before: olderCursor });
      setOlder((prev) =>
        prev.agent !== forAgent
          ? prev
          : {
              ...prev,
              rows: [...prev.rows, ...(page?.data || [])],
              pages: prev.pages + 1,
              cursor: page?.pagination?.nextCursor ?? null,
              hasMore: Boolean(page?.pagination?.hasMore),
              loading: false,
              error: null,
            }
      );
    } catch (error) {
      // A failed page leaves the cursor untouched so the same click can be
      // retried, and says so rather than looking like the end of history.
      setOlder((prev) => (prev.agent !== forAgent ? prev : { ...prev, loading: false, error }));
    }
  }

  const events = activity.data?.events || [];
  const breethEvents = useMemo(() => events.filter((e) => classifyEvent(e) === 'breeth'), [events]);
  const rateLimited = useMemo(() => events.filter((e) => classifyEvent(e) === 'rate_limited'), [events]);
  // Provider failures that are not rate limits — a timeout, a schema violation, a
  // blocked completion. Counted separately so a 429 is never folded into a
  // generic "error" total and quietly lose its identity.
  const providerErrors = useMemo(
    () => events.filter((e) => isProviderFailure(e) && classifyEvent(e) !== 'rate_limited'),
    [events]
  );

  const agent = detail.data?.agent || null;
  const breethEnabled = Boolean(health.data?.breethEnabled);

  // The polled first page plus every page loaded since, newest first.
  //
  // Deduplicated by cycleId because the two sources can in principle name the
  // same execution: the cursor is exclusive so an older page cannot repeat a row
  // that was on page one when it was requested, but page one keeps refreshing,
  // and a row is only ever more trustworthy on the fresher read. First occurrence
  // wins for that reason. A row with no cycleId is kept — it cannot be joined to
  // a traced cycle, but it is still a real execution and belongs in the totals.
  const runs = useMemo(() => {
    const merged = [];
    const seen = new Set();
    for (const row of [...(history.data?.data || []), ...older.rows]) {
      if (!row) continue;
      if (row.cycleId) {
        if (seen.has(row.cycleId)) continue;
        seen.add(row.cycleId);
      }
      merged.push(row);
    }
    return merged;
  }, [history.data, older.rows]);

  const historySummary = useMemo(() => summarizeCycleRuns(runs), [runs]);

  // Cycles are derived, not fetched: lib/cycles.js reads the four responses
  // already polled above and joins them on cycleId. Recomputed only when one of
  // those actually changes.
  //
  // Three tiers land in one list. A cycle still in the activity buffer gets a
  // full trace; one that has aged out of the buffer but wrote a durable row gets
  // counts and timings; one that only left a decision behind gets that. The
  // drawer labels which it is looking at, so an aggregate is never presented as
  // a trace.
  //
  // The memory rows are the same ones the Decisions section fetches, and that
  // query carries its decision filter. Leaving that section resets the filter to
  // 'all' (see onSelect below), so the rows backing this list are the unfiltered
  // window whenever the list is on screen. Were that reset removed, this list
  // would silently lose every cycle whose decision the user had filtered out.
  const cycles = useMemo(
    () => buildCycles({ events, memory: memory.data?.memory, posts: feed.data?.posts, runs }),
    [events, memory.data, feed.data, runs]
  );
  const selectedCycle = findCycle(cycles, cycleId);

  return (
    <div className="mx-auto flex min-h-full max-w-[1400px] flex-col gap-5 px-4 py-6 lg:flex-row lg:px-6">
      <Sidebar
        section={section}
        onSelect={(id) => {
          setSection(id);
          // The decision filter belongs to the Decisions section, which is the
          // only place the chips are visible. Clearing it on the way out keeps
          // the panels that share this query — Local memory, and Overview's
          // latest-decisions list — from silently showing a filtered subset.
          if (id !== 'decisions') setDecision('all');
          if (id !== 'activity') setPhase(null);
          // The drawer is opened from two sections — Overview's recent-runs list
          // and the Autonomous loop's full list. Leaving both of them closes it,
          // rather than having it reappear over a section that never opened it.
          if (id !== 'pipeline' && id !== 'overview') setCycleId(null);
        }}
        agents={agentList}
        agentId={agentId}
        onSelectAgent={setAgentId}
        health={health}
      />

      <main className="min-w-0 flex-1 space-y-5">
        <DegradedBanners health={health} detail={detail.data} rateLimited={rateLimited} />

        {/* The Overview leads with the Hero, its own full identity surface, so the
            strip would only duplicate it there. Every other section gets the slim
            strip: product first, agent as a subordinate identifier, live status. */}
        {section !== 'overview' && (
          <IdentityStrip agent={agent} health={health} events={events} detail={detail} />
        )}
        {!agentId && !agents.loading && agentList.length === 0 && (
          <Panel title="No agent yet">
            <Empty
              title="No agent has been initialized."
              hint="Start one with POST /api/agent/init and it begins its own cycles. This dashboard only reads; it never prompts the agent."
            />
          </Panel>
        )}

        {section === 'overview' && (
          <Overview
            detail={detail}
            feed={feed}
            memory={memory}
            activity={activity}
            events={events}
            cycles={cycles}
            selectedCycleId={cycleId}
            onSelectCycle={setCycleId}
            historySummary={historySummary}
            history={history}
            breethEvents={breethEvents}
            breethEnabled={breethEnabled}
            health={health}
          />
        )}

        {section === 'pipeline' && (
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
              events={events}
              status={agent?.status}
              stale={activity.stale}
            />
            <div className="mt-4">
              <PipelineLegend />
            </div>

            {/*
              The loop above is the agent's cadence in aggregate; this is each
              individual pass through it. Selecting one opens the detail drawer,
              which is where a reader can see what that specific cycle discovered,
              decided, published and remembered.
            */}
            <div className="mt-5 border-t border-ink-800 pt-4">
              <h3 className="font-mono text-[11px] tracking-[0.18em] text-ink-500 uppercase">
                Historical execution summary
              </h3>
              <p className="mt-1 mb-3 text-xs leading-relaxed text-ink-500">
                Aggregated from the durable row each cycle writes — this outlives the
                restarts that clear the activity buffer.
              </p>
              <HistorySummary
                summary={historySummary}
                loading={history.loading && !history.data}
                error={history.data ? null : history.error}
              />
            </div>

            <div className="mt-5 border-t border-ink-800 pt-4">
              <h3 className="font-mono text-[11px] tracking-[0.18em] text-ink-500 uppercase">
                Recent cycles
              </h3>
              <p className="mt-1 mb-3 text-xs leading-relaxed text-ink-500">
                Select a cycle to inspect its stages, decision and output.
                {agent?.stats?.cyclesRun !== undefined && (
                  <>
                    {' '}
                    This agent has run{' '}
                    <span className="autora-numeric text-ink-300">
                      {formatNumber(agent.stats.cyclesRun)}
                    </span>{' '}
                    cycles in total. The most recent are traced in full; older ones are
                    the persisted record of the execution, without the trace.
                  </>
                )}
              </p>
              <CycleList cycles={cycles} selectedId={cycleId} onSelect={setCycleId} />
              <LoadOlderCycles
                hasMore={hasOlder}
                loading={older.loading}
                error={older.error}
                onLoad={loadOlder}
                loaded={runs.length}
              />
            </div>
          </Panel>
        )}

        {section === 'feed' && (
          <Panel title="Published posts" subtitle="GET /api/agent/feed" actions={<RefreshTag query={feed} />}>
            <AsyncSection query={feed} loadingLabel="Loading the feed…" empty="No feed data.">
              {(data) => <FeedList data={data} />}
            </AsyncSection>
          </Panel>
        )}

        {section === 'decisions' && (
          <Decisions memory={memory} filter={decision} onFilter={setDecision} />
        )}

        {section === 'memory' && (
          <Panel
            title="Local memory (MongoDB)"
            subtitle="Authoritative for duplicate prevention and repetition checks"
            actions={<RefreshTag query={memory} />}
          >
            <AsyncSection query={memory} loadingLabel="Loading memory…" empty="No memory data.">
              {(data) => (
                <>
                  <TotalsRow totals={data.totals} />
                  <MemoryList data={data} />
                </>
              )}
            </AsyncSection>
          </Panel>
        )}

        {section === 'breeth' && (
          <BreethPanel enabled={breethEnabled} events={breethEvents} query={activity} />
        )}

        {section === 'activity' && (
          <Panel
            title="Autonomous activity"
            subtitle="Every lifecycle event the agent logged — in-memory buffer, process-local, cleared on restart"
            actions={<RefreshTag query={activity} />}
          >
            <AsyncSection query={activity} loadingLabel="Loading activity…" empty="No activity data.">
              {(data) => (
                <>
                  <ActivityFilter data={data} value={phase} onChange={setPhase} />
                  <ActivityList data={data} filter={phase} />
                </>
              )}
            </AsyncSection>
          </Panel>
        )}

        {section === 'system' && (
          <SystemHealth
            health={health}
            agent={agent}
            lastError={detail.data?.lastError}
            events={events}
            rateLimited={rateLimited}
            providerErrors={providerErrors}
          />
        )}
      </main>

      {/* Rendered outside <main> because it is a modal layer over the whole
          dashboard, not a part of the section that opened it. */}
      <CycleDrawer cycle={selectedCycle} onClose={() => setCycleId(null)} />
    </div>
  );
}
