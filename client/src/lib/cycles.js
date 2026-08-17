/**
 * One autonomous cycle, reconstructed from what the backend already reports.
 *
 * There is no per-cycle endpoint, and this module is the reason none was added.
 * Three existing reads already contain everything a cycle detail needs:
 *
 *   /activity  — the ordered log of one process's cycles. `Cycle started` (AGENT)
 *                opens a segment and carries the cycleId; `Cycle complete`
 *                (SCHEDULER) closes it and carries the outcome, the failure flag,
 *                the failure streak and the next delay.
 *   /memory    — the persisted decision for that cycle, joined on `cycleId`:
 *                decision, score, reason, reasons, rejectionCategory, sources,
 *                and postId when something was published.
 *   /feed      — the published post itself, joined on `postId`.
 *
 * Everything below is a read of those three. Every field is optional and every
 * absence is representable: a stage that logged nothing reports `null`, and the
 * UI renders "Not recorded" rather than a zero. Numbers are only ever parsed out
 * of a log payload the server itself wrote — never inferred from a count of
 * lines, never carried over from a neighbouring cycle.
 *
 * The buffer is process-local, capped at 300 entries, and cleared on restart, so
 * `partial` marks a segment whose opening or closing marker is no longer in it.
 * A partial cycle is shown as partial; it is never completed by guesswork.
 */

import { lifecyclePhase } from './lifecycle.js';
import { classifyEvent } from './format.js';
import { isProviderFailure } from './health.js';

/** The two markers that bracket a cycle, written by runCycle and the worker. */
const START = 'Cycle started';
const COMPLETE = 'Cycle complete';

/** Outcome vocabulary, mirroring OUTCOME in services/agent/runCycle.js. */
export const CYCLE_OUTCOME = {
  published: { label: 'Published', tone: 'good', blurb: 'a post reached the feed' },
  duplicate: { label: 'Duplicate', tone: 'info', blurb: 'the topic was already published' },
  idle: { label: 'No post', tone: 'muted', blurb: 'the cycle chose not to publish' },
  failed: { label: 'Failed', tone: 'bad', blurb: 'the cycle could not complete its work' },
  paused: { label: 'Paused', tone: 'warn', blurb: 'the agent was not active' },
};

/**
 * The outcome vocabulary for a cycle.
 *
 * Two distinct absences, kept distinct. A null outcome means the scheduler's
 * completion marker is not available — "Not recorded". A value we do not
 * recognise is shown verbatim instead, because inventing a friendly label for it
 * would hide the fact that the backend reported something this file has not been
 * taught about.
 */
export function outcomeMeta(outcome) {
  if (CYCLE_OUTCOME[outcome]) return CYCLE_OUTCOME[outcome];
  if (outcome === null || outcome === undefined || outcome === '') {
    return { label: 'Not recorded', tone: 'muted', blurb: '', recorded: false };
  }
  return { label: String(outcome), tone: 'muted', blurb: '', recorded: true };
}

