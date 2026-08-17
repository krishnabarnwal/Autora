/**
 * Which stage of a cycle an activity event belongs to.
 *
 * The backend already labels every line it writes with one of fourteen tags, and
 * for thirteen of them the tag *is* the stage — SOURCE is discovery, EDITOR is
 * the decision, PUBLISH is publication. So this module reads that label rather
 * than inferring a stage from the payload.
 *
 * AGENT is the exception: runCycle orchestrates every stage, so its tag says
 * "somewhere in the cycle" and nothing more. For those lines the stage comes from
 * the message the backend itself wrote, matched in specificity order against the
 * real wording at those call sites. No event is created, reordered, or relabelled
 * with a meaning the server did not give it; an unrecognised line falls back to
 * the cycle it ran inside.
 */

export const PHASE = {
  CYCLE: 'cycle',
  DISCOVERY: 'discovery',
  FILTERING: 'filtering',
  DECISION: 'decision',
  GENERATION: 'generation',
  PUBLISHING: 'publishing',
  MEMORY: 'memory',
  STRATEGIC: 'strategic',
  PROVIDER: 'provider',
  RUNTIME: 'runtime',
};

/**
 * The order a cycle actually runs in, so a filter row reads like the pipeline.
 * `label` is what the operator sees; `blurb` explains the stage in one clause.
 */
export const PHASE_ORDER = [
  { key: PHASE.CYCLE, label: 'Cycle', blurb: 'the loop starting, completing, or backing off' },
  { key: PHASE.DISCOVERY, label: 'Discovery', blurb: 'live sources fetched and normalized' },
  { key: PHASE.FILTERING, label: 'Filtering', blurb: 'local filtering, dedup, and candidate selection' },
  { key: PHASE.DECISION, label: 'Decision', blurb: 'the editorial judgement to publish or skip' },
  { key: PHASE.GENERATION, label: 'Generation', blurb: 'writing and verifying the post' },
  { key: PHASE.PUBLISHING, label: 'Publishing', blurb: 'the post reaching the feed' },
  { key: PHASE.MEMORY, label: 'Memory', blurb: 'decisions recorded to MongoDB' },
  { key: PHASE.STRATEGIC, label: 'Strategic', blurb: 'strategic-memory calls' },
  { key: PHASE.PROVIDER, label: 'Provider', blurb: 'LLM transport, retries, and rate limits' },
  { key: PHASE.RUNTIME, label: 'Runtime', blurb: 'process, HTTP, and database plumbing' },
];

const PHASE_BY_KEY = new Map(PHASE_ORDER.map((phase) => [phase.key, phase]));

/** The backend's own tags, mapped to the stage each one reports on. */
const TAG_PHASE = {
  SCHEDULER: PHASE.CYCLE,
  SOURCE: PHASE.DISCOVERY,
  TOPICS: PHASE.FILTERING,
  EDITOR: PHASE.DECISION,
  WRITER: PHASE.GENERATION,
  PUBLISH: PHASE.PUBLISHING,
  MEMORY: PHASE.MEMORY,
  BREETH: PHASE.STRATEGIC,
  LLM: PHASE.PROVIDER,
  SERVER: PHASE.RUNTIME,
  HTTP: PHASE.RUNTIME,
  DB: PHASE.RUNTIME,
  API: PHASE.RUNTIME,
};

/**
 * AGENT messages, in specificity order — the first match wins.
 *
 * Order carries the meaning here. 'Topic discovery failed; nothing was published
 * this cycle' contains both "discovery" and "published", and it is a discovery
 * failure; 'No viable candidate this cycle; publishing nothing' is a filtering
 * outcome, not a publishing one. Matching publication last is what keeps those
 * two lines out of the publishing stage.
 */
const AGENT_PATTERNS = [
  [/strategic memory/i, PHASE.STRATEGIC],
  [/deferred candidate/i, PHASE.MEMORY],
  [/repetition check/i, PHASE.MEMORY],
  [/discovery/i, PHASE.DISCOVERY],
  [/no viable candidate/i, PHASE.FILTERING],
  [/editor/i, PHASE.DECISION],
  [/generat/i, PHASE.GENERATION],
  [/publish/i, PHASE.PUBLISHING],
];

export function lifecyclePhase(event) {
  const tag = String(event?.tag ?? '').toUpperCase();
  if (tag !== 'AGENT') return TAG_PHASE[tag] || PHASE.RUNTIME;

  const message = String(event?.message ?? '');
  for (const [pattern, phase] of AGENT_PATTERNS) {
    if (pattern.test(message)) return phase;
  }
  return PHASE.CYCLE;
}

export function phaseMeta(key) {
  return PHASE_BY_KEY.get(key) || { key, label: key || 'Unknown', blurb: '' };
}

/**
 * How many buffered events fall in each stage. Only stages that actually
 * occurred get a count, so the filter row never offers an empty view.
 */
export function phaseCounts(events) {
  const counts = new Map();
  for (const event of events || []) {
    const key = lifecyclePhase(event);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
