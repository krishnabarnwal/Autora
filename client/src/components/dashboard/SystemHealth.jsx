import { AsyncSection, Badge, Dot, Metric, Panel, RefreshTag, Row } from '../ui.jsx';
import { formatClock, formatInterval, formatNumber, relativeTime } from '../../lib/format.js';
import { deriveSubsystems, worstOf } from '../../lib/health.js';
import { TONE_TEXT } from '../../lib/tones.js';
import { useNow, countdownTo } from '../../hooks/useNow.js';

/** Coarse uptime — the dashboard never needs second precision above a minute. */
function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * One subsystem's verdict: the name, the state in words, and the sentence
 * explaining it. Colour is never the only carrier — the label says "Degraded"
 * whether or not amber renders.
 */
function SubsystemRow({ item }) {
  return (
    <li className="autora-rise flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-ink-800 py-2.5 last:border-0">
      <span className="flex items-center gap-2">
        <Dot tone={item.tone} pulse={item.state === 'healthy'} />
        <span className="text-sm text-white">{item.name}</span>
      </span>
      <Badge tone={item.tone}>{item.label}</Badge>
      <span className="font-mono text-[10px] text-ink-500">{item.source}</span>
      <span className="w-full text-xs leading-relaxed text-ink-500 sm:w-auto sm:flex-1 sm:text-right">
        {item.detail}
        {item.hint && <span className="block text-ink-500 sm:inline sm:before:content-['_·_']">{item.hint}</span>}
        {item.since && (
          <span className="block font-mono text-[10px] text-ink-500 sm:inline sm:before:content-['_·_']">
            {relativeTime(item.since) ?? formatClock(item.since)}
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * The autonomous loop's own vital signs.
 *
 * Five figures the request names — last cycle, next cycle, cadence, consecutive
 * failures, total cycles — plus the verdict that says which of Healthy, Degraded,
 * Error or Paused the loop is in. Four of the five come from the Agent document.
 * The failure streak does not: the worker keeps that counter in process memory
 * and folds no copy into MongoDB, so the only place it is observable is the
 * scheduler's own 'Cycle complete' event, which logs it. When that event has
 * rolled out of the 300-entry buffer — or the process restarted — the row says
 * "not in buffer" rather than reporting a clean streak nobody measured.
 */
function SchedulerPanel({ agent, lastError, verdict }) {
  // The countdown ticks locally at 1 Hz toward the timestamp the backend gave
  // us; the timer is only installed when there is actually a next cycle.
  const now = useNow(Boolean(agent?.nextCycleAt));
  const countdown = countdownTo(agent?.nextCycleAt, now);
  const streak = verdict.streak;
  const failed = agent?.stats?.cyclesFailed ?? 0;

  return (
    <Panel
      title="Autonomous scheduler"
      subtitle="Read-only — this dashboard cannot pause, resume, or trigger the agent"
      actions={
        <span className="inline-flex items-center gap-2">
          <Dot tone={verdict.tone} pulse={verdict.state === 'healthy'} />
          <Badge tone={verdict.tone}>{verdict.label}</Badge>
        </span>
      }
    >
      <p className={`mb-4 text-sm leading-relaxed ${TONE_TEXT[verdict.tone]}`}>
        {verdict.detail}
        {verdict.hint && <span className="mt-0.5 block text-xs text-ink-500">{verdict.hint}</span>}
      </p>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Metric
          label="Last cycle"
          value={relativeTime(agent?.lastCycleAt) ?? 'never'}
          hint={agent?.lastCycleAt ? formatClock(agent.lastCycleAt) : 'no cycle has completed'}
        />
        <Metric
          label="Next cycle"
          value={countdown ? `${countdown.hours}:${countdown.minutes}:${countdown.seconds}` : '—'}
          tone={countdown?.overdue ? 'warn' : 'plain'}
          hint={
            !countdown
              ? 'no next cycle scheduled'
              : countdown.overdue
                ? 'due now — a cycle may be running'
                : formatClock(agent.nextCycleAt)
          }
        />
        <Metric
          label="Configured cadence"
          value={formatInterval(agent?.cycleIntervalMs)}
          hint="target interval between cycles"
        />
        <Metric
          label="Consecutive failures"
          value={streak ? formatNumber(streak.value) : '—'}
          tone={streak?.value > 0 ? 'warn' : 'plain'}
          hint={streak ? `as of ${formatClock(streak.at)}` : 'not in buffer'}
        />
        <Metric label="Total cycles" value={formatNumber(agent?.stats?.cyclesRun)} hint="run since init" />
        <Metric
          label="Failed cycles"
          value={formatNumber(failed)}
          tone={failed > 0 ? 'warn' : 'plain'}
          hint="lifetime total"
        />
      </div>

      <dl className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
        <Row label="Agent status" value={agent?.status ?? '—'} tone={verdict.tone} />
        <Row label="Mode" value={agent?.mode ?? '—'} />
        <Row
          label="Backoff on failure"
          value="exponential, reset on success"
          tone={verdict.state === 'degraded' || verdict.state === 'error' ? 'warn' : 'muted'}
        />
        <Row
          label="Last recorded error"
          value={lastError?.message ?? 'none'}
          tone={lastError ? 'warn' : 'muted'}
        />
      </dl>

      {lastError?.at && (
        <p className="mt-3 font-mono text-[11px] text-ink-500">
          Recorded {relativeTime(lastError.at) ?? formatClock(lastError.at)} · this is the last failure
          written to MongoDB, not necessarily the current state.
        </p>
      )}
    </Panel>
  );
}

/**
 * Provider reliability. The counts are of what is in the buffer right now, and
 * the panel says so — a 429 from before the last restart is not hidden, it is
 * simply not something this process can still see.
 */
function ProviderPanel({ health, verdict, rateLimited, providerErrors, llmCalls }) {
  const data = health?.data;
  return (
    <Panel
      title="LLM provider"
      subtitle="Rate limits and provider errors, as the backend logged them"
      actions={
        <span className="inline-flex items-center gap-2">
          <Dot tone={verdict.tone} pulse={verdict.state === 'healthy'} />
          <Badge tone={verdict.tone}>{verdict.label}</Badge>
        </span>
      }
    >
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Metric
          label="Rate-limit events"
          value={formatNumber(rateLimited.length)}
          tone={rateLimited.length > 0 ? 'warn' : 'good'}
          hint="in the current buffer"
        />
        <Metric
          label="Provider errors"
          value={formatNumber(providerErrors.length)}
          tone={providerErrors.length > 0 ? 'warn' : 'good'}
          hint="failed calls, in buffer"
        />
        <Metric
          label="LLM calls"
          value={formatNumber(llmCalls)}
          hint="lifetime, from the agent stats"
        />
      </div>
      <dl className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
        <Row label="Provider" value={data?.llmProvider ?? '—'} />
        <Row label="Model" value={data?.llmModel ?? '—'} />
        <Row
          label="API key"
          value={data?.llmConfigured ? 'configured' : 'not set'}
          tone={data?.llmConfigured ? 'good' : 'warn'}
        />
        <Row label="Retry policy" value="retry with backoff, then skip the cycle" tone="muted" />
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-ink-500">
        A rate limit is never suppressed here. Retries and backoff are the backend's; this panel only
        reports what they produced. Counts describe the in-memory activity buffer, which is
        process-local and clears on restart.
      </p>
    </Panel>
  );
}

export function SystemHealth({ health, agent, lastError, events, rateLimited, providerErrors }) {
  const subsystems = deriveSubsystems({ health, agent, lastError, events });
  const worst = worstOf(subsystems);
  const scheduler = subsystems.find((item) => item.key === 'scheduler');
  const provider = subsystems.find((item) => item.key === 'provider');

  return (
    <div className="space-y-5">
      <Panel
        title="System health"
        subtitle="Every subsystem the autonomous loop depends on"
        actions={<RefreshTag query={health} />}
      >
        <AsyncSection
          query={health}
          loadingLabel="Checking the backend…"
          empty="No health data."
          errorHint="Start the backend with npm run dev inside server/."
        >
          {(data) => (
            <>
              <p className={`mb-2 text-sm ${TONE_TEXT[worst?.tone || 'muted']}`}>
                {worst?.state === 'healthy' || worst?.state === 'disabled' || worst?.state === 'enabled'
                  ? 'All five subsystems are reporting normally.'
                  : `Worst subsystem: ${worst?.name} — ${worst?.label}.`}
              </p>

              {/* What this screen is, and is not. The verdicts are computed here,
                  in the browser, from the flags the health endpoint returns and the
                  events in the activity buffer — the source of each is shown beside
                  it. This is a reading of what the backend reports, not a separate
                  monitoring service watching it. */}
              <p className="mb-4 text-xs leading-relaxed text-ink-500">
                Each verdict is derived in your browser from the health endpoint&rsquo;s
                configuration flags and the activity buffer — the source is shown on every row.
                The dashboard reads and interprets what the backend reports; it is not an
                independent monitoring system.
              </p>

              <ul className="mb-5">
                {subsystems.map((item) => (
                  <SubsystemRow key={item.key} item={item} />
                ))}
              </ul>

              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="Uptime" value={formatUptime(data.uptimeSeconds)} hint="this process" />
                <Metric
                  label="DB ping"
                  value={data.database?.ping?.ok ? `${data.database.ping.latencyMs}ms` : 'failed'}
                  tone={data.database?.ping?.ok ? 'good' : 'bad'}
                  hint={data.database?.ping?.ok ? 'round trip' : data.database?.ping?.error}
                />
                <Metric
                  label="Rate-limit events"
                  value={formatNumber(rateLimited.length)}
                  tone={rateLimited.length > 0 ? 'warn' : 'good'}
                  hint="in the current buffer"
                />
                <Metric
                  label="Buffered events"
                  value={formatNumber(events.length)}
                  hint="process-local, max 300"
                />
              </div>

              <dl className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
                <Row label="Environment" value={data.env} />
                <Row label="Agent mode" value={data.agentMode} />
                <Row label="Configured cycle interval" value={formatInterval(data.cycleIntervalMs)} />
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
                  label="Strategic memory"
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

      {provider && (
        <ProviderPanel
          health={health}
          verdict={provider}
          rateLimited={rateLimited}
          providerErrors={providerErrors}
          llmCalls={agent?.stats?.llmCalls}
        />
      )}

      {agent ? (
        <SchedulerPanel agent={agent} lastError={lastError} verdict={scheduler} />
      ) : (
        <Panel title="Autonomous scheduler">
          <p className="py-2 text-sm text-ink-500">
            No agent has been initialized, so no loop is running yet.
          </p>
        </Panel>
      )}
    </div>
  );
}