/** Read a finite number off a log payload, or null. Never coerces a string. */
function num(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Oldest-first copy of the buffer.
 *
 * /activity returns newest-first (recentActivity sorts that way), but a cycle is
 * a forward sequence of stages, so segmentation and every "first match" below
 * read in chronological order. `slice()` first: the caller's array is polled
 * state and must not be reversed in place.
 */
function chronological(events) {
  return [...(events || [])].reverse();
}

/**
 * Split the buffer into cycle segments on the `Cycle started` marker.
 *
 * Events before the first marker belong to a cycle whose opening has already
 * aged out (or to process startup); they are kept as a leading partial segment
 * only when a closing marker proves a cycle was running, so startup noise does
 * not masquerade as a cycle.
 */
function segment(events) {
  const ordered = chronological(events);
  const segments = [];
  let current = null;

  for (const event of ordered) {
    if (event.message === START) {
      if (current) segments.push(current);
      current = { events: [event], startEvent: event, completeEvent: null };
      continue;
    }
    if (!current) {
      // No opening marker yet. Buffer the orphans; they are only promoted to a
      // segment if a completion marker turns up to vouch for them.
      current = { events: [], startEvent: null, completeEvent: null, orphan: true };
    }
    current.events.push(event);
    if (event.message === COMPLETE) {
      current.completeEvent = event;
      // A cycle ends at its completion marker: anything after it belongs to the
      // next cycle, not this one.
      segments.push(current);
      current = null;
    }
  }
  if (current && (current.startEvent || current.completeEvent)) segments.push(current);

  return segments.filter((s) => s.startEvent || s.completeEvent);
}

/** First event in the segment matching a predicate, in chronological order. */
function find(events, predicate) {
  for (const event of events) {
    if (predicate(event)) return event;
  }
  return null;
}

/** Last event matching a predicate — for stages that log more than one line. */
function findLast(events, predicate) {
  let hit = null;
  for (const event of events) {
    if (predicate(event)) hit = event;
  }
  return hit;
}

const byTag = (tag) => (event) => String(event?.tag ?? '').toUpperCase() === tag;

export const STAGE_STATUS = {
  DONE: 'done',
  DEGRADED: 'degraded',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  MISSING: 'missing',
};

/**
 * Discovery — how many sources were read and how many topics came back.
 *
 * `Total normalized topics: N` (SOURCE) carries sourcesAttempted /
 * sourcesSucceeded / sourcesFailed / rawItems / normalizedItems / durationMs, so
 * every figure here is the server's own count. A cycle whose discovery line has
 * aged out reports MISSING rather than a zero.
 */
function discoveryStage(events) {
  const total = findLast(events, (e) => byTag('SOURCE')(e) && /total normalized topics/i.test(e.message));
  const failure = find(events, (e) => byTag('AGENT')(e) && /discovery failed/i.test(e.message));
  const data = total?.data || {};

  const facts = [
    ['Sources read', num(data.sourcesSucceeded)],
    ['Sources failed', num(data.sourcesFailed)],
    ['Raw items', num(data.rawItems)],
    ['Normalized topics', num(data.normalizedItems)],
  ];

  if (failure) {
    return {
      key: 'discover', status: STAGE_STATUS.FAILED, at: failure.ts,
      headline: 'Discovery failed; nothing was published this cycle',
      facts, code: failure.data?.code ?? null,
    };
  }
  if (!total) {
    return { key: 'discover', status: STAGE_STATUS.MISSING, at: null, headline: null, facts: [], code: null };
  }
  const someFailed = num(data.sourcesFailed) > 0;
  return {
    key: 'discover',
    status: someFailed ? STAGE_STATUS.DEGRADED : STAGE_STATUS.DONE,
    at: total.ts,
    headline: total.message,
    facts,
    durationMs: num(data.durationMs),
    code: null,
  };
}

/**
 * Filter and dedup — the TOPICS stage, which logs each step separately:
 * `Filtered N items to M`, `Deduplicated N items to M`, `Selected N candidates`.
 */
function filterStage(events) {
  const filtered = find(events, (e) => byTag('TOPICS')(e) && /^filtered/i.test(e.message));
  const deduped = find(events, (e) => byTag('TOPICS')(e) && /^deduplicated/i.test(e.message));
  const data = filtered?.data || {};

  if (!filtered && !deduped) {
    return { key: 'filter', status: STAGE_STATUS.MISSING, at: null, headline: null, facts: [], code: null };
  }
  return {
    key: 'filter',
    status: STAGE_STATUS.DONE,
    at: (deduped || filtered).ts,
    headline: [filtered?.message, deduped?.message].filter(Boolean).join(' · '),
    facts: [
      ['Kept after filtering', num(data.kept)],
      ['Rejected', num(data.rejected)],
      ['Off-topic', num(data.irrelevant)],
      ['Stale', num(data.stale)],
      ['Duplicates removed', num(deduped?.data?.removed)],
    ],
    code: null,
  };
}

/** Selection — `Selected N candidates` (TOPICS), which carries the shortlist. */
function selectStage(events) {
  const selected = find(events, (e) => byTag('TOPICS')(e) && /^selected/i.test(e.message));
  const none = find(events, (e) => byTag('AGENT')(e) && /no viable candidate/i.test(e.message));

  if (none) {
    return {
      key: 'select', status: STAGE_STATUS.SKIPPED, at: none.ts,
      headline: 'No viable candidate this cycle; no LLM call was made',
      facts: [
        ['Discovered', num(none.data?.discovered)],
        ['Blocked by memory', num(none.data?.blocked)],
      ],
      code: null,
    };
  }
  if (!selected) {
    return { key: 'select', status: STAGE_STATUS.MISSING, at: null, headline: null, facts: [], code: null };
  }
  const topics = Array.isArray(selected.data?.topics) ? selected.data.topics : null;
  return {
    key: 'select',
    status: STAGE_STATUS.DONE,
    at: selected.ts,
    headline: selected.message,
    facts: [
      ['Top score', num(selected.data?.topScore)],
      ['Domain', selected.data?.domain ?? null],
    ],
    topics,
    code: null,
  };
}
/**
 * The editorial decision — the LLM call itself, from the EDITOR tag.
 *
 * This stage reports how the call went (provider, model, confidence) and whether
 * the editor chose to publish. The *reasoning* is not read from here: it is
 * persisted on the memory row and joined in below, so it survives a restart that
 * wipes this buffer.
 */
function decideStage(events) {
  const judging = find(events, (e) => byTag('EDITOR')(e) && /^judging/i.test(e.message));
  const decided = findLast(events, (e) => byTag('EDITOR')(e) && /^editorial decision:/i.test(e.message));
  const callFailed = find(events, (e) => byTag('EDITOR')(e) && /^editorial call failed/i.test(e.message));
  const threw = find(events, (e) => byTag('AGENT')(e) && /editorial judgement threw/i.test(e.message));
  const belowFloor = find(events, (e) => byTag('EDITOR')(e) && /below the .* floor/i.test(e.message));
  const noLlm = find(events, (e) => byTag('EDITOR')(e) && /^skipped without an llm call/i.test(e.message));

  const facts = [
    ['Provider', judging?.data?.provider ?? decided?.data?.provider ?? null],
    ['Model', judging?.data?.model ?? decided?.data?.model ?? null],
    ['Confidence', num(decided?.data?.confidence)],
  ];

  const failure = threw || callFailed;
  if (failure) {
    return {
      key: 'decide', status: STAGE_STATUS.FAILED, at: failure.ts,
      headline: failure.message, facts,
      code: failure.data?.code ?? null,
    };
  }
  if (noLlm) {
    return {
      key: 'decide', status: STAGE_STATUS.SKIPPED, at: noLlm.ts,
      headline: 'Prechecks settled it; no LLM call was needed', facts: [], code: null,
    };
  }
  if (!decided && !judging) {
    return { key: 'decide', status: STAGE_STATUS.MISSING, at: null, headline: null, facts: [], code: null };
  }
  const chose = decided ? /publish\s*$/i.test(decided.message) : null;
  return {
    key: 'decide',
    status: decided ? STAGE_STATUS.DONE : STAGE_STATUS.MISSING,
    at: (decided || judging).ts,
    headline: belowFloor ? belowFloor.message : decided?.message ?? null,
    facts,
    // The editor's own sentence, when it logged one. Rendered as the model's
    // words, never merged with the persisted reason.
    note: decided?.data?.reason ?? null,
    chose,
    code: null,
  };
}

/**
 * Generation — WRITER for the write itself, LLM for provider retries.
 *
 * A retry is real degradation the user should see, so a successful post that
 * needed one is DEGRADED rather than DONE, and the retry line is what says so.
 */
function generateStage(events) {
  const writing = find(events, (e) => byTag('WRITER')(e) && /^writing a/i.test(e.message));
  const verified = find(events, (e) => byTag('WRITER')(e) && /^post written and verified/i.test(e.message));
  const callFailed = find(events, (e) => byTag('WRITER')(e) && /^generation call failed/i.test(e.message));
  const rejected = find(events, (e) => byTag('WRITER')(e) && /failed verification/i.test(e.message));
  const threw = find(events, (e) => byTag('AGENT')(e) && /post generation threw/i.test(e.message));
  const notChosen = find(events, (e) => byTag('WRITER')(e) && /editorial decision was not to publish/i.test(e.message));
  const retry = find(events, (e) => byTag('LLM')(e) && /call failed, retrying/i.test(e.message));

  const facts = [
    ['Platform', writing?.data?.platform ?? null],
    ['Characters', num(verified?.data?.chars ?? verified?.data?.length)],
    ['Retries', retry ? num(retry.data?.retries) ?? 1 : null],
  ];

  const failure = threw || callFailed || rejected;
  if (failure) {
    return {
      key: 'generate', status: STAGE_STATUS.FAILED, at: failure.ts,
      headline: failure.message, facts,
      code: failure.data?.code ?? null,
      retried: Boolean(retry),
    };
  }
  if (notChosen) {
    return {
      key: 'generate', status: STAGE_STATUS.SKIPPED, at: notChosen.ts,
      headline: 'Nothing was written: the editor chose not to publish', facts: [], code: null,
    };
  }
  if (!verified && !writing) {
    return { key: 'generate', status: STAGE_STATUS.MISSING, at: null, headline: null, facts: [], code: null };
  }
  return {
    key: 'generate',
    status: retry ? STAGE_STATUS.DEGRADED : verified ? STAGE_STATUS.DONE : STAGE_STATUS.MISSING,
    at: (verified || writing).ts,
    headline: retry ? `${verified?.message ?? writing.message} · after a provider retry` : verified?.message ?? null,
    facts,
    code: null,
    retried: Boolean(retry),
  };
}
/**
 * Publishing — PUBLISH for the write to the feed, AGENT for the outcome line.
 *
 * `Publishing outcome` carries {status, postId}, so a cycle that published names
 * the post it created and the detail view can join it to the feed.
 */
function publishStage(events) {
  const published = find(events, (e) => byTag('PUBLISH')(e) && /^published a post/i.test(e.message));
  const duplicate = find(events, (e) => byTag('PUBLISH')(e) && /^duplicate topic/i.test(e.message));
  const persistFailed = find(events, (e) => byTag('PUBLISH')(e) && /^post persistence failed/i.test(e.message));
  const failed = find(events, (e) => byTag('AGENT')(e) && /^publishing failed/i.test(e.message));
  const outcome = findLast(events, (e) => byTag('AGENT')(e) && /^publishing outcome/i.test(e.message));
  const nothing = find(events, (e) => byTag('AGENT')(e) && /^no post this cycle/i.test(e.message));

  const postId = outcome?.data?.postId ?? published?.data?.postId ?? duplicate?.data?.postId ?? null;
  const failure = failed || persistFailed;

  if (failure) {
    return {
      key: 'publish', status: STAGE_STATUS.FAILED, at: failure.ts,
      headline: failure.message, facts: [], postId: null,
      code: failure.data?.code ?? null,
    };
  }
  if (duplicate) {
    return {
      key: 'publish', status: STAGE_STATUS.SKIPPED, at: duplicate.ts,
      headline: 'The topic was already published; the existing post was returned',
      facts: [], postId, code: null,
    };
  }
  if (published) {
    return {
      key: 'publish', status: STAGE_STATUS.DONE, at: published.ts,
      headline: published.message, facts: [], postId, code: null,
    };
  }
  if (nothing) {
    return {
      key: 'publish', status: STAGE_STATUS.SKIPPED, at: nothing.ts,
      headline: 'Nothing was published this cycle', facts: [], postId: null, code: null,
    };
  }
  return { key: 'publish', status: STAGE_STATUS.MISSING, at: null, headline: null, facts: [], postId: null, code: null };
}

/**
 * Local memory — the decision row this cycle wrote (MEMORY), or the deferred
 * candidate runCycle recorded on its behalf (AGENT).
 */
function rememberStage(events) {
  const recorded = findLast(events, (e) => byTag('MEMORY')(e) && /^recorded a decision/i.test(e.message));
  const deferred = find(events, (e) => byTag('AGENT')(e) && /^recorded a deferred candidate/i.test(e.message));
  const failed = find(events, (e) => byTag('MEMORY')(e) && /^memory .* failed/i.test(e.message));
  const notRecorded = find(events, (e) => byTag('AGENT')(e) && /could not record the deferred candidate/i.test(e.message));

  const failure = failed || notRecorded;
  if (failure) {
    return {
      key: 'remember', status: STAGE_STATUS.FAILED, at: failure.ts,
      headline: failure.message, facts: [], code: failure.data?.code ?? null,
    };
  }
  const hit = recorded || deferred;
  if (!hit) {
    return { key: 'remember', status: STAGE_STATUS.MISSING, at: null, headline: null, facts: [], code: null };
  }
  return {
    key: 'remember', status: STAGE_STATUS.DONE, at: hit.ts, headline: hit.message,
    facts: [
      ['Decision', recorded?.data?.decision ?? null],
      ['Normalized topic', (recorded || deferred)?.data?.normalizedTopic ?? null],
    ],
    code: null,
  };
}

/**
 * Breeth strategic memory — optional by configuration.
 *
 * An unavailable Breeth is degradation, not failure: runCycle treats the write as
 * best-effort and the cycle still succeeds. That distinction is preserved here so
 * a published cycle is not painted as broken because a side channel was down.
 */
function reflectStage(events) {
  const recorded = find(events, (e) => byTag('BREETH')(e) && /^recorded a strategic memory/i.test(e.message));
  const unavailable = find(events, (e) => byTag('BREETH')(e) && /unavailable/i.test(e.message));
  const skipped = find(events, (e) => byTag('AGENT')(e) && /^strategic memory write skipped/i.test(e.message));

  if (recorded) {
    const d = recorded.data || {};
    return {
      key: 'reflect', status: STAGE_STATUS.DONE, at: recorded.ts, headline: recorded.message,
      facts: [
        ['Episode', d.episodeName ?? null],
        ['Event', d.event ?? null],
        ['Entities', num(d.entities)],
        ['Relationships', num(d.edges)],
      ],
      code: null,
    };
  }
  const degraded = unavailable || skipped;
  if (degraded) {
    return {
      key: 'reflect', status: STAGE_STATUS.DEGRADED, at: degraded.ts,
      headline: `${degraded.message} — the cycle itself was unaffected`,
      facts: [], code: degraded.data?.code ?? null,
    };
  }
  return { key: 'reflect', status: STAGE_STATUS.MISSING, at: null, headline: null, facts: [], code: null };
}

/** The eight stages, in the order runCycle executes them. */
export const CYCLE_STAGES = Object.freeze([
  { key: 'discover', label: 'Discover', blurb: 'read the live sources' },
  { key: 'filter', label: 'Filter', blurb: 'relevance and repetition' },
  { key: 'select', label: 'Select', blurb: 'shortlist for the editor' },
  { key: 'decide', label: 'Decide', blurb: 'the editorial judgement' },
  { key: 'generate', label: 'Generate', blurb: 'write and verify the post' },
  { key: 'publish', label: 'Publish', blurb: 'add it to the feed' },
  { key: 'remember', label: 'Remember', blurb: 'record the decision' },
  { key: 'reflect', label: 'Reflect', blurb: 'strategic memory' },
]);

/** The reader for each stage, keyed by the stage it reconstructs. */
const STAGE_READERS = {
  discover: discoveryStage,
  filter: filterStage,
  select: selectStage,
  decide: decideStage,
  generate: generateStage,
  publish: publishStage,
  remember: rememberStage,
  reflect: reflectStage,
};

export const STAGE_STATUS_LABEL = Object.freeze({
  [STAGE_STATUS.DONE]: 'Completed',
  [STAGE_STATUS.DEGRADED]: 'Degraded',
  [STAGE_STATUS.SKIPPED]: 'Skipped',
  [STAGE_STATUS.FAILED]: 'Failed',
  [STAGE_STATUS.MISSING]: 'Not recorded',
});

export const STAGE_STATUS_TONE = Object.freeze({
  [STAGE_STATUS.DONE]: 'good',
  [STAGE_STATUS.DEGRADED]: 'warn',
  [STAGE_STATUS.SKIPPED]: 'muted',
  [STAGE_STATUS.FAILED]: 'bad',
  [STAGE_STATUS.MISSING]: 'muted',
});
/** Milliseconds between two log timestamps, or null if either is unusable. */
function spanMs(fromIso, toIso) {
  const from = Date.parse(fromIso ?? '');
  const to = Date.parse(toIso ?? '');
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return to - from;
}

/**
 * The warnings and errors raised inside one cycle, in the cycle's own order.
 *
 * This is the honest-degradation channel: a rate limit, a provider error, a
 * failed source, a Breeth outage. Nothing is summarised away — each notice keeps
 * its own tag, level and message, and `kind` marks the two cases the dashboard
 * already treats specially elsewhere.
 */
function noticesOf(events) {
  return events
    .filter((event) => event.level === 'warn' || event.level === 'error')
    .map((event) => ({
      ts: event.ts,
      level: event.level,
      tag: event.tag,
      message: event.message,
      phase: lifecyclePhase(event),
      kind: classifyEvent(event),
      provider: isProviderFailure(event),
    }));
}

/** Assemble one cycle from its segment, joining the persisted decision and post. */
function buildCycle(seg, { memoryByCycle, postsById }) {
  const startData = seg.startEvent?.data || {};
  const doneData = seg.completeEvent?.data || {};
  const cycleId = startData.cycleId ?? doneData.cycleId ?? null;

  const startedAt = seg.startEvent?.ts ?? null;
  const completedAt = seg.completeEvent?.ts ?? null;
  const nextDelayMs = num(doneData.nextDelayMs);

  const stages = CYCLE_STAGES.map((meta) => ({ ...meta, ...STAGE_READERS[meta.key](seg.events) }));

  // The decision this cycle persisted. Joined on cycleId, which runCycle writes
  // onto the memory row — so the reasoning survives the restart that empties the
  // activity buffer, and a cycle whose row has been trimmed shows no decision
  // rather than a neighbour's.
  const decision = cycleId ? memoryByCycle.get(cycleId) ?? null : null;
  const publishPostId = stages.find((s) => s.key === 'publish')?.postId ?? null;
  const postId = decision?.postId ?? publishPostId ?? null;

  return {
    cycleId,
    /** The sort key for the union: when this cycle happened. */
    at: startedAt ?? completedAt ?? decision?.createdAt ?? null,
    startedAt,
    completedAt,
    /** The activity buffer still covers this cycle, so stages are real. */
    traced: true,
    /** Wall-clock between the two markers; null unless both are still buffered. */
    durationMs: spanMs(startedAt, completedAt),
    outcome: doneData.outcome ?? null,
    failed: seg.completeEvent ? Boolean(doneData.failed) : null,
    consecutiveFailures: num(doneData.consecutiveFailures),
    nextDelayMs,
    /**
     * When the worker said it would wake again. The sum of two values the worker
     * itself logged — the same arithmetic it does to set nextCycleAt — and null
     * unless both are present.
     */
    nextCycleAt: completedAt && nextDelayMs !== null
      ? new Date(Date.parse(completedAt) + nextDelayMs).toISOString()
      : null,
    /** A marker aged out of the 300-entry buffer; the cycle is shown as partial. */
    partial: !seg.startEvent || !seg.completeEvent,
    stages,
    notices: noticesOf(seg.events),
    decision,
    post: postId ? postsById.get(postId) ?? null : null,
    postId,
    events: seg.events,
  };
}

/**
 * Every cycle that can be reconstructed, newest first.
 *
 * Three sources with very different reach, and the union is the point:
 *
 *   the activity buffer  — rich per-stage detail, but process-local, 300 entries,
 *                          wiped on restart. At a 90-minute cadence it covers the
 *                          last cycle or two and nothing older.
 *   cycle history        — one durable row per execution: status, outcome, the
 *                          counts, the duration, the provider. Survives restarts,
 *                          but it is an aggregate and holds no stage detail at all.
 *   persisted memory     — one row per decision, carrying cycleId, the decision,
 *                          score, reason, reasons and postId. Also durable, and it
 *                          is where the agent's reasoning lives.
 *
 * A cycle in all three is shown in full. A cycle the buffer no longer reaches
 * keeps whatever the durable rows prove — the outcome, the counts, the reasoning —
 * and reports every *stage* as "Not recorded", flagged `traced: false`, because
 * the stage detail is genuinely gone rather than the cycle having done nothing.
 * Reading the list from the buffer alone would claim the agent had run one cycle
 * when it has run hundreds; reading the aggregate as though it were a trace would
 * be the opposite error.
 *
 * @param {object} input
 * @param {Array}  input.events  /activity events, newest-first as returned.
 * @param {Array}  input.memory  /memory rows (each may carry cycleId, postId).
 * @param {Array}  input.posts   /feed posts, joined to a cycle by postId.
 * @param {Array}  input.runs    /cycles history rows, joined by cycleId.
 */
export function buildCycles({ events = [], memory = [], posts = [], runs = [] } = {}) {
  const memoryByCycle = new Map();
  for (const row of memory) {
    if (row?.cycleId && !memoryByCycle.has(row.cycleId)) memoryByCycle.set(row.cycleId, row);
  }
  const postsById = new Map();
  for (const post of posts) {
    if (post?.id) postsById.set(post.id, post);
  }
  const runsByCycle = new Map();
  for (const run of runs) {
    if (run?.cycleId && !runsByCycle.has(run.cycleId)) runsByCycle.set(run.cycleId, run);
  }

  const traced = segment(events)
    .map((seg) => buildCycle(seg, { memoryByCycle, postsById }))
    .map((cycle) => withRun(cycle, cycle.cycleId ? runsByCycle.get(cycle.cycleId) ?? null : null));
  const seen = new Set(traced.map((cycle) => cycle.cycleId).filter(Boolean));

  // Cycles the buffer no longer reaches, rebuilt from whatever durable evidence
  // exists — a history row, a decision row, or both.
  const remembered = [];
  for (const cycleId of new Set([...runsByCycle.keys(), ...memoryByCycle.keys()])) {
    if (seen.has(cycleId)) continue;
    remembered.push(untracedCycle({
      cycleId,
      run: runsByCycle.get(cycleId) ?? null,
      decision: memoryByCycle.get(cycleId) ?? null,
      postsById,
    }));
  }

  const all = [...traced, ...remembered];
  // Newest first, on whichever timestamp the cycle actually has.
  all.sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0));
  return all.map((cycle, i) => ({ ...cycle, recency: i + 1 }));
}

