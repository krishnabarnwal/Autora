/**
 * Raw feed entry -> the topic shape every downstream phase consumes.
 *
 * Nothing here reaches the network or an LLM: it is pure, so the filtering
 * tests can run offline and the agent pays no tokens for cleanup work.
 */
import { canonicalizeUrl } from '../../utils/text.js';

/** Entries older than this are almost certainly a feed replaying its archive. */
const MAX_REASONABLE_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_TITLE_LENGTH = 12;
const MAX_TITLE_LENGTH = 300;
const MAX_SUMMARY_LENGTH = 600;

/**
 * Parse a feed date. RSS uses RFC 822, Atom uses ISO 8601, and Date handles
 * both; anything else (or a date in the future) is treated as absent.
 */
export function normalizeDate(value, now = Date.now()) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const parsed = new Date(String(value).trim());
  const time = parsed.getTime();
  if (Number.isNaN(time)) return null;
  // Clock skew of a few minutes is normal; a date years ahead is bad data.
  if (time > now + 60 * 60 * 1000) return null;
  if (time < now - MAX_REASONABLE_AGE_MS) return parsed.toISOString();
  return parsed.toISOString();
}

/** Absolute https URL, tracking params removed, or '' when unusable. */
export function normalizeUrl(value, baseUrl = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const resolved = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    if (!['http:', 'https:'].includes(resolved.protocol)) return '';
    if (!resolved.hostname.includes('.')) return '';
    return canonicalizeUrl(resolved.toString());
  } catch {
    return '';
  }
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

function cleanSummary(value, title) {
  const summary = String(value || '').replace(/\s+/g, ' ').trim();
  // Feeds that repeat the headline as the description add no information.
  if (!summary || summary.toLowerCase() === String(title || '').toLowerCase()) return '';
  if (summary.length <= MAX_SUMMARY_LENGTH) return summary;
  const cut = summary.slice(0, MAX_SUMMARY_LENGTH);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return `${(lastStop > MAX_SUMMARY_LENGTH * 0.6 ? cut.slice(0, lastStop) : cut).trim()}...`;
}

/**
 * Normalize one raw entry, or return null when it cannot be used.
 *
 * Dropped: no usable title, no resolvable URL, or a title too short to judge.
 * Kept with `publishedAt: null`: entries whose date is missing or unparseable —
 * the freshness filter decides what to do with them, not the normalizer.
 *
 * @param {object} entry raw entry from parseFeed
 * @param {{name: string, url?: string, tier?: string, tags?: string[]}} source
 * @returns {{title:string,url:string,summary:string,publishedAt:string|null,source:string}|null}
 */
export function normalizeItem(entry, source = {}, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;

  const title = cleanTitle(entry.title);
  if (title.length < MIN_TITLE_LENGTH) return null;

  const url = normalizeUrl(entry.url, source.url || '');
  if (!url) return null;

  return {
    title,
    url,
    summary: cleanSummary(entry.summary, title),
    publishedAt: normalizeDate(entry.publishedAt, now),
    source: String(source.name || entry.source || 'unknown').trim() || 'unknown',
    // Retained for local ranking and relevance only; not part of the feed API.
    sourceTier: source.tier || 'unknown',
    sourceTags: Array.isArray(source.tags) ? source.tags : [],
    categories: Array.isArray(entry.categories) ? entry.categories.slice(0, 8) : [],
  };
}

/** Normalize a batch, dropping unusable entries. Order is preserved. */
export function normalizeItems(entries = [], source = {}, now = Date.now()) {
  const items = [];
  for (const entry of entries) {
    const item = normalizeItem(entry, source, now);
    if (item) items.push(item);
  }
  return items;
}
