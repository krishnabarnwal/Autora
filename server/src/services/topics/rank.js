/**
 * Candidate ranking (Phase 7).
 *
 * Deterministic scoring only: relevance, freshness, source authority,
 * corroboration, and a little substance. No LLM — the model's judgment is
 * expensive and is spent once, in Phase 9, on a short list this produces.
 *
 * Ties break on stable keys (normalized topic, then URL) so the same input
 * always yields the same order.
 */

export const WEIGHTS = {
  relevance: 0.42,
  freshness: 0.22,
  authority: 0.18,
  corroboration: 0.10,
  substance: 0.08,
};

const FRESHNESS_HALF_LIFE_MS = 18 * 60 * 60 * 1000;
/** Undated items are treated as roughly a day old rather than discarded. */
const UNDATED_AGE_MS = 24 * 60 * 60 * 1000;

/** 1.0 at publication, decaying by half every FRESHNESS_HALF_LIFE_MS. */
export function freshnessScore(ageMs) {
  const age = Number.isFinite(ageMs) && ageMs !== null ? Math.max(0, ageMs) : UNDATED_AGE_MS;
  return 2 ** (-age / FRESHNESS_HALF_LIFE_MS);
}

/** Diminishing returns: the second outlet matters far more than the fifth. */
function corroborationScore(count = 1) {
  return Math.min(1, Math.log2(Math.max(1, count) + 1) / Math.log2(5));
}

/** Enough description to write from, without rewarding pasted full articles. */
function substanceScore(item) {
  const summaryLength = item.summary?.length || 0;
  const summary = Math.min(1, summaryLength / 320);
  const titleWords = String(item.title || '').trim().split(/\s+/).length;
  const title = titleWords >= 6 && titleWords <= 22 ? 1 : 0.6;
  return summary * 0.7 + title * 0.3;
}

/**
 * Score one candidate. Component scores are kept on the item so the dashboard
 * can explain the ordering instead of showing an unexplained number.
 */
export function scoreCandidate(item, now = Date.now()) {
  const ageMs = item.ageMs ?? (item.publishedAt ? now - Date.parse(item.publishedAt) : null);

  const components = {
    relevance: Math.min(1, Math.max(0, item.relevance ?? 0)),
    freshness: freshnessScore(ageMs),
    authority: Math.min(1, Math.max(0, item.quality ?? 0.4)),
    corroboration: corroborationScore(item.corroboration ?? 1),
    substance: substanceScore(item),
  };

  const score = Object.entries(WEIGHTS).reduce(
    (total, [key, weight]) => total + weight * components[key],
    0
  );

  return {
    ...item,
    ageMs,
    score: Number(score.toFixed(4)),
    scoreComponents: Object.fromEntries(
      Object.entries(components).map(([key, value]) => [key, Number(value.toFixed(3))])
    ),
  };
}

/**
 * Rank candidates and return the best few.
 *
 * @param {object[]} items deduplicated items
 * @param {{limit?: number, now?: number, maxPerSource?: number}} options
 * @returns {object[]} highest score first
 */
export function rankCandidates(items = [], options = {}) {
  const { limit = 8, now = Date.now(), maxPerSource = 3 } = options;

  const scored = items
    .map((item) => scoreCandidate(item, now))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const byTopic = String(a.normalizedTopic || a.title).localeCompare(String(b.normalizedTopic || b.title));
      return byTopic !== 0 ? byTopic : String(a.url).localeCompare(String(b.url));
    });

  // Source diversity: one outlet having a good day should not fill the whole
  // shortlist, since the editorial call then has nothing to choose between.
  const perSource = new Map();
  const picked = [];
  const overflow = [];

  for (const item of scored) {
    const used = perSource.get(item.source) || 0;
    if (used >= maxPerSource) {
      overflow.push(item);
      continue;
    }
    perSource.set(item.source, used + 1);
    picked.push(item);
    if (picked.length >= limit) break;
  }

  // Only backfill from the overflow if diversity left the shortlist short.
  if (picked.length < limit) picked.push(...overflow.slice(0, limit - picked.length));

  return picked.map((item, index) => ({ ...item, rank: index + 1 }));
}
