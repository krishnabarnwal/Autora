import { Badge, Dot, ErrorNote, Metric } from './ui.jsx';
import {
  DECISION_TONE,
  formatDateTime,
  formatInterval,
  hostOf,
  LEVEL_TONE,
  relativeTime,
  STATUS_TONE,
} from '../lib/format.js';

export function AgentCard({ detail, loading, error }) {
  if (loading) {
    return (
      <div className="rounded-xl border border-ink-700 bg-ink-900/60 px-5 py-4 text-sm text-ink-500">
        Loading agent state…
      </div>
    );
  }
  if (error) {
    return <ErrorNote error={error} hint="The detail endpoint could not be read. Showing no agent state." />;
  }
  if (!detail?.agent) {
    return (
      <div className="rounded-xl border border-ink-700 bg-ink-900/60 px-5 py-4 text-sm text-ink-500">
        No agent has been initialized yet.
      </div>
    );
  }

  const agent = detail.agent;
  const statusTone = STATUS_TONE[agent.status] || 'muted';
  const now = Date.now();
  const nextAt = relativeTime(agent.nextCycleAt, now);
  const lastAt = relativeTime(agent.lastCycleAt, now);

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/60 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <Dot tone={statusTone} pulse={agent.status === 'autonomous'} />
            <h1 className="truncate text-lg font-semibold text-white">{agent.persona?.name || 'Unnamed agent'}</h1>
            <Badge tone={statusTone}>{agent.status}</Badge>
            {agent.mode && <Badge tone="muted">mode: {agent.mode}</Badge>}
          </div>
          <p className="mt-1 truncate text-sm text-ink-500">
            {agent.persona?.domain || 'No domain'} · <span className="font-mono">{agent.agentId}</span>
          </p>
        </div>
        <div className="flex items-center gap-4 font-mono text-xs text-ink-500">
          <span>
            cycle every <span className="text-ink-300">{formatInterval(agent.cycleIntervalMs)}</span>
          </span>
          <span>
            next <span className={nextAt ? 'text-accent' : ''}>{nextAt ?? '—'}</span>
          </span>
          <span>
            last <span className="text-ink-300">{lastAt ?? 'never'}</span>
          </span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        <Metric label="Cycles run" value={agent.stats?.cyclesRun ?? '—'} />
        <Metric label="Topics discovered" value={agent.stats?.topicsDiscovered ?? '—'} />
        <Metric label="Posts published" value={agent.stats?.postsPublished ?? '—'} />
        <Metric label="LLM calls" value={agent.stats?.llmCalls ?? '—'} />
        <Metric label="Posts on disk" value={detail.counts?.posts ?? '—'} hint="feed rows" />
        <Metric label="Memory rows" value={detail.counts?.memories ?? '—'} hint="decisions recorded" />
      </div>
    </div>
  );
}

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
    <ul className="divide-y divide-ink-800">
      {posts.map((post) => (
        <li key={post.id} className="py-3.5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Dot tone="good" />
            <span className="text-sm font-medium text-ink-300">{post.text}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
            <span className="font-mono">{formatDateTime(post.createdAt)}</span>
            <span className="font-mono">{post.id}</span>
            {post.rationale && <span className="max-w-prose italic">“{post.rationale}”</span>}
          </div>
          {post.sources?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {post.sources.map((source) => (
                <a
                  key={source}
                  href={source}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-ink-700 px-2 py-0.5 font-mono text-[11px] text-ink-500 hover:border-accent hover:text-accent"
                >
                  {hostOf(source)}
                </a>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

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
    <ul className="divide-y divide-ink-800">
      {rows.map((row, index) => (
        <li key={`${row.normalizedTopic}-${row.createdAt}-${index}`} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={DECISION_TONE[row.decision] || 'muted'}>{row.decision}</Badge>
            {row.score !== null && row.score !== undefined && (
              <span className="font-mono text-xs text-ink-300">score {row.score}</span>
            )}
            <span className="text-sm text-ink-300">{row.topic}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-500">
            <span>{formatDateTime(row.createdAt)}</span>
            {row.rejectionCategory && <span className="text-amber-400">{row.rejectionCategory}</span>}
            {row.postId && <span>{row.postId}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ActivityList({ data }) {
  const events = data?.events || [];
  if (events.length === 0) {
    return (
      <p className="py-2 text-sm text-ink-500">
        No activity buffered yet — events appear here as cycles run. The buffer is
        process-local and clears on restart.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-ink-800">
      {events.map((event, index) => (
        <li key={`${event.ts}-${index}`} className="py-2.5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Dot tone={LEVEL_TONE[event.level] || 'muted'} />
            <span className="font-mono text-[10px] text-ink-500">{event.tag}</span>
            <span className="text-sm text-ink-300">{event.message}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink-500">
            <span>{formatDateTime(event.ts)}</span>
            {event.data && <span className="truncate">{JSON.stringify(event.data)}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
