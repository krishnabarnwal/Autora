/**
 * RSS/Atom source adapter.
 *
 * One factory, many feeds: every RSS-shaped source in the registry is an
 * instance of this adapter, so adding a feed is a config line, not new code.
 */
import { fetchText, DEFAULT_TIMEOUT_MS } from './http.js';
import { parseFeed } from './rssParser.js';
import { normalizeItems } from './normalize.js';

/**
 * @param {{id:string, name:string, url:string, tier?:string, tags?:string[], timeoutMs?:number}} definition
 * @returns {{id:string, name:string, kind:'rss', url:string, tier:string, tags:string[], collect:Function}}
 */
export function createRssSource(definition) {
  const { id, name, url, tier = 'secondary', tags = [], timeoutMs } = definition;
  if (!id || !name || !url) throw new Error('RSS source requires id, name and url');

  return {
    id,
    name,
    kind: 'rss',
    url,
    tier,
    tags,

    /**
     * @param {{timeoutMs?:number, now?:number, fetchImpl?:Function}} options
     * @returns {Promise<{items: object[], rawCount: number}>}
     */
    async collect(options = {}) {
      const { text } = await fetchText(url, {
        timeoutMs: options.timeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchImpl: options.fetchImpl,
      });

      const { entries } = parseFeed(text);
      const items = normalizeItems(entries, { name, url, tier, tags }, options.now ?? Date.now());
      return { items, rawCount: entries.length };
    },
  };
}
