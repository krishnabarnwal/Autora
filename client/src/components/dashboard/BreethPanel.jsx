import { Badge, Panel, RefreshTag, Row } from '../ui.jsx';
import { ActivityList } from '../panels.jsx';

/**
 * Breeth's state, summarized from the activity buffer.
 *
 * Kept beside BreethPanel because it is the same explanation rendered at two
 * sizes: the Overview card and the dedicated section both need it, and neither
 * would make sense without the other's framing.
 */
export function BreethSummary({ enabled, events }) {
  if (!enabled) {
    return (
      <div className="space-y-2.5">
        <Badge tone="muted">disabled</Badge>
        <p className="text-sm leading-relaxed text-ink-500">
          Strategic memory is an optional layer. It is switched off, and the agent runs
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
          Enabled, but no strategic-memory event has been buffered yet this process. One episode is recorded
          per cycle at most.
        </p>
      ) : (
        <ActivityList data={{ events: events.slice(0, 5) }} />
      )}
      <p className="text-xs leading-relaxed text-ink-500">
        Non-authoritative by design: a strategic-memory outage is logged and ignored. It never fails a cycle,
        never blocks publishing, and never overrides a MongoDB decision.
      </p>
    </div>
  );
}

export function BreethPanel({ enabled, events, query }) {
  return (
    <div className="space-y-5">
      <Panel
        title="Strategic memory"
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
          <Row label="Strategic memory is authoritative for" value="nothing" tone="muted" />
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
