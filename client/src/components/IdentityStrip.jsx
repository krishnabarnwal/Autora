import { Badge, Dot, ErrorNote } from './ui.jsx';
import { productStatus } from '../lib/agentStatus.js';
import { PRODUCT_NAME } from '../lib/vocabulary.js';

/**
 * A slim identity strip, shown above every section except the Overview.
 *
 * The Overview leads with the Hero, which is the full identity surface. Every
 * other section needs the same one-line answer to "what am I looking at, and is
 * it running" without repeating the Hero's counters — so this strip carries the
 * product first, the agent as a subordinate identifier, and the live status.
 *
 * The name Autora is the product; the persona name (which can be a throwaway
 * demo label) is deliberately secondary — an identifier, not the headline. The
 * status pill is derived by productStatus (lib/agentStatus.js), the same source
 * the Hero and the System health screen read, so the three can never disagree.
 */
export function IdentityStrip({ agent, health, events, detail }) {
  // A detail query that errored with nothing cached is the one case worth
  // interrupting for: the strip cannot honestly name the agent, so it says so
  // rather than rendering a blank or a stale guess.
  if (detail?.error && !detail?.data) {
    return <ErrorNote error={detail.error} hint="The agent detail endpoint could not be read." />;
  }

  const ps = productStatus({ agent, health, events });
  const name = agent?.persona?.name;
  const domain = agent?.persona?.domain;

  return (
    <section
      aria-label="Agent identity"
      className="autora-surface flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-ink-700 px-4 py-3"
    >
      {/* Product first — the name a visitor should leave with. */}
      <span className="font-mono text-[11px] tracking-[0.28em] text-ink-300 uppercase">
        {PRODUCT_NAME}
      </span>

      {/* The agent, as a subordinate identifier rather than a headline. */}
      {name ? (
        <span className="font-mono text-xs text-ink-500">
          agent <span className="text-ink-300">{name}</span>
        </span>
      ) : (
        <span className="font-mono text-xs text-ink-500">no agent initialized yet</span>
      )}

      {agent?.agentId && (
        <span className="hidden font-mono text-[11px] text-ink-500 sm:inline">{agent.agentId}</span>
      )}
      {agent?.mode && <span className="font-mono text-[11px] text-ink-500">mode: {agent.mode}</span>}
      {domain && <span className="font-mono text-[11px] text-ink-500">{domain}</span>}

      {/* Live status, pushed to the trailing edge. */}
      <span className="ml-auto inline-flex items-center gap-2">
        <Dot tone={ps.tone} pulse={ps.state === 'online'} />
        <Badge tone={ps.tone}>{ps.label}</Badge>
      </span>
    </section>
  );
}
