/**
 * Live source smoke check for Phase 6-7.
 *
 * Hits the real feeds over the network, so it is deliberately NOT part of
 * `npm test`: the suite must pass on a plane. Run it to confirm the configured
 * sources are still alive and the pipeline still narrows real news correctly.
 *
 * Touches no database and makes no LLM call.
 *
 * Usage: node src/scripts/smoke-sources.js [--json]
 */
import { discoverTopics, SENTINEL_PERSONA } from '../services/topics/index.js';
import { listSources } from '../services/sources/index.js';

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const asJson = process.argv.includes('--json');
  const sources = listSources();

  console.log('--- Live source smoke check (Phase 6-7) ---\n');
  console.log(`Registry: ${sources.length} sources`);
  for (const tier of ['primary', 'secondary', 'aggregator']) {
    const inTier = sources.filter((source) => source.tier === tier);
    console.log(`  ${tier.padEnd(11)} ${inTier.length}`);
  }
  console.log('');

  const started = Date.now();
  const outcome = await discoverTopics({ persona: SENTINEL_PERSONA, limit: 8 });
  const { candidates, stats, sourceResults, rejected, duplicates } = outcome;

  console.log('\n--- Per-source results ---');
  for (const result of sourceResults) {
    const status = result.ok ? `${String(result.items.length).padStart(3)} items` : `FAILED (${result.error})`;
    console.log(`  ${result.sourceId.padEnd(22)} ${status}`);
  }

  console.log('\n--- Pipeline ---');
  console.log(`  collected            ${stats.collected}`);
  console.log(`  after filtering      ${stats.filter.kept}   (rejected ${stats.filter.rejected})`);
  console.log(`     stale             ${stats.filter.stale}`);
  console.log(`     irrelevant        ${stats.filter.irrelevant}`);
  console.log(`     low quality       ${stats.filter.low_quality}`);
  console.log(`     invalid           ${stats.filter.invalid}`);
  console.log(`  after dedup          ${stats.dedupe.unique}   (removed ${stats.dedupe.removed})`);
  console.log(`  candidates           ${stats.candidates}`);
  console.log(`  LLM calls            ${stats.llmCalls}`);

  console.log('\n--- Candidates ---');
  for (const candidate of candidates) {
    console.log(`  ${String(candidate.score.toFixed(3))}  [${candidate.source}]  ${candidate.title}`);
    if (candidate.corroboration > 1) console.log(`         also covered by: ${candidate.sources.join(', ')}`);
  }

  console.log('\n--- Assertions ---');
  const half = Math.ceil(sourceResults.length / 2);
  check('at least half the sources responded',
    stats.collection.sourcesSucceeded >= half,
    `${stats.collection.sourcesSucceeded}/${sourceResults.length} ok`);
  check('collected a meaningful volume of articles', stats.collected >= 20, `${stats.collected} items`);
  check('filtering discarded the bulk of them',
    stats.filter.kept < stats.collected,
    `${stats.collected} -> ${stats.filter.kept}`);
  check('produced a small candidate set (1-10)',
    candidates.length >= 1 && candidates.length <= 10, `${candidates.length} candidates`);
  check('no LLM call was made', stats.llmCalls === 0);
  check('candidate URLs are unique',
    new Set(candidates.map((candidate) => candidate.url)).size === candidates.length);
  check('candidate topics are unique',
    new Set(candidates.map((candidate) => candidate.normalizedTopic)).size === candidates.length);
  check('candidates are newest-scored first',
    candidates.every((candidate, index) => index === 0 || candidates[index - 1].score >= candidate.score));
  check('every candidate has the contract fields',
    candidates.every((candidate) =>
      candidate.title && /^https:\/\//.test(candidate.url) && 'summary' in candidate
      && (candidate.publishedAt === null || !Number.isNaN(Date.parse(candidate.publishedAt)))
      && candidate.source));
  check('every candidate is on the persona\'s beat',
    candidates.every((candidate) => candidate.relevance > 0), 'relevance > 0');
  check('rejections carry reasons', rejected.every((entry) => Boolean(entry.reason)));
  check('completed well inside a demo cycle', Date.now() - started < 40_000, `${Date.now() - started}ms`);

  if (asJson) {
    console.log(`\n${JSON.stringify({ stats, candidates, duplicateCount: duplicates.length }, null, 2)}`);
  }

  console.log(`\n--- ${results.length - failed}/${results.length} passed ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSOURCE SMOKE CHECK FAILED:', err.message);
  process.exit(1);
});
