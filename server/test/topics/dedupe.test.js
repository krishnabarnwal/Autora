import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateTopics } from '../../src/services/topics/dedupe.js';
import { rankCandidates, scoreCandidate, freshnessScore, WEIGHTS } from '../../src/services/topics/rank.js';
import { NOW } from '../fixtures/feeds.js';

/** Minimal filtered-item shape, with sane defaults. */
function item(overrides = {}) {
  return {
    title: 'Indirect prompt injection lets attackers exfiltrate data from AI agents',
    url: 'https://a.example.com/story',
    summary: 'A poisoned page steers an agent into leaking private data.',
    publishedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    source: 'Source A',
    sourceTier: 'secondary',
    normalizedTopic: 'agents attackers data exfiltrate indirect injection lets prompt',
    quality: 0.75,
    relevance: 0.8,
    ageMs: 60 * 60 * 1000,
    ...overrides,
  };
}

test('dedupe: identical canonical URLs collapse to one', () => {
  const { unique, stats, duplicates } = deduplicateTopics([
    item({ url: 'https://a.example.com/story?utm_source=rss' }),
    item({ url: 'http://www.a.example.com/story#section', source: 'Source B', title: 'A different headline for the same page' }),
  ]);

  assert.equal(unique.length, 1);
  assert.equal(stats.duplicate_url, 1);
  assert.equal(duplicates[0].reason, 'duplicate_url');
  // Provenance is preserved rather than thrown away.
  assert.equal(unique[0].corroboration, 2);
  assert.deepEqual(unique[0].corroboratedBy.sort(), ['Source A', 'Source B']);
});

test('dedupe: case, spacing and word order do not create separate topics', () => {
  const base = 'Indirect prompt injection lets attackers exfiltrate data from AI agents';
  const { unique, stats } = deduplicateTopics([
    item({ url: 'https://a.example.com/1', title: base }),
    item({ url: 'https://b.example.com/2', title: base.toUpperCase(), source: 'Source B' }),
    item({ url: 'https://c.example.com/3', title: `  ${base.replace(/ /g, '   ')}  `, source: 'Source C' }),
    item({ url: 'https://d.example.com/4', title: 'Attackers exfiltrate data from AI agents using indirect prompt injection', source: 'Source D' }),
  ]);

  assert.equal(unique.length, 1, 'all four are the same story');
  assert.equal(stats.duplicate_title, 3);
  assert.equal(unique[0].corroboration, 4);
});

test('dedupe: reworded coverage of one story is caught by similarity', () => {
  const { unique, stats } = deduplicateTopics([
    item({ url: 'https://a.example.com/1', title: 'Critical RCE in a popular inference server hits GPU clusters' }),
    item({
      url: 'https://b.example.com/2', source: 'Source B',
      title: 'Critical remote code execution flaw in popular inference server threatens GPU clusters',
      normalizedTopic: 'clusters code critical execution flaw gpu inference popular remote server threatens',
    }),
  ]);

  assert.equal(unique.length, 1);
  assert.equal(stats.similar_topic, 1);
  assert.equal(unique[0].corroboration, 2);
});

test('dedupe: genuinely different stories are left alone', () => {
  const { unique, stats } = deduplicateTopics([
    item({ url: 'https://a.example.com/1', title: 'Indirect prompt injection lets attackers exfiltrate data', normalizedTopic: 'attackers data exfiltrate indirect injection lets prompt' }),
    item({ url: 'https://b.example.com/2', title: 'Data poisoning attacks against fine-tuned language models', normalizedTopic: 'against attacks data fine language models poisoning tuned', source: 'Source B' }),
    item({ url: 'https://c.example.com/3', title: 'EU regulators publish guidance on model transparency reporting', normalizedTopic: 'guidance model publish regulators reporting transparency', source: 'Source C' }),
  ]);

  assert.equal(unique.length, 3);
  assert.equal(stats.removed, 0);
  assert.ok(unique.every((entry) => entry.corroboration === 1));
});

test('dedupe: the survivor is the most authoritative copy', () => {
  const { unique } = deduplicateTopics([
    item({ url: 'https://aggregator.example.com/repost', source: 'Aggregator', quality: 0.5 }),
    item({ url: 'https://vendor.example.com/advisory', source: 'Vendor PSIRT', quality: 1, title: 'Indirect prompt injection lets attackers exfiltrate data from AI agents' }),
  ]);

  assert.equal(unique.length, 1);
  assert.equal(unique[0].source, 'Vendor PSIRT');
  assert.equal(unique[0].quality, 1);
});

test('dedupe: the fuller summary survives even from the losing copy', () => {
  const long = 'A far more detailed description of the same disclosure, with the mechanism spelled out.';
  const { unique } = deduplicateTopics([
    item({ url: 'https://a.example.com/1', quality: 1, summary: 'Short.' }),
    item({ url: 'https://a.example.com/1', quality: 0.5, summary: long, source: 'Source B' }),
  ]);
  assert.equal(unique[0].summary, long);
});

