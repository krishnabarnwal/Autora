/**
 * Hacker News source adapter (Algolia public search API, no key required).
 *
 * Included to keep the source layer honest: the registry is not RSS-only, and
 * a second response format proves the adapter contract is the boundary rather
 * than an incidental XML detail. Also surfaces community signal (points) that
 * RSS feeds do not carry.
 *
 * Two traps this endpoint sets, both found by the live smoke check:
 *
 *  - `OR` is not a boolean operator here. Algolia treats the query as terms to
 *    match, so "AI security OR prompt injection" searches for the literal word
 *    "or" alongside everything else and matches almost nothing. Give each
 *    concept its own registry entry instead.
 *  - `search_by_date` returns the newest stories, which have not had time to
 *    accumulate points. A high `minPoints` on a by-date search therefore asks
 *    for something that cannot exist yet. Keep the bar low here; ranking in
 *    Phase 7 sorts on merit anyway.
 */
import { fetchText, DEFAULT_TIMEOUT_MS } from './http.js';
import { normalizeItems } from './normalize.js';

const ENDPOINT = 'https://hn.algolia.com/api/v1/search_by_date';

/**
 * @param {{id:string, name:string, query:string, minPoints?:number, hitsPerPage?:number,
 *          tier?:string, tags?:string[], timeoutMs?:number}} definition
 */
export function createHackerNewsSource(definition) {
  const {
    id,
    name,
    query,
    minPoints = 20,
    hitsPerPage = 30,
    tier = 'aggregator',
    tags = [],
    timeoutMs,
  } = definition;
  if (!id || !name || !query) throw new Error('Hacker News source requires id, name and query');

  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}`
    + `&tags=story&hitsPerPage=${hitsPerPage}&numericFilters=points>${minPoints}`;

  return {
    id,
    name,
    kind: 'hackernews',
    url,
    tier,
    tags,

    async collect(options = {}) {
      const { text } = await fetchText(url, {
        timeoutMs: options.timeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS,
        accept: 'application/json',
        fetchImpl: options.fetchImpl,
      });

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        const error = new Error('Hacker News response was not valid JSON');
        error.code = 'invalid_json';
        throw error;
      }

      const hits = Array.isArray(payload?.hits) ? payload.hits : [];
      // A story with no external URL is a text post; the discussion permalink
      // is still a citable source for it.
      const entries = hits.map((hit) => ({
        title: hit?.title || hit?.story_title || '',
        url: hit?.url || (hit?.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : ''),
        summary: hit?.story_text ? String(hit.story_text) : '',
        publishedAt: hit?.created_at || '',
        categories: Array.isArray(hit?._tags) ? hit._tags.filter((t) => !/^(story|author_|front_page)/.test(t)) : [],
      }));

      const items = normalizeItems(entries, { name, url: 'https://news.ycombinator.com', tier, tags },
        options.now ?? Date.now());
      return { items, rawCount: hits.length };
    },
  };
}
