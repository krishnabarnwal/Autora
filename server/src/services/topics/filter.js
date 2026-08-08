/**
 * Local filtering (Phase 7): freshness, source quality, persona relevance.
 *
 * Pure and deterministic — same input, same output, no network, no LLM. Every
 * rejection records a reason so the dashboard can show what the agent turned
 * down and why, which is the visible half of editorial judgment.
 */
import { normalizeText, normalizeTopic } from '../../utils/text.js';
import { buildPersonaProfile, scoreRelevance } from './relevance.js';

export const DEFAULT_MAX_AGE_MS = 72 * 60 * 60 * 1000;
export const DEFAULT_MIN_RELEVANCE = 0.22;
const MIN_TITLE_WORDS = 4;

/** Authority weight per source tier, used here and by the ranker. */
export const TIER_QUALITY = { primary: 1, secondary: 0.75, aggregator: 0.5, unknown: 0.4 };

/** Titles that are marketing, housekeeping, or a digest rather than a story. */
const LOW_VALUE_TITLE = [
  /^(sponsored|advertisement|promoted|paid post)\b/,
  /\b(webinar|whitepaper|e-?book|free trial|discount|coupon|promo code)\b/,
  /\b(newsletter|podcast episode|week in review|weekly (wrap|recap|roundup|digest)|roundup|in case you missed)\b/,
  /\b(we'?re hiring|job opening|now hiring|careers at)\b/,
  /\b(top|best)\s+\d+\s/,
];

/** URL paths that are index pages, not articles. */
const NON_ARTICLE_PATH = /\/(tag|tags|category|categories|topics?|author|authors|about|contact|jobs|careers|events?|webinars?|newsletters?)(\/|$)/i;

/** Redirectors hide the real publisher, so authority cannot be judged. */
const SHORTENER_HOSTS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'buff.ly', 'lnkd.in', 'ift.tt', 'dlvr.it',
]);

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Structural and source-quality check.
 * @returns {{ok: boolean, reason?: string, quality: number}}
 */
export function assessQuality(item = {}) {
  const quality = TIER_QUALITY[item.sourceTier] ?? TIER_QUALITY.unknown;

  if (!item.title || !item.url) return { ok: false, reason: 'missing_fields', quality };

  const title = normalizeText(item.title);
  if (title.split(' ').filter(Boolean).length < MIN_TITLE_WORDS) {
    return { ok: false, reason: 'title_too_short', quality };
  }
  if (!normalizeTopic(item.title)) return { ok: false, reason: 'title_no_signal', quality };
  if (LOW_VALUE_TITLE.some((pattern) => pattern.test(title))) {
    return { ok: false, reason: 'low_value_title', quality };
  }

  const host = hostOf(item.url);
  if (!host) return { ok: false, reason: 'invalid_url', quality };
  if (SHORTENER_HOSTS.has(host)) return { ok: false, reason: 'url_shortener', quality };
  if (NON_ARTICLE_PATH.test(new URL(item.url).pathname)) {
    return { ok: false, reason: 'not_an_article', quality };
  }

  return { ok: true, quality };
}

/**
 * Reduce raw collected items to relevant, fresh, usable ones.
 *
 * @param {object[]} items normalized items from collectTopics()
 * @param {{
 *   persona?: object, profile?: object, now?: number, maxAgeMs?: number,
 *   minRelevance?: number, requireDate?: boolean
 * }} options
 * @returns {{kept: object[], rejected: Array<{title:string,url:string,source:string,reason:string}>, stats: object}}
 */
export function filterTopics(items = [], options = {}) {
  const {
    persona,
    profile = buildPersonaProfile(persona || {}),
    now = Date.now(),
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    minRelevance = DEFAULT_MIN_RELEVANCE,
    requireDate = false,
  } = options;

  const kept = [];
  const rejected = [];
  const counts = { invalid: 0, stale: 0, missing_date: 0, low_quality: 0, irrelevant: 0 };

  const reject = (item, reason, bucket) => {
    counts[bucket] += 1;
    rejected.push({ title: item?.title || '', url: item?.url || '', source: item?.source || '', reason });
  };

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      counts.invalid += 1;
      continue;
    }

    const quality = assessQuality(item);
    if (!quality.ok) {
      const bucket = ['missing_fields', 'invalid_url'].includes(quality.reason) ? 'invalid' : 'low_quality';
      reject(item, quality.reason, bucket);
      continue;
    }

    // Freshness. A missing date is not automatically fatal: some research feeds
    // omit it, and the ranker discounts the item instead.
    let ageMs = null;
    if (item.publishedAt) {
      ageMs = now - new Date(item.publishedAt).getTime();
      if (ageMs > maxAgeMs) {
        reject(item, 'stale', 'stale');
        continue;
      }
    } else if (requireDate) {
      reject(item, 'missing_date', 'missing_date');
      continue;
    }

    const relevance = scoreRelevance(item, profile);
    if (relevance.coreHits < 1 || relevance.score < minRelevance) {
      reject(item, 'irrelevant', 'irrelevant');
      continue;
    }

    kept.push({
      ...item,
      normalizedTopic: normalizeTopic(item.title),
      ageMs,
      quality: quality.quality,
      relevance: relevance.score,
      relevanceRaw: relevance.raw,
      matchedTerms: relevance.matched,
    });
  }

  return {
    kept,
    rejected,
    stats: { received: items.length, kept: kept.length, rejected: rejected.length, ...counts },
  };
}