test('dedupe: output order and content are deterministic', () => {
  const input = [
    item({ url: 'https://a.example.com/1', title: 'Data poisoning attacks against fine-tuned language models', normalizedTopic: 'against attacks data fine language models poisoning tuned' }),
    item({ url: 'https://b.example.com/2', title: 'Agent sandbox escape through tool-calling confusion', normalizedTopic: 'agent calling confusion escape sandbox through tool', source: 'Source B' }),
    item({ url: 'https://c.example.com/3', source: 'Source C' }),
  ];
  const first = deduplicateTopics(input);
  const second = deduplicateTopics(input);
  assert.deepEqual(
    first.unique.map((entry) => entry.url),
    second.unique.map((entry) => entry.url)
  );
});

test('dedupe: an empty input is not an error', () => {
  const { unique, duplicates, stats } = deduplicateTopics([]);
  assert.deepEqual(unique, []);
  assert.deepEqual(duplicates, []);
  assert.equal(stats.unique, 0);
});

test('rank: weights sum to 1 so the score stays a 0..1 scale', () => {
  const total = Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
});

test('rank: freshness decays with age and never leaves 0..1', () => {
  assert.equal(freshnessScore(0), 1);
  assert.ok(freshnessScore(18 * 60 * 60 * 1000) > 0.49 && freshnessScore(18 * 60 * 60 * 1000) < 0.51);
  assert.ok(freshnessScore(72 * 60 * 60 * 1000) < 0.1);
  // An undated item is discounted, not eliminated.
  assert.ok(freshnessScore(null) > 0 && freshnessScore(null) < 1);
});

test('rank: a more relevant, fresher, better-sourced story wins', () => {
  const strong = scoreCandidate(item({ relevance: 0.95, quality: 1, ageMs: 30 * 60 * 1000, corroboration: 3 }), NOW);
  const weak = scoreCandidate(item({ relevance: 0.3, quality: 0.5, ageMs: 60 * 60 * 60 * 1000, corroboration: 1 }), NOW);
  assert.ok(strong.score > weak.score, `${strong.score} should beat ${weak.score}`);
  assert.ok(strong.score <= 1 && weak.score >= 0);
});

test('rank: score components are exposed so the ordering can be explained', () => {
  const scored = scoreCandidate(item(), NOW);
  assert.deepEqual(
    Object.keys(scored.scoreComponents).sort(),
    ['authority', 'corroboration', 'freshness', 'relevance', 'substance']
  );
});

test('rank: ranking is deterministic, including ties', () => {
  const items = Array.from({ length: 12 }, (_unused, index) =>
    item({ url: `https://a.example.com/${index}`, title: `Story number ${index} about prompt injection`, normalizedTopic: `injection number prompt story ${index}` })
  );
  const first = rankCandidates(items, { limit: 5, now: NOW });
  const second = rankCandidates([...items].reverse(), { limit: 5, now: NOW });
  assert.deepEqual(first.map((entry) => entry.url), second.map((entry) => entry.url));
  assert.deepEqual(first.map((entry) => entry.rank), [1, 2, 3, 4, 5]);
});

test('rank: the candidate limit is respected', () => {
  const items = Array.from({ length: 40 }, (_unused, index) =>
    item({ url: `https://a.example.com/${index}`, source: `Source ${index}`, title: `Distinct story ${index} on model security` })
  );
  assert.equal(rankCandidates(items, { limit: 8, now: NOW }).length, 8);
  assert.equal(rankCandidates(items, { limit: 5, now: NOW }).length, 5);
  assert.equal(rankCandidates([], { limit: 8, now: NOW }).length, 0);
  assert.equal(rankCandidates(items.slice(0, 3), { limit: 8, now: NOW }).length, 3);
});

test('rank: one prolific source cannot fill the whole shortlist', () => {
  const items = [
    ...Array.from({ length: 8 }, (_unused, index) =>
      item({ url: `https://loud.example.com/${index}`, source: 'Loud Source', relevance: 0.95, title: `Loud story ${index} about prompt injection` })),
    ...Array.from({ length: 3 }, (_unused, index) =>
      item({ url: `https://quiet.example.com/${index}`, source: `Quiet ${index}`, relevance: 0.5, title: `Quiet story ${index} about model security` })),
  ];

  const ranked = rankCandidates(items, { limit: 6, now: NOW, maxPerSource: 3 });
  const fromLoud = ranked.filter((entry) => entry.source === 'Loud Source').length;
  assert.equal(fromLoud, 3, 'the cap holds even though Loud Source scores highest');
  assert.equal(ranked.length, 6);
});

test('rank: diversity never shrinks the shortlist below the limit', () => {
  // Only one source exists, so the cap must yield rather than starve Phase 9.
  const items = Array.from({ length: 10 }, (_unused, index) =>
    item({ url: `https://only.example.com/${index}`, source: 'Only Source', title: `Story ${index} about agent security` })
  );
  assert.equal(rankCandidates(items, { limit: 5, now: NOW, maxPerSource: 2 }).length, 5);
});
