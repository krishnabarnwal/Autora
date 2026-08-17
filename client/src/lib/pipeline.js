/**
 * Deriving pipeline stage state from data the backend already reports.
 *
 * Two independent sources, with different guarantees, and the difference is the
 * whole design:
 *
 *   agent.stats / counts  — cumulative, persisted in MongoDB. A positive counter
 *                           is durable proof a stage has run at some point.
 *   activity events       — {ts, level, tag, message}, from the logger's
 *                           in-memory ring buffer (utils/logger.js, 300 entries,
 *                           `persistent: false`). Process-local and wiped on
 *                           restart, so an ABSENCE of events proves nothing.
 *
 * So completion is read from counters, and recency is read from events. Never
 * the reverse: treating "no events" as "never ran" would blank the whole loop
 * after every server restart, while the counters plainly say otherwise.
 *
 * The tags below are the real `logger('TAG')` values emitted by each service —
 * SOURCE from services/sources, EDITOR from services/editorial, and so on. They
 * are not invented, and stages whose work emits no distinctive tag of its own
 * (filtering is folded into services/topics; candidate selection happens inside
 * runCycle) carry no tag here and derive their state from counters alone.
 *
 * IMPORTANT — what "active" does and does not mean. The backend exposes no
 * "currently executing stage" field, and this module does not fabricate one. It
 * reports the stage that emitted the most recent log line, which is the latest
 * stage *observed*, not a live program counter. Callers label it accordingly.
 */

/** How recent a log line must be to describe the agent as presently working. */
export const ACTIVE_WINDOW_MS = 90_000;

/** Stage state, in the order a reader should understand them. */
export const STAGE_STATE = Object.freeze({
  /** Cumulative counters prove this stage has run. */
  DONE: 'done',
  /** This stage emitted the newest log line, recently. */
  ACTIVE: 'active',
  /** Its newest log line was a warn/error. */
  DEGRADED: 'degraded',
  /** No counter and no evidence yet. */
  WAITING: 'waiting',
  /** Turned off by configuration, not by failure. */
  OFF: 'off',
});

/**
 * The word for each state, so the state never depends on colour or a glyph.
 * Rendered as text beside every stage in both layouts.
 */
export const STAGE_STATE_LABEL = Object.freeze({
  [STAGE_STATE.DONE]: 'Completed',
  [STAGE_STATE.ACTIVE]: 'Active',
  [STAGE_STATE.DEGRADED]: 'Degraded',
  [STAGE_STATE.WAITING]: 'Waiting',
  [STAGE_STATE.OFF]: 'Disabled',
});

/** A mark to accompany the word. Decorative — never the only signal. */
export const STAGE_STATE_GLYPH = Object.freeze({
  [STAGE_STATE.DONE]: '✓',
  [STAGE_STATE.ACTIVE]: '◉',
  [STAGE_STATE.DEGRADED]: '!',
  [STAGE_STATE.WAITING]: '○',
  [STAGE_STATE.OFF]: '×',
});

/**
 * The narrative the ten stages tell, as spans over them.
 *
 * Purely a visual grouping of the stages below — it adds no data and makes no
 * claim the backend has not. It exists so the loop reads as
 * "ingest → decide → create → publish → remember → repeat" at a glance rather
 * than as ten equal tiles. `span` values must total the number of stages.
 */
export const PIPELINE_PHASES = Object.freeze([
  { key: 'ingest', label: 'Ingest', span: 3 },
  { key: 'decide', label: 'Decide', span: 2 },
  { key: 'create', label: 'Create', span: 1 },
  { key: 'publish', label: 'Publish', span: 1 },
  { key: 'remember', label: 'Remember', span: 2 },
  { key: 'repeat', label: 'Repeat', span: 1 },
]);

/**
 * The newest event a stage can claim, newest-first as the route returns it.
 *
 * A stage claims an event when the tag matches and — where one tag covers more
 * than one stage — the message matches too. SOURCE and TOPICS are each emitted
 * by a module spanning several stages, so the tag alone would light the wrong
 * one; the patterns below are the literal log lines those modules write.
 */
function newestEventForStage(events, def) {
  const tags = def.tags;
  if (!tags || tags.length === 0) return null;
  for (const event of events) {
    if (!event?.tag || !tags.includes(event.tag)) continue;
    if (def.match && !def.match.test(event.message || '')) continue;
    return event;
  }
  return null;
}

