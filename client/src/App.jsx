import { useEffect, useState } from 'react';
import { getHealth } from './services/api.js';

/**
 * Phase 1 shell: proves the client/server wiring end to end.
 * The full dashboard (feed, editorial decisions, memory) arrives in Phase 14.
 */
export default function App() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((data) => !cancelled && setHealth(data))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const connected = Boolean(health?.ok);

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-3">
        <p className="font-mono text-xs tracking-[0.2em] text-ink-500 uppercase">
          Problem Statement 3
        </p>
        <h1 className="text-4xl font-semibold text-white">Autonomous AI Creator</h1>
        <p className="max-w-xl text-sm leading-relaxed text-ink-300">
          An AI persona that discovers technology topics from live sources, decides what deserves
          publishing, and writes it up on its own schedule. No human prompts after initialization.
        </p>
      </header>

      <section
        aria-labelledby="status-heading"
        className="rounded-xl border border-ink-700 bg-ink-900/70 p-6"
      >
        <h2
          id="status-heading"
          className="mb-4 font-mono text-xs tracking-[0.18em] text-ink-500 uppercase"
        >
          System status
        </h2>

        {error && (
          <p role="alert" className="text-sm text-red-400">
            Backend unreachable: {error}
            <br />
            <span className="text-ink-500">
              Start it with <code className="text-ink-300">npm run dev</code> inside{' '}
              <code className="text-ink-300">server/</code>.
            </span>
          </p>
        )}

        {!error && !health && <p className="text-sm text-ink-500">Checking backend…</p>}

        {connected && (
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <StatusRow label="API" value="reachable" tone="good" />
            <StatusRow label="Agent mode" value={health.agentMode} />
            <StatusRow
              label="Cycle interval"
              value={formatInterval(health.cycleIntervalMs)}
            />
            <StatusRow label="LLM provider" value={health.llmProvider} />
            <StatusRow
              label="LLM key"
              value={health.llmConfigured ? 'configured' : 'not set'}
              tone={health.llmConfigured ? 'good' : 'warn'}
            />
            <StatusRow
              label="Database"
              value={health.databaseConfigured ? 'configured' : 'not set'}
              tone={health.databaseConfigured ? 'good' : 'warn'}
            />
          </dl>
        )}
      </section>

      <p className="font-mono text-xs text-ink-500">
        Phase 1 of 21 complete — project scaffold and health check.
      </p>
    </main>
  );
}

function StatusRow({ label, value, tone }) {
  const toneClass =
    tone === 'good' ? 'text-signal' : tone === 'warn' ? 'text-amber-400' : 'text-white';
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-ink-800 pb-2">
      <dt className="text-ink-500">{label}</dt>
      <dd className={`font-mono ${toneClass}`}>{value}</dd>
    </div>
  );
}

function formatInterval(ms) {
  if (!ms) return 'unknown';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}
