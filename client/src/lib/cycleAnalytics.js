/**
 * Historical execution analytics, derived from the persistent cycle history.
 *
 * The input is whatever pages of GET /api/agent/:agentId/cycles the dashboard has
 * loaded — aggregate rows, one per execution, with no stage-by-stage trace. So
 * this module can say how often the agent publishes and how long a cycle takes;
 * it cannot say what happened inside one, and nothing here should be read as if
 * it could.
 *
 * Two rules govern every number below.
 *
 * 1. A missing measurement is `null`, never `0`. A cycle that died before
 *    discovery has no topic count; a row still marked `running` has no duration.
 *    Averaging those in as zeros would drag every figure toward a fiction, so
 *    each average carries the sample count it was computed from and the UI can
 *    show "Not available" when that count is zero.
 *
 * 2. A rate needs an honest denominator. Success rate is measured only over
 *    cycles that actually reached an end (completed or failed) — an interrupted
 *    cycle is not a failure, because nobody knows what it would have done, and
 *    counting it as one would blame the agent for a redeploy.
 *
 * Everything is pure: rows in, plain object out, no clock and no fetch.
 */

/** What the UI shows in place of a number that does not exist. */
export const NOT_AVAILABLE = 'Not available';

/** Row status vocabulary, mirroring CYCLE_RUN_STATUS in the CycleRun model. */
export const RUN_STATUS = {
  running: { label: 'Running', tone: 'info' },
  completed: { label: 'Completed', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  interrupted: { label: 'Interrupted', tone: 'warn' },
};

/**
 * How a persisted status should be described.
 *
 * An unrecognised value is shown verbatim rather than relabelled, because
 * inventing a friendly name for it would hide that the backend reported
 * something this file has not been taught about. Absent is its own case.
 */
export function statusMeta(status) {
  if (RUN_STATUS[status]) return { ...RUN_STATUS[status], recorded: true };
  if (status === null || status === undefined || status === '') {
    return { label: 'Not recorded', tone: 'muted', recorded: false };
  }
  return { label: String(status), tone: 'muted', recorded: true };
}

/** A number only when it really is one — no coercion, so '' and null stay out. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Mean of the values that exist, plus how many there were.
 *
 * The sample count is returned alongside deliberately: an average over 2 of 40
 * cycles is a different claim from an average over all 40, and the caller has to
 * be able to tell the difference.
 */
function average(rows, read) {
  let sum = 0;
  let samples = 0;
  for (const row of rows) {
    const value = num(read(row));
    if (value === null) continue;
    sum += value;
    samples += 1;
  }
  return { value: samples === 0 ? null : sum / samples, samples };
}

/** A fraction of a subset, or null when the subset is empty. */
function rate(count, of) {
  return of === 0 ? null : count / of;
}

const isRow = (row) => row !== null && typeof row === 'object';

/**
 * Summarise the loaded execution history.
 *
 * @param {Array<object>} rows cycle rows from the history endpoint, any order.
 * @returns {{
 *   total: number, byStatus: object, byOutcome: object,
 *   successRate: number|null, successSamples: number,
 *   publishRate: number|null, publishSamples: number,
 *   avgDurationMs: number|null, durationSamples: number,
 *   avgLlmCalls: number|null, llmSamples: number,
 *   providerFailures: number, interrupted: number,
 *   latest: object|null,
 * }}
 */
export function summarizeCycleRuns(rows) {
  const list = Array.isArray(rows) ? rows.filter(isRow) : [];

  const byStatus = { running: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 };
  const byOutcome = { published: 0, duplicate: 0, idle: 0, failed: 0, paused: 0, unknown: 0 };
  let providerFailures = 0;

  for (const row of list) {
    // Object.hasOwn, not `in`: a row whose status happened to be "toString"
    // would otherwise hit Object.prototype and increment a bucket that does not
    // exist, turning every count in the summary into NaN.
    const status = row.status;
    if (status !== 'unknown' && Object.hasOwn(byStatus, status)) byStatus[status] += 1;
    else byStatus.unknown += 1;

    const outcome = row.outcome;
    if (outcome !== 'unknown' && Object.hasOwn(byOutcome, outcome)) byOutcome[outcome] += 1;
    else byOutcome.unknown += 1;

    // Any provider failure the cycle hit, including a rate limit the pipeline
    // absorbed into a skip. Counted from the code the backend recorded, so a
    // cycle that never touched a provider cannot land here.
    if (typeof row.providerFailureCode === 'string' && row.providerFailureCode) {
      providerFailures += 1;
    }
  }

  // Cycles that reached a verdict. `running` is still in flight and
  // `interrupted` was cut short by a restart; neither is evidence either way.
  const finished = byStatus.completed + byStatus.failed;

  // Publish rate is over cycles that recorded an outcome at all. A cycle that
  // deliberately published nothing belongs in this denominator — choosing not to
  // publish is the editorial standard working, and hiding those cycles would
  // turn the rate into a meaningless 100%.
  const withOutcome = list.length - byOutcome.unknown;

  const duration = average(list, (row) => row.durationMs);
  const llm = average(list, (row) => row.llmCalls);

  return {
    // How many rows are loaded — not the agent's lifetime cycle count. History
    // begins when this collection did, and the list is paginated, so the caller
    // must label this as what it is.
    total: list.length,
    byStatus,
    byOutcome,
    successRate: rate(byStatus.completed, finished),
    successSamples: finished,
    publishRate: rate(byOutcome.published, withOutcome),
    publishSamples: withOutcome,
    avgDurationMs: duration.value,
    durationSamples: duration.samples,
    avgLlmCalls: llm.value,
    llmSamples: llm.samples,
    providerFailures,
    interrupted: byStatus.interrupted,
    latest: latestRun(list),
  };
}

/**
 * The most recent run in the loaded set, by real start time.
 *
 * The endpoint already sorts newest first, but this does not assume it: a caller
 * that concatenated pages out of order would otherwise report the wrong "latest
 * cycle status", which is the one figure an operator reads as current. Rows with
 * an unparseable startedAt cannot be ordered and so cannot win.
 */
export function latestRun(rows) {
  const list = Array.isArray(rows) ? rows.filter(isRow) : [];
  let best = null;
  let bestAt = -Infinity;
  for (const row of list) {
    const at = Date.parse(row.startedAt);
    if (Number.isNaN(at)) continue;
    if (at > bestAt) {
      bestAt = at;
      best = row;
    }
  }
  return best;
}

/**
 * A fraction as a whole-number percentage, or the honest absence.
 *
 * Rounded to a whole percent because the underlying sample is small — one digit
 * of decimal on a rate over eleven cycles implies a precision it does not have.
 */
export function formatRate(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  return `${Math.round(value * 100)}%`;
}

/** A count as text, or the honest absence. Zero is a real answer and prints as 0. */
export function formatCount(value) {
  return num(value) === null ? NOT_AVAILABLE : String(value);
}

/**
 * An average LLM-call count, kept to one decimal.
 *
 * A cycle spends one call to decide and a second to write, so the interesting
 * information is entirely in the fraction: "1.4" says most cycles decline to
 * publish, and rounding it to "1" would erase the agent's editorial restraint.
 */
export function formatAverage(value) {
  if (num(value) === null) return NOT_AVAILABLE;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
