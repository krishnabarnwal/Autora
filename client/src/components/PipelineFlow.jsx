import { Badge, Dot } from './ui.jsx';
import { formatNumber } from '../lib/format.js';

/**
 * The autonomous loop, rendered from real counters.
 *
 * Each stage shows a number the backend actually reports (agent.stats or a
 * collection count). Stages the backend does not count — filtering and
 * deduplication are folded into topicsAfterFilter, and Breeth reports no
 * counter at all — show no number rather than an invented one.
 */
export function PipelineFlow({ stats, counts, breethEnabled, breethActivity }) {
  const s = stats || {};

  const stages = [
    {
      key: 'sources',
      label: 'Live sources',
      value: null,
      note: 'RSS + web feeds',
    },
    {
      key: 'discovery',
      label: 'Topic discovery',
      value: s.topicsDiscovered,
      note: 'headlines pulled',
    },
    {
      key: 'filter',
      label: 'Filtering + dedup',
      value: s.topicsAfterFilter,
      note: 'survived relevance & repetition',
    },
    {
      key: 'candidates',
      label: 'Candidate selection',
      value: s.topicsSelected,
      note: 'shortlisted for the editor',
    },
    {
      key: 'editorial',
      label: 'AI editorial decision',
      value: s.topicsRejected,
      note: 'rejected by the editor',
      tone: 'warn',
    },
    {
      key: 'generation',
      label: 'Content generation',
      value: s.llmCalls,
      note: 'LLM calls made',
      tone: 'info',
    },
    {
      key: 'publishing',
      label: 'Publishing',
      value: s.postsPublished,
      note: 'posts in the feed',
      tone: 'good',
    },
    {
      key: 'memory',
      label: 'Local memory',
      value: counts?.memories,
      note: 'decisions recorded',
    },
    {
      key: 'breeth',
      label: 'Breeth strategic memory',
      value: null,
      note: breethEnabled
        ? breethActivity > 0
          ? `${breethActivity} events logged`
          : 'enabled, awaiting a cycle'
        : 'optional — disabled',
      tone: breethEnabled ? 'info' : 'muted',
      dim: !breethEnabled,
    },
    {
      key: 'next',
      label: 'Next autonomous cycle',
      value: s.cyclesRun,
      note: 'cycles completed',
    },
  ];

  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {stages.map((stage, index) => (
        <li
          key={stage.key}
          className={`relative rounded-lg border border-ink-800 bg-ink-950/50 px-3 py-3 ${stage.dim ? 'opacity-60' : ''}`}
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-ink-500">{String(index + 1).padStart(2, '0')}</span>
            <Dot tone={stage.tone || 'muted'} />
          </div>
          <p className="mt-1.5 text-xs leading-snug font-medium text-ink-300">{stage.label}</p>
          {Number.isFinite(stage.value) && (
            <p className="mt-1 font-mono text-lg tabular-nums text-white">{formatNumber(stage.value)}</p>
          )}
          <p className="mt-1 text-[11px] leading-snug text-ink-500">{stage.note}</p>
        </li>
      ))}
    </ol>
  );
}

/** Compact legend explaining that the loop needs no human prompt. */
export function PipelineLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
      <Badge tone="good">no human prompt after init</Badge>
      <Badge tone="muted">counters come from the agent record</Badge>
      <Badge tone="muted">stages without a counter show none</Badge>
    </div>
  );
}
