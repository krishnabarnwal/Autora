import { useEffect, useMemo, useState } from 'react';
import { getActivity, getAgent, getFeed, getHealth, getMemory, listAgents } from './services/api.js';
import { usePolling } from './hooks/usePolling.js';
import { AsyncSection, Badge, Dot, Empty, ErrorNote, Loading, Metric, Panel, Row } from './components/ui.jsx';
import { PipelineFlow, PipelineLegend } from './components/PipelineFlow.jsx';
import { ActivityList, AgentCard, FeedList, MemoryList } from './components/panels.jsx';
import {
  classifyEvent,
  DECISION_TONE,
  formatClock,
  formatInterval,
  formatNumber,
  relativeTime,
} from './lib/format.js';

/**
 * Phase 14 — the operator dashboard.
 *
 * Every number on screen is read from the backend: /api/health, /api/agent,
 * /api/agent/:id, /api/agent/feed, /api/agent/:id/activity, and
 * /api/agent/:id/memory. Nothing is simulated, and the UI issues no write beyond
 * the init call the user explicitly triggers. Sections are client-side state
 * rather than routes, so no router dependency is needed.
 */

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'pipeline', label: 'Autonomous loop' },
  { id: 'feed', label: 'Published posts' },
  { id: 'decisions', label: 'AI decisions' },
  { id: 'memory', label: 'Local memory' },
  { id: 'breeth', label: 'Breeth memory' },
  { id: 'activity', label: 'Activity log' },
  { id: 'system', label: 'System health' },
];

const FAST_MS = 5000;
const SLOW_MS = 10_000;

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

  const events = activity.data?.events || [];
  const breethEvents = useMemo(() => events.filter((e) => classifyEvent(e) === 'breeth'), [events]);
  const rateLimited = useMemo(() => events.filter((e) => classifyEvent(e) === 'rate_limited'), [events]);

  const agent = detail.data?.agent || null;
  const breethEnabled = Boolean(health.data?.breethEnabled);

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
        }}
        agents={agentList}
        agentId={agentId}
        onSelectAgent={setAgentId}
        health={health}
      />

      <main className="min-w-0 flex-1 space-y-5">
        <DegradedBanners health={health} detail={detail.data} rateLimited={rateLimited} />

        <AgentCard detail={detail.data} loading={detail.loading && !detail.data} error={!agentId ? null : detail.error} />

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
            breethEvents={breethEvents}
            breethEnabled={breethEnabled}
          />
        )}

        {section === 'pipeline' && (
          <Panel
            title="Autonomous loop"
            subtitle="Live sources → discovery → filtering → dedup → candidates → editorial → generation → publishing → local memory → Breeth → next cycle"
            actions={<RefreshTag query={detail} />}
          >
            <PipelineFlow
              stats={agent?.stats}
              counts={detail.data?.counts}
              breethEnabled={breethEnabled}
              breethActivity={breethEvents.length}
            />
            <div className="mt-4">
              <PipelineLegend />
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
            subtitle="In-memory buffer — process-local, cleared on restart"
            actions={<RefreshTag query={activity} />}
          >
            <AsyncSection query={activity} loadingLabel="Loading activity…" empty="No activity data.">
              {(data) => <ActivityList data={data} />}
            </AsyncSection>
          </Panel>
        )}

        {section === 'system' && <SystemHealth health={health} agent={agent} rateLimited={rateLimited} />}
      </main>
    </div>
  );
}

