/**
 * Source collection (Phase 6).
 *
 * Fetches every configured source concurrently and returns one flat list of
 * normalized topics. No LLM call, no database write, no HTTP route: this layer
 * is callable from a script, a test, or the scheduler with equal ease.
 */
import { logger } from '../../utils/logger.js';
import { runPooled, DEFAULT_TIMEOUT_MS } from './http.js';
import { buildSources, SOURCE_DEFINITIONS } from './registry.js';

const log = logger('SOURCE');

const DEFAULT_CONCURRENCY = 6;
/** Per-source cap so one prolific feed cannot crowd out the rest. */
const DEFAULT_PER_SOURCE_LIMIT = 25;

/**
 * Collect topics from every source.
 *
 * @param {{
 *   sources?: Array<object>, only?: string[], exclude?: string[],
 *   timeoutMs?: number, concurrency?: number, perSourceLimit?: number,
 *   now?: number, fetchImpl?: Function, agentId?: string
 * }} options
 * @returns {Promise<{items: object[], results: object[], stats: object}>}
 */
export async function collectTopics(options = {}) {
  const {
    sources = buildSources({ only: options.only, exclude: options.exclude }),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = DEFAULT_CONCURRENCY,
    perSourceLimit = DEFAULT_PER_SOURCE_LIMIT,
    now = Date.now(),
    fetchImpl,
    agentId,
  } = options;

  const startedAt = Date.now();
  log.info(`Fetching ${sources.length} sources`, {
    agentId,
    concurrency,
    timeoutMs,
    sources: sources.map((source) => source.id),
  });

  const tasks = sources.map((source) => async () => {
    const sourceStartedAt = Date.now();
    log.debug(`Fetching ${source.name}`, { agentId, sourceId: source.id, kind: source.kind });

    try {
      const { items, rawCount } = await source.collect({ timeoutMs, now, fetchImpl });
      const kept = items.slice(0, perSourceLimit);
      log.info(`Received ${kept.length} items from ${source.name}`, {
        agentId,
        sourceId: source.id,
        raw: rawCount,
        normalized: items.length,
        kept: kept.length,
        durationMs: Date.now() - sourceStartedAt,
      });
      return { sourceId: source.id, source: source.name, ok: true, items: kept, rawCount };
    } catch (error) {
      // Isolated on purpose: one dead feed is a skipped source, not a failed cycle.
      log.warn(`Source failed: ${source.name}`, {
        agentId,
        sourceId: source.id,
        reason: error.code || error.name || 'error',
        message: error.message,
        durationMs: Date.now() - sourceStartedAt,
      });
      return {
        sourceId: source.id,
        source: source.name,
        ok: false,
        items: [],
        rawCount: 0,
        error: error.code || 'error',
        message: error.message,
      };
    }
  });

  // runPooled captures rejections, but collect() already handles its own, so a
  // rejection here means an adapter bug rather than an upstream failure.
  const settled = await runPooled(tasks, concurrency);
  const results = settled.map((outcome, index) =>
    outcome.ok
      ? outcome.value
      : {
          sourceId: sources[index]?.id || `source_${index}`,
          source: sources[index]?.name || 'unknown',
          ok: false,
          items: [],
          rawCount: 0,
          error: 'adapter_error',
          message: outcome.error?.message || 'Adapter threw',
        }
  );

  const items = results.flatMap((result) => result.items);
  const succeeded = results.filter((result) => result.ok).length;

  const stats = {
    sourcesAttempted: results.length,
    sourcesSucceeded: succeeded,
    sourcesFailed: results.length - succeeded,
    rawItems: results.reduce((total, result) => total + result.rawCount, 0),
    normalizedItems: items.length,
    durationMs: Date.now() - startedAt,
  };

  log.info(`Total normalized topics: ${items.length}`, { agentId, ...stats });

  if (!succeeded && results.length) {
    log.error('Every source failed; this cycle has nothing to work with', {
      agentId,
      failures: results.map((result) => `${result.sourceId}:${result.error}`),
    });
  }

  return { items, results, stats };
}

/** Registry overview for diagnostics and the future dashboard. */
export function listSources() {
  return SOURCE_DEFINITIONS.map(({ id, name, kind, tier, tags }) => ({ id, name, kind, tier, tags }));
}

export { defaultSources, buildSources, SOURCE_DEFINITIONS } from './registry.js';
export { createRssSource } from './rssAdapter.js';
export { createHackerNewsSource } from './hackerNewsAdapter.js';
export { parseFeed } from './rssParser.js';
export { normalizeItem, normalizeItems, normalizeDate, normalizeUrl } from './normalize.js';
export { fetchText, runPooled, DEFAULT_TIMEOUT_MS } from './http.js';