/**
 * Attach a traced cycle's durable history row, filling only genuine gaps.
 *
 * Every `??` here reads a real backend value into a field the buffer could not
 * supply — the usual case being a cycle whose completion marker has aged out, so
 * the trace cannot say how it ended while the durable row can. Nothing already
 * known from the trace is overwritten, and nothing is computed: an absence that
 * both sources share stays an absence.
 */
function withRun(cycle, run) {
  if (!run) return { ...cycle, run: null };
  const failedFromStatus = run.status === 'failed' ? true : run.status === 'completed' ? false : null;
  return {
    ...cycle,
    run,
    at: cycle.at ?? run.startedAt ?? null,
    startedAt: cycle.startedAt ?? run.startedAt ?? null,
    completedAt: cycle.completedAt ?? run.completedAt ?? null,
    durationMs: cycle.durationMs ?? num(run.durationMs),
    outcome: cycle.outcome ?? run.outcome ?? null,
    failed: cycle.failed ?? failedFromStatus,
  };
}

/**
 * A cycle the activity buffer no longer covers, rebuilt from durable rows.
 *
 * Every stage is MISSING and `traced` is false, so the UI says the stage trace is
 * unavailable instead of implying the stages never ran. What the durable rows do
 * prove is kept: the history row's status, outcome, counts and duration, and the
 * memory row's reasoning. With no history row this degrades exactly as it did
 * before one existed — a postId is the only proof the cycle published.
 */
function untracedCycle({ cycleId, run, decision, postsById }) {
  const postId = decision?.postId ?? run?.postId ?? null;
  const failedFromStatus = run?.status === 'failed' ? true : run?.status === 'completed' ? false : null;
  return {
    cycleId,
    at: run?.startedAt ?? decision?.createdAt ?? null,
    startedAt: run?.startedAt ?? null,
    completedAt: run?.completedAt ?? null,
    durationMs: num(run?.durationMs),
    outcome: run?.outcome ?? (postId ? 'published' : null),
    failed: failedFromStatus,
    consecutiveFailures: null,
    nextDelayMs: null,
    nextCycleAt: null,
    partial: true,
    traced: false,
    run: run ?? null,
    stages: CYCLE_STAGES.map((meta) => ({
      ...meta, status: STAGE_STATUS.MISSING, at: null, headline: null, facts: [], code: null,
    })),
    notices: [],
    decision: decision ?? null,
    post: postId ? postsById.get(postId) ?? null : null,
    postId,
    events: [],
  };
}

/** Find a cycle by id in a built list — the selection lookup for the drawer. */
export function findCycle(cycles, cycleId) {
  if (!cycleId) return null;
  return cycles.find((cycle) => cycle.cycleId === cycleId) ?? null;
}
