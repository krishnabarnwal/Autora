/**
 * Deduplication (Phase 7).
 *
 * Three passes, cheapest first: identical canonical URL, identical normalized
 * topic, then token-overlap similarity for the same story told by two outlets.
 *
 * Duplicates are not merely dropped — the survivor records how many
 * independent sources carried the story. Wide coverage is a real signal that
 * something matters, and the ranker uses it.
 */
import { extractKeywords, jaccardSimilarity, containment, canonicalizeUrl, normalizeTopic } from '../../utils/text.js';

export const DEFAULT_SIMILARITY_THRESHOLD = 0.62;
/** Containment path: how much of the shorter headline the longer one covers. */
export const DEFAULT_CONTAINMENT_THRESHOLD = 0.7;
/** Guards the containment path against short headlines overlapping by accident. */
const MIN_SHARED_KEYWORDS = 4;

/**
 * Two headlines describe the same story.
 *
 * Either broad token agreement (Jaccard), or the shorter headline being almost
 * entirely contained in the longer one. The second path is what catches an
 * abbreviation expanded into words — "RCE" against "remote code execution" —
 * where the two share no token at all yet everything around them matches.
 */
function isSameStory(a, b, { similarityThreshold, containmentThreshold }) {
  if (jaccardSimilarity(a, b) >= similarityThreshold) return true;
  const shared = Math.round(containment(a, b) * Math.min(new Set(a).size, new Set(b).size));
  return shared >= MIN_SHARED_KEYWORDS && containment(a, b) >= containmentThreshold;
}

/** Prefer the more authoritative, more on-topic, better-described report. */
function isBetter(candidate, incumbent) {
  const byQuality = (candidate.quality ?? 0) - (incumbent.quality ?? 0);
  if (byQuality !== 0) return byQuality > 0;

  const byRelevance = (candidate.relevance ?? 0) - (incumbent.relevance ?? 0);
  if (Math.abs(byRelevance) > 0.001) return byRelevance > 0;

  const bySummary = (candidate.summary?.length ?? 0) - (incumbent.summary?.length ?? 0);
  if (bySummary !== 0) return bySummary > 0;

  // Tie-break on the earlier report, then on URL so the result is stable.
  const candidateTime = candidate.publishedAt ? Date.parse(candidate.publishedAt) : Infinity;
  const incumbentTime = incumbent.publishedAt ? Date.parse(incumbent.publishedAt) : Infinity;
  if (candidateTime !== incumbentTime) return candidateTime < incumbentTime;
  return String(candidate.url) < String(incumbent.url);
}

/** Fold a losing duplicate's provenance into the survivor. */
function absorb(survivor, loser) {
  const sources = new Set(survivor.corroboratedBy || [survivor.source]);
  for (const source of loser.corroboratedBy || [loser.source]) if (source) sources.add(source);
  survivor.corroboratedBy = [...sources];
  survivor.corroboration = survivor.corroboratedBy.length;
  // Keep the fuller description even when it came from the losing copy.
  if ((loser.summary?.length || 0) > (survivor.summary?.length || 0)) survivor.summary = loser.summary;
  return survivor;
}

function keywordsOf(item) {
  if (!item.__keywords) {
    Object.defineProperty(item, '__keywords', {
      value: extractKeywords(item.title, 12),
      enumerable: false,
      configurable: true,
    });
  }
  return item.__keywords;
}

/**
 * Collapse duplicate topics.
 *
 * @param {object[]} items filtered items
 * @param {{similarityThreshold?: number}} options
 * @returns {{unique: object[], duplicates: Array<object>, stats: object}}
 */
export function deduplicateTopics(items = [], options = {}) {
  const {
    similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
    containmentThreshold = DEFAULT_CONTAINMENT_THRESHOLD,
  } = options;
  const thresholds = { similarityThreshold, containmentThreshold };

  const duplicates = [];
  const counts = { duplicate_url: 0, duplicate_title: 0, similar_topic: 0 };

  const note = (item, reason, keptUrl) => {
    counts[reason] += 1;
    duplicates.push({ title: item.title, url: item.url, source: item.source, reason, keptUrl });
  };

  // Pass 1 — identical canonical URL.
  const byUrl = new Map();
  for (const raw of items) {
    const item = { ...raw, corroboratedBy: raw.corroboratedBy || [raw.source], corroboration: raw.corroboration || 1 };
    const key = canonicalizeUrl(item.url);
    const incumbent = byUrl.get(key);
    if (!incumbent) {
      byUrl.set(key, item);
      continue;
    }
    if (isBetter(item, incumbent)) {
      byUrl.set(key, absorb(item, incumbent));
      note(incumbent, 'duplicate_url', item.url);
    } else {
      absorb(incumbent, item);
      note(item, 'duplicate_url', incumbent.url);
    }
  }

  // Pass 2 — identical normalized topic. Catches the same headline reposted at
  // a different URL, and casing/spacing/word-order variants of one title.
  const byTopic = new Map();
  for (const item of byUrl.values()) {
    const key = item.normalizedTopic || normalizeTopic(item.title);
    const incumbent = byTopic.get(key);
    if (!incumbent) {
      byTopic.set(key, item);
      continue;
    }
    if (isBetter(item, incumbent)) {
      byTopic.set(key, absorb(item, incumbent));
      note(incumbent, 'duplicate_title', item.url);
    } else {
      absorb(incumbent, item);
      note(item, 'duplicate_title', incumbent.url);
    }
  }

  // Pass 3 — near-duplicates: two outlets covering one story with different wording.
  const unique = [];
  for (const item of byTopic.values()) {
    const match = unique.find((accepted) => isSameStory(keywordsOf(item), keywordsOf(accepted), thresholds));
    if (!match) {
      unique.push(item);
      continue;
    }
    if (isBetter(item, match)) {
      unique[unique.indexOf(match)] = absorb(item, match);
      note(match, 'similar_topic', item.url);
    } else {
      absorb(match, item);
      note(item, 'similar_topic', match.url);
    }
  }

  return {
    unique,
    duplicates,
    stats: { received: items.length, unique: unique.length, removed: duplicates.length, ...counts },
  };
}
