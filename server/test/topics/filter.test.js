import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../../src/services/sources/rssParser.js';
import { normalizeItems } from '../../src/services/sources/normalize.js';
import { RSS_SECURITY, NOW } from '../fixtures/feeds.js';
import { filterTopics, assessQuality, DEFAULT_MAX_AGE_MS, DEFAULT_MIN_RELEVANCE } from '../../src/services/topics/filter.js';
import { buildPersonaProfile } from '../../src/services/topics/relevance.js';

const SENTINEL = {
  name: 'Sentinel',
  domain: 'AI Security',
  interests: ['prompt injection', 'LLM vulnerabilities', 'agent security', 'model security', 'AI infrastructure security'],
};

/** The six usable items from the fixture feed, filtered once against Sentinel. */
function fixtureItems() {
  const { entries } = parseFeed(RSS_SECURITY);
  return normalizeItems(entries, {
    name: 'Example Security News', url: 'https://security.example.com', tier: 'secondary', tags: ['security'],
  }, NOW);
}

test('filter: drops invalid, stale and irrelevant items; keeps relevant fresh ones', () => {
  const { kept, rejected, stats } = filterTopics(fixtureItems(), { persona: SENTINEL, now: NOW });

  assert.equal(stats.received, 6);
  assert.equal(stats.rejected, 3);
  assert.equal(stats.kept, 3);
  assert.equal(stats.stale, 1, 'the March 2025 analysis is too old');
  assert.equal(stats.low_quality, 1, 'the sponsored webinar is marketing, not a story');
  assert.equal(stats.irrelevant, 1, 'the pastry story is off-domain');
  assert.equal(stats.invalid, 0);

  const titles = kept.map((item) => item.title);
  assert.ok(titles.some((title) => title.includes('Indirect prompt injection')));
  assert.ok(titles.some((title) => title.includes('inference server')));
  assert.ok(titles.some((title) => title.includes('Guardrail bypass')));

  // Every kept item gained the contract fields for Phase 9.
  for (const item of kept) {
    assert.equal(typeof item.normalizedTopic, 'string');
    assert.ok(item.normalizedTopic.length > 0);
    assert.equal(typeof item.quality, 'number');
    assert.equal(typeof item.relevance, 'number');
    assert.ok(item.relevance > 0);
    assert.ok(Array.isArray(item.matchedTerms));
  }

  // The sponsored webinar is marketing, not a story.
  const lowValue = rejected.find((entry) => entry.reason === 'low_value_title');
  assert.equal(lowValue.title, 'Sponsored: buy our AI firewall webinar bundle today');
  assert.equal(lowValue.url, 'https://security.example.com/promo/webinar');
  assert.equal(lowValue.source, 'Example Security News');
});

test('filter: staleness boundary is exact — maxAgeMs old is dropped, just under is kept', () => {
  const items = [
    { title: 'Prompt injection attack on agentic systems disclosed', url: 'https://a.example.com/1', summary: 's', publishedAt: new Date(NOW - DEFAULT_MAX_AGE_MS - 1000).toISOString(), source: 'X', sourceTier: 'primary', sourceTags: ['security'] },
    { title: 'Another prompt injection incident reported this week', url: 'https://a.example.com/2', summary: 's', publishedAt: new Date(NOW - DEFAULT_MAX_AGE_MS + 1000).toISOString(), source: 'X', sourceTier: 'primary', sourceTags: ['security'] },
  ];
  const { stats } = filterTopics(items, { persona: SENTINEL, now: NOW });
  assert.equal(stats.stale, 1);
  assert.equal(stats.kept, 1);
});

test('filter: a missing date is kept by default and dropped with requireDate', () => {
  const undated = [
    { title: 'Undated paper on LLM watermarking schemes', url: 'https://a.example.com/undated', summary: 's', publishedAt: null, source: 'X', sourceTier: 'primary', sourceTags: ['security'] },
  ];
  const lenient = filterTopics(undated, { persona: SENTINEL, now: NOW });
  assert.equal(lenient.stats.kept, 1);
  assert.equal(lenient.kept[0].ageMs, null);

  const strict = filterTopics(undated, { persona: SENTINEL, now: NOW, requireDate: true });
  assert.equal(strict.stats.kept, 0);
  assert.equal(strict.stats.missing_date, 1);
  assert.equal(strict.rejected[0].reason, 'missing_date');
});

test('filter: relevance depends on the persona, not a hard-coded domain', () => {
  const items = fixtureItems();
  const securityNews = filterTopics(items, {
    persona: { name: 'Ada', domain: 'Zero Trust Networking' }, now: NOW,
  });
  const physics = filterTopics(items, {
    persona: { name: 'Max', domain: 'Quantum Physics' }, now: NOW,
  });

  // The fixture feed is security news: the networking persona sees some,
  // the physics persona sees essentially none.
  assert.ok(securityNews.stats.kept <= 2, `expected at most 2, got ${securityNews.stats.kept}`);
  assert.equal(physics.stats.kept, 0, `physics persona saw ${physics.stats.kept} items`);
});

test('filter: minRelevance controls how strict the gate is', () => {
  const items = fixtureItems();
  const permissive = filterTopics(items, { persona: SENTINEL, now: NOW, minRelevance: 0.05 });
  const strict = filterTopics(items, { persona: SENTINEL, now: NOW, minRelevance: 0.8 });

  assert.ok(permissive.stats.kept > strict.stats.kept);
  // At a 0.05 bar even the bakery story squeaks through, which is precisely why
  // the default sits well above it.
  assert.equal(permissive.stats.kept, 4);
  assert.ok(permissive.kept.some((item) => item.title.includes('bakery')));

  // Raising the bar drops the weakest survivors first; the saturated
  // prompt-injection and inference-server RCE stories stay.
  assert.equal(strict.stats.kept, 2);
  assert.ok(!strict.kept.some((item) => item.title.includes('Guardrail bypass')));
});

test('assessQuality: rejects shorteners, index pages and thin titles', () => {
  const ok = assessQuality({
    title: 'A substantive headline about prompt injection research', url: 'https://example.com/posts/story', sourceTier: 'primary',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.quality, 1);

  const cases = [
    [{ title: 'Bitly link to a security story', url: 'https://bit.ly/abc123', sourceTier: 'primary' }, 'url_shortener'],
    [{ title: 'The category listing page', url: 'https://example.com/category/ai-security', sourceTier: 'primary' }, 'not_an_article'],
    [{ title: 'Short', url: 'https://example.com/posts/story', sourceTier: 'primary' }, 'title_too_short'],
    [{ title: 'Join our free webinar on securing AI systems', url: 'https://example.com/posts/w', sourceTier: 'primary' }, 'low_value_title'],
    [{ title: 'Full title that is perfectly fine', url: '', sourceTier: 'primary' }, 'missing_fields'],
  ];
  for (const [item, reason] of cases) {
    assert.equal(assessQuality(item).reason, reason);
  }
});

test('filter: defaults are exported and reachable by later phases', () => {
  assert.equal(DEFAULT_MAX_AGE_MS, 72 * 60 * 60 * 1000);
  assert.ok(DEFAULT_MIN_RELEVANCE > 0 && DEFAULT_MIN_RELEVANCE < 1);
  const profile = buildPersonaProfile(SENTINEL);
  assert.ok(profile.core.size > 0);
  assert.ok(profile.concepts.includes('ai-security'));
});
