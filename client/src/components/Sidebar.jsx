import { Button, Dot } from './ui.jsx';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '../lib/vocabulary.js';

/**
 * The dashboard's sections. These are client-side state rather than routes, so
 * the ids here are the same values App switches on.
 */
export const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'pipeline', label: 'Autonomous loop' },
  { id: 'feed', label: 'Published posts' },
  { id: 'decisions', label: 'AI decisions' },
  { id: 'memory', label: 'Local memory' },
  { id: 'breeth', label: 'Strategic memory' },
  { id: 'activity', label: 'Activity log' },
  { id: 'system', label: 'System health' },
];

export function Sidebar({ section, onSelect, agents, agentId, onSelectAgent, health }) {
  const connected = Boolean(health.data?.ok);
  const tone = health.error ? 'bad' : connected ? 'good' : 'warn';
  // Only used for the small-screen "3 / 8" position. Clamped so an unrecognised
  // section cannot render "0 / 8".
  const activeIndex = Math.max(0, SECTIONS.findIndex((item) => item.id === section));

  return (
    <aside className="lg:w-60 lg:shrink-0">
      <div className="lg:sticky lg:top-6 space-y-4">
        <div>
          <p className="font-mono text-[10px] tracking-[0.2em] text-ink-500 uppercase">{PRODUCT_NAME}</p>
          <h1 className="mt-1 text-lg leading-tight font-semibold text-white">{PRODUCT_TAGLINE}</h1>
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

        {/*
          One nav, two shapes. On large screens it is the vertical sidebar it has
          always been; below that it becomes a horizontal rail, which is where the
          eight sections stop fitting.

          The small-screen affordances are all additive: an edge mask that fades
          the row where it continues past the viewport (so a cut-off label reads as
          "more this way" rather than as the end), scroll snapping, and a written
          position — "3 / 8" — because a fade is an affordance, not information.
          None of it applies at lg:, so the desktop sidebar is unchanged.
        */}
        <nav aria-label="Dashboard sections">
          <div className="flex items-baseline justify-between gap-3 lg:hidden">
            <span className="font-mono text-[10px] tracking-[0.16em] text-ink-500 uppercase">
              Sections
            </span>
            <span className="autora-numeric font-mono text-[10px] text-ink-500">
              {activeIndex + 1} / {SECTIONS.length}
              <span className="sr-only"> — scroll sideways for more sections</span>
            </span>
          </div>

          <ul className="autora-rail mt-1.5 flex snap-x snap-mandatory gap-1.5 overflow-x-auto pb-1 lg:mt-0 lg:snap-none lg:flex-col lg:overflow-visible">
            {SECTIONS.map((item) => {
              const active = section === item.id;
              return (
                <li key={item.id} className="shrink-0 snap-start lg:shrink lg:snap-align-none">
                  <Button
                    variant="nav"
                    active={active}
                    onClick={() => onSelect(item.id)}
                    aria-current={active ? 'page' : undefined}
                  >
                    {item.label}
                  </Button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </aside>
  );
}
