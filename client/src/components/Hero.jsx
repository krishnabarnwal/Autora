import { Badge, Dot } from './ui.jsx';
import { countdownTo, useNow } from '../hooks/useNow.js';
import { formatInterval, formatNumber, relativeTime } from '../lib/format.js';
import { productStatus } from '../lib/agentStatus.js';
import { PRODUCT_NAME, PRODUCT_TAGLINE, LOOP_STEPS } from '../lib/vocabulary.js';

/** Pill styling per product-status state; the Dot carries the same tone. */
const PILL = {
  online: 'border-signal/40 bg-signal/10 text-signal',
  degraded: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  offline: 'border-red-500/40 bg-red-500/10 text-red-300',
  connecting: 'border-ink-700 bg-ink-900/70 text-ink-300',
};

/**
 * The first thing a visitor sees: what Autora is, and whether it is running
 * right now.
 *
 * Everything here is a real backend field — persona, status, mode,
 * cycleIntervalMs, lastCycleAt, nextCycleAt, stats. The status pill is derived by
 * productStatus (lib/agentStatus.js), which reads the same health, agent status
 * and scheduler failure streak the System health screen does, so the headline
 * state and the diagnostics can never disagree. The countdown ticks locally
 * between polls (see useNow) but counts toward the timestamp the scheduler
 * actually set; when the backend reports no next cycle, the block is omitted
 * rather than zeroed.
 */
export function Hero({ agent, health, counts, events }) {
  const ps = productStatus({ agent, health, events });

  // No scheduled cycle means no timer: useNow installs nothing.
  const now = useNow(Boolean(agent?.nextCycleAt));
  const countdown = countdownTo(agent?.nextCycleAt, now);
  const lastCycle = relativeTime(agent?.lastCycleAt, now);

  return (
    <section
      aria-label="Agent status"
      className="autora-surface-hero autora-grid-veil autora-sheen relative overflow-hidden rounded-2xl border border-ink-700"
    >
      <div className="relative px-5 py-6 sm:px-7 sm:py-8">
        <div className="flex flex-col gap-7 lg:flex-row lg:items-start lg:justify-between lg:gap-10">
          {/* Identity */}
          <div className="min-w-0 autora-fade">
            <p className="font-mono text-[10px] tracking-[0.34em] text-ink-500 uppercase">{PRODUCT_NAME}</p>
            <h1 className="mt-1.5 text-2xl leading-tight font-semibold tracking-tight text-white sm:text-3xl">
              {PRODUCT_TAGLINE}
            </h1>

            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[11px] uppercase ${
                  PILL[ps.state] || PILL.connecting
                }`}
              >
                <Dot tone={ps.tone} pulse={ps.state === 'online'} />
                {ps.label}
              </span>
              {agent?.mode && <Badge tone="muted">mode: {agent.mode}</Badge>}
              {agent?.persona?.domain && <Badge tone="muted">{agent.persona.domain}</Badge>}
            </div>

            {/* The loop itself, as a single readable line. */}
            <ol className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5">
              {LOOP_STEPS.map((step, index) => (
                <li key={step} className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink-300">{step}</span>
                  {index < LOOP_STEPS.length - 1 && (
                    <span aria-hidden="true" className="font-mono text-xs text-ink-500">
                      →
                    </span>
                  )}
                </li>
              ))}
            </ol>

            <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-500">
              {agent?.cycleIntervalMs
                ? `The agent runs on its own configured schedule — one cycle every ${formatInterval(
                    agent.cycleIntervalMs
                  )} — and this dashboard only reads what it did.`
                : 'This dashboard only reads what the agent did; it issues no command to the agent.'}
            </p>

            {/* When the agent is not cleanly online, say why — without dressing it
                up as healthy. The full resilience detail lives in the banners and
                the System health screen; this is the one-line headline. */}
            {(ps.state === 'degraded' || ps.state === 'offline') && ps.detail && (
              <p
                className={`mt-2 text-xs leading-relaxed ${
                  ps.state === 'offline' ? 'text-red-300' : 'text-amber-300'
                }`}
              >
                {ps.detail}
              </p>
            )}
          </div>

          {/* Cycle clock */}
          <div className="shrink-0 lg:text-right">
            {countdown ? (
              <>
                <p className="font-mono text-[10px] tracking-[0.22em] text-ink-500 uppercase">
                  {countdown.overdue ? 'Cycle due' : 'Next autonomous cycle'}
                </p>
                <p
                  className={`autora-numeric mt-1.5 font-mono text-4xl font-semibold sm:text-5xl ${
                    countdown.overdue ? 'text-amber-400' : 'text-white'
                  }`}
                >
                  {countdown.hours}
                  <span className="text-ink-500">:</span>
                  {countdown.minutes}
                  <span className="text-ink-500">:</span>
                  {countdown.seconds}
                </p>
              </>
            ) : (
              <>
                <p className="font-mono text-[10px] tracking-[0.22em] text-ink-500 uppercase">
                  Next autonomous cycle
                </p>
                <p className="mt-1.5 font-mono text-2xl text-ink-500">not scheduled</p>
              </>
            )}

            {lastCycle && (
              <p className="mt-2.5 font-mono text-[11px] text-ink-500">
                last cycle <span className="text-ink-300">{lastCycle}</span>
              </p>
            )}
          </div>
        </div>

        {/* Headline counters — the agent's whole history, from agent.stats.
            Captioned "lifetime" so they read as cumulative since creation, not as
            this-process or current-cycle activity. */}
        <div className="mt-7 border-t border-ink-700/70 pt-5">
          <p className="font-mono text-[10px] tracking-[0.18em] text-ink-500 uppercase">
            Lifetime totals
            <span className="ml-1.5 tracking-normal text-ink-500 normal-case">
              · cumulative since the agent was created
            </span>
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <HeroStat label="Cycles run" value={agent?.stats?.cyclesRun} tone="text-white" />
            <HeroStat label="Topics discovered" value={agent?.stats?.topicsDiscovered} tone="text-white" />
            <HeroStat label="Posts published" value={agent?.stats?.postsPublished} tone="text-signal" />
            <HeroStat label="Decisions recorded" value={counts?.memories} tone="text-accent" />
          </dl>
        </div>
      </div>
    </section>
  );
}

function HeroStat({ label, value, tone }) {
  return (
    <div>
      <dt className="font-mono text-[10px] tracking-[0.18em] text-ink-500 uppercase">{label}</dt>
      <dd className={`autora-numeric mt-1 text-2xl font-semibold sm:text-3xl ${tone}`}>
        {formatNumber(value)}
      </dd>
    </div>
  );
}