function timeOf(event) {
  if (!event?.ts) return null;
  const parsed = Date.parse(event.ts);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Build the ten stages with their real labels, counters and derived state.
 *
 * @param {object}  input
 * @param {object}  input.stats           agent.stats — cumulative counters.
 * @param {object}  input.counts          { posts, memories } from GET /api/agent/:id.
 * @param {Array}   input.events          activity events, newest first.
 * @param {boolean} input.breethEnabled   health.breethEnabled.
 * @param {number}  input.breethActivity  count of classified Breeth events.
 * @param {string}  input.status          agent.status.
 * @param {number}  input.now             evaluation time; supplied by the caller
 *                                        so this stays a pure function.
 */
export function buildStages({
  stats,
  counts,
  events = [],
  breethEnabled,
  breethActivity = 0,
  status,
  now = Date.now(),
}) {
  const s = stats || {};

  // The loop as the backend actually runs it (services/agent/runCycle.js).
  //
  // `tags` are real logger('TAG') values; `match` narrows a tag that spans more
  // than one stage to the specific lines that stage writes. Together they are the
  // only evidence used for recency — no stage is lit by anything else.
  const defs = [
    {
      key: 'sources',
      label: 'Live sources',
      short: 'Sources',
      value: null,
      note: 'RSS + web feeds',
      tags: ['SOURCE'],
      // services/sources: fetching and per-feed results.
      match: /^(Fetching|Received|Source failed|Every source failed)/,
    },
    {
      key: 'discovery',
      label: 'Topic discovery',
      short: 'Discover',
      value: s.topicsDiscovered,
      note: 'headlines pulled',
      tags: ['SOURCE'],
      // The normalization tally the sources module writes once per cycle. This is
      // the discovery output; TOPICS never logs it.
      match: /^Total normalized topics/,
    },
    {
      key: 'filter',
      label: 'Filtering + dedup',
      short: 'Filter',
      value: s.topicsAfterFilter,
      note: 'survived relevance & repetition',
      // services/topics logs filtering and dedup under one tag; the messages are
      // what separate them from selection below.
      tags: ['TOPICS'],
      match: /^(Filtered|Deduplicated|No candidates survived)/,
    },
    {
      key: 'candidates',
      label: 'Candidate selection',
      short: 'Select',
      value: s.topicsSelected,
      note: 'shortlisted for the editor',
      // "Selected N candidates" — also services/topics, hence the same tag.
      tags: ['TOPICS'],
      match: /^Selected/,
    },
    {
      key: 'editorial',
      label: 'AI editorial decision',
      short: 'Decide',
      value: s.topicsRejected,
      note: 'rejected by the editor',
      tone: 'warn',
      tags: ['EDITOR'],
    },
    {
      key: 'generation',
      label: 'Content generation',
      short: 'Generate',
      value: s.llmCalls,
      note: 'LLM calls made',
      tone: 'info',
      // WRITER is services/generation. LLM is the provider layer it calls, which
      // logs readiness and retries — both belong to this stage.
      tags: ['WRITER', 'LLM'],
    },
    {
      key: 'publishing',
      label: 'Publishing',
      short: 'Publish',
      value: s.postsPublished,
      note: 'posts in the feed',
      tone: 'good',
      tags: ['PUBLISH'],
    },
    {
      key: 'memory',
      label: 'Local memory',
      short: 'Remember',
      value: counts?.memories,
      note: 'decisions recorded',
      tags: ['MEMORY'],
    },
    {
      key: 'breeth',
      label: 'Strategic memory',
      short: 'Reflect',
      value: null,
      note: breethEnabled
        ? breethActivity > 0
          ? `${breethActivity} events logged`
          : 'enabled, awaiting a cycle'
        : 'optional — disabled',
      tone: breethEnabled ? 'info' : 'muted',
      dim: !breethEnabled,
      tags: ['BREETH'],
    },
    {
      key: 'next',
      label: 'Next autonomous cycle',
      short: 'Repeat',
      value: s.cyclesRun,
      note: 'cycles completed',
      tags: ['SCHEDULER'],
    },
  ];

  // Which stage spoke most recently. Only stages that carry a tag can win, and
  // only while the agent is autonomous — a paused agent has no latest stage.
  const running = status === 'autonomous';
  let latestKey = null;
  let latestAt = null;
  if (running) {
    for (const def of defs) {
      const at = timeOf(newestEventForStage(events, def));
      if (at !== null && (latestAt === null || at > latestAt)) {
        latestAt = at;
        latestKey = def.key;
      }
    }
    // An old buffer is history, not a live position.
    if (latestAt !== null && now - latestAt > ACTIVE_WINDOW_MS) {
      latestKey = null;
      latestAt = null;
    }
  }

  const stages = defs.map((def) => {
    const event = newestEventForStage(events, def);
    const counted = Number.isFinite(def.value) && def.value > 0;
    const failing = event?.level === 'error' || event?.level === 'warn';

    let state;
    if (def.key === 'breeth' && !breethEnabled) state = STAGE_STATE.OFF;
    else if (failing) state = STAGE_STATE.DEGRADED;
    else if (def.key === latestKey) state = STAGE_STATE.ACTIVE;
    else if (counted) state = STAGE_STATE.DONE;
    // Stages with no counter of their own (sources, Breeth) are proven by their
    // log lines instead; without either they stay honestly blank.
    else if (event && def.value === null) state = STAGE_STATE.DONE;
    else state = STAGE_STATE.WAITING;

    return { ...def, state, event, at: timeOf(event) };
  });

  return {
    stages,
    latestKey,
    latestAt,
    /** True only when a real, recent log line places the agent mid-loop. */
    live: latestKey !== null,
  };
}