function Sidebar({ section, onSelect, agents, agentId, onSelectAgent, health }) {
  const connected = Boolean(health.data?.ok);
  const tone = health.error ? 'bad' : connected ? 'good' : 'warn';

  return (
    <aside className="lg:w-60 lg:shrink-0">
      <div className="lg:sticky lg:top-6 space-y-4">
        <div>
          <p className="font-mono text-[10px] tracking-[0.2em] text-ink-500 uppercase">Problem Statement 3</p>
          <h1 className="mt-1 text-lg leading-tight font-semibold text-white">Autonomous AI Creator</h1>
          <div className="mt-2 flex items-center gap-2">
            <Dot tone={tone} pulse={connected} />
            <span className="font-mono text-[11px] text-ink-500">
              {health.error ? 'backend unreachable' : connected ? 'backend live' : 'connecting…'}
            </span>
          </div>
        </div>

        {agents.length > 1 && (
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.16em] text-ink-500 uppercase">Agent</span>
            <select
              value={agentId || ''}
              onChange={(event) => onSelectAgent(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 text-sm text-ink-300"
            >
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.persona?.name} — {a.status}
                </option>
              ))}
            </select>
          </label>
        )}

        <nav aria-label="Dashboard sections">
          <ul className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            {SECTIONS.map((item) => {
              const active = section === item.id;
              return (
                <li key={item.id} className="shrink-0 lg:shrink">
                  <button
                    type="button"
                    onClick={() => onSelect(item.id)}
                    aria-current={active ? 'page' : undefined}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap transition ${
                      active
                        ? 'border border-accent/40 bg-accent/10 text-white'
                        : 'border border-transparent text-ink-500 hover:bg-ink-900 hover:text-ink-300'
                    }`}
                  >
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </aside>
  );
}

function RefreshTag({ query }) {
  if (!query?.lastUpdated) return null;
  return (
    <span className="font-mono text-[11px] text-ink-500">
      {query.stale ? 'stale · ' : ''}
      updated {formatClock(query.lastUpdated.toISOString())}
    </span>
  );
}

function TotalsRow({ totals }) {
  if (!totals) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {['published', 'rejected', 'deferred'].map((key) => (
        <Badge key={key} tone={DECISION_TONE[key]}>
          {key}: {formatNumber(totals[key])}
        </Badge>
      ))}
    </div>
  );
}

function DegradedBanners({ health, detail, rateLimited }) {
  const notes = [];
  const agent = detail?.agent;

  if (health.error) {
    notes.push({
      tone: 'bad',
      text: 'The backend is unreachable. Every panel below shows the last successful read, if any.',
    });
  } else if (health.data && health.data.ok === false) {
    notes.push({
      tone: 'bad',
      text: `Backend reports not ready — database ${health.data.database?.status || 'unavailable'}.`,
    });
  }

  if (rateLimited.length > 0) {
    notes.push({
      tone: 'warn',
      text: `Provider rate limiting or quota pressure reported in ${rateLimited.length} recent event(s). The agent keeps cycling; generation may be skipped.`,
    });
  }

  if (agent?.status === 'error' && detail?.lastError?.message) {
    notes.push({
      tone: 'warn',
      text: `Last cycle failed: ${detail.lastError.message}${
        relativeTime(detail.lastError.at) ? ` (${relativeTime(detail.lastError.at)})` : ''
      }`,
    });
  }

  if (notes.length === 0) return null;

  return (
    <div className="space-y-2">
      {notes.map((note, index) => (
        <div
          key={index}
          role="alert"
          className={`flex items-start gap-2.5 rounded-lg border px-4 py-2.5 text-sm ${
            note.tone === 'bad'
              ? 'border-red-400/30 bg-red-400/5 text-red-400'
              : 'border-amber-400/30 bg-amber-400/5 text-amber-400'
          }`}
        >
          <Dot tone={note.tone} />
          <span>{note.text}</span>
        </div>
      ))}
    </div>
  );
}

function Overview({ detail, feed, memory, activity, breethEvents, breethEnabled }) {
  const agent = detail.data?.agent;
  const totals = memory.data?.totals;

  return (
    <div className="space-y-5">
      <Panel
        title="Autonomous loop"
        subtitle="Sources → discovery → filtering → dedup → candidates → editorial → generation → publishing → memory → Breeth → next cycle"
        actions={<RefreshTag query={detail} />}
      >
        <PipelineFlow
          stats={agent?.stats}
          counts={detail.data?.counts}
          breethEnabled={breethEnabled}
          breethActivity={breethEvents.length}
        />
      </Panel>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Latest activity" subtitle="Newest first" actions={<RefreshTag query={activity} />}>
          <AsyncSection query={activity} loadingLabel="Loading activity…" empty="No activity data.">
            {(data) => <ActivityList data={{ events: (data.events || []).slice(0, 8) }} />}
          </AsyncSection>
        </Panel>

        <Panel title="Latest posts" subtitle="GET /api/agent/feed" actions={<RefreshTag query={feed} />}>
          <AsyncSection query={feed} loadingLabel="Loading the feed…" empty="No feed data.">
            {(data) => <FeedList data={{ posts: (data.posts || []).slice(0, 4) }} />}
          </AsyncSection>
        </Panel>

        <Panel title="Latest decisions" subtitle="Local memory, MongoDB" actions={<RefreshTag query={memory} />}>
          <AsyncSection query={memory} loadingLabel="Loading memory…" empty="No memory data.">
            {(data) => (
              <>
                <TotalsRow totals={totals} />
                <MemoryList data={{ memory: (data.memory || []).slice(0, 6) }} />
              </>
            )}
          </AsyncSection>
        </Panel>

        <Panel title="Breeth strategic memory" subtitle="Optional, non-authoritative">
          <BreethSummary enabled={breethEnabled} events={breethEvents} />
        </Panel>
      </div>
    </div>
  );
}

function Decisions({ memory, filter, onFilter }) {
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
              <div className="mb-4 flex flex-wrap gap-1.5">
                {['all', 'published', 'rejected', 'deferred'].map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onFilter(key)}
                    className={`rounded-full border px-3 py-1 font-mono text-[11px] transition ${
                      filter === key
                        ? 'border-accent/50 bg-accent/10 text-white'
                        : 'border-ink-700 text-ink-500 hover:text-ink-300'
                    }`}
                  >
                    {key}
                    {key !== 'all' && data.totals ? ` (${formatNumber(data.totals[key])})` : ''}
                  </button>
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

function BreethSummary({ enabled, events }) {
  if (!enabled) {
    return (
      <div className="space-y-2.5">
        <Badge tone="muted">disabled</Badge>
        <p className="text-sm leading-relaxed text-ink-500">
          Breeth is an optional strategic-memory layer. It is switched off, and the agent runs
          exactly as it does with it on — MongoDB remains authoritative for duplicate prevention and
          repetition checks.
        </p>
      </div>
    );
  }

  const failures = events.filter((e) => e.level === 'warn' || e.level === 'error');
  const writes = events.filter((e) => e.level === 'info');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Badge tone="info">enabled</Badge>
        {failures.length > 0 && <Badge tone="warn">{failures.length} degraded event(s)</Badge>}
        {writes.length > 0 && <Badge tone="good">{writes.length} episode write(s)</Badge>}
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-ink-500">
          Enabled, but no Breeth event has been buffered yet this process. One episode is recorded
          per cycle at most.
        </p>
      ) : (
        <ActivityList data={{ events: events.slice(0, 5) }} />
      )}
      <p className="text-xs leading-relaxed text-ink-500">
        Non-authoritative by design: a Breeth outage is logged and ignored. It never fails a cycle,
        never blocks publishing, and never overrides a MongoDB decision.
      </p>
    </div>
  );
}

function BreethPanel({ enabled, events, query }) {
  return (
    <div className="space-y-5">
      <Panel
        title="Breeth strategic memory"
        subtitle="Optional layer — MongoDB stays authoritative"
        actions={<RefreshTag query={query} />}
      >
        <BreethSummary enabled={enabled} events={events} />
      </Panel>

      <Panel title="Boundary">
        <dl className="space-y-2.5">
          <Row label="Duplicate prevention" value="MongoDB" tone="good" />
          <Row label="Repetition checks" value="MongoDB" tone="good" />
          <Row label="Published-topic authority" value="MongoDB" tone="good" />
          <Row label="Audit history" value="MongoDB" tone="good" />
          <Row label="Breeth is authoritative for" value="nothing" tone="muted" />
          <Row
            label="Retrieval in the decision path"
            value={enabled ? 'implemented, not consulted' : 'not consulted'}
            tone="muted"
          />
        </dl>
      </Panel>
    </div>
  );
}

function SystemHealth({ health, agent, rateLimited }) {
  return (
    <div className="space-y-5">
      <Panel title="System health" subtitle="GET /api/health" actions={<RefreshTag query={health} />}>
        <AsyncSection
          query={health}
          loadingLabel="Checking the backend…"
          empty="No health data."
          errorHint="Start the backend with npm run dev inside server/."
        >
          {(data) => (
            <>
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="API" value={data.ok ? 'ready' : 'degraded'} tone={data.ok ? 'good' : 'bad'} />
                <Metric
                  label="Database"
                  value={data.database?.status || 'unknown'}
                  tone={data.database?.healthy ? 'good' : 'bad'}
                  hint={
                    data.database?.ping?.ok ? `ping ${data.database.ping.latencyMs}ms` : data.database?.ping?.error
                  }
                />
                <Metric label="Uptime" value={formatUptime(data.uptimeSeconds)} />
                <Metric
                  label="Rate-limit events"
                  value={rateLimited.length}
                  tone={rateLimited.length > 0 ? 'warn' : 'good'}
                  hint="in the current buffer"
                />
              </div>
              <dl className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
                <Row label="Environment" value={data.env} />
                <Row label="Agent mode" value={data.agentMode} />
                <Row label="Cycle interval" value={formatInterval(data.cycleIntervalMs)} />
                <Row label="LLM provider" value={data.llmProvider} />
                <Row label="LLM model" value={data.llmModel} />
                <Row
                  label="LLM key"
                  value={data.llmConfigured ? 'configured' : 'not set'}
                  tone={data.llmConfigured ? 'good' : 'warn'}
                />
                <Row
                  label="Database configured"
                  value={data.databaseConfigured ? 'yes' : 'no'}
                  tone={data.databaseConfigured ? 'good' : 'warn'}
                />
                <Row
                  label="Breeth"
                  value={data.breethEnabled ? 'enabled' : 'disabled'}
                  tone={data.breethEnabled ? 'info' : 'muted'}
                />
              </dl>
              <p className="mt-4 text-xs leading-relaxed text-ink-500">
                Health reports configuration flags only — booleans and provider names. No key, URI,
                or credential is ever sent to the browser.
              </p>
            </>
          )}
        </AsyncSection>
      </Panel>

      {agent && (
        <Panel title="Scheduler" subtitle="Read-only — this dashboard cannot pause or resume the agent">
          <dl className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
            <Row label="Status" value={agent.status} />
            <Row label="Cycles run" value={formatNumber(agent.stats?.cyclesRun)} />
            <Row label="Cycles failed" value={formatNumber(agent.stats?.cyclesFailed)} tone={agent.stats?.cyclesFailed > 0 ? 'warn' : 'plain'} />
            <Row label="Next cycle" value={relativeTime(agent.nextCycleAt) ?? '—'} />
          </dl>
        </Panel>
      )}
    </div>
  );
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
