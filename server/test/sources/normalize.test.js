import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem, normalizeItems, normalizeDate, normalizeUrl } from '../../src/services/sources/normalize.js';
import { parseFeed } from '../../src/services/sources/rssParser.js';
import { RSS_SECURITY, NOW } from '../fixtures/feeds.js';

const SOURCE = { name: 'Example Security News', url: 'https://security.example.com', tier: 'secondary', tags: ['security'] };

test('normalizeDate: parses RFC 822 and ISO 8601 into ISO UTC', () => {
  assert.equal(normalizeDate('Fri, 07 Aug 2026 09:12:00 GMT', NOW), '2026-08-07T09:12:00.000Z');
  assert.equal(normalizeDate('2026-08-07T04:30:00Z', NOW), '2026-08-07T04:30:00.000Z');
  assert.equal(normalizeDate(new Date('2026-08-07T04:30:00Z'), NOW), '2026-08-07T04:30:00.000Z');
});

test('normalizeDate: unusable dates become null rather than throwing', () => {
  assert.equal(normalizeDate('banana', NOW), null);
  assert.equal(normalizeDate('', NOW), null);
  assert.equal(normalizeDate(undefined, NOW), null);
  assert.equal(normalizeDate(new Date('nope'), NOW), null);
});

test('normalizeDate: a date far in the future is bad data, not fresh news', () => {
  assert.equal(normalizeDate('2030-01-01T00:00:00Z', NOW), null);
  // Small clock skew is tolerated.
  assert.ok(normalizeDate(new Date(NOW + 10 * 60_000).toISOString(), NOW));
});

test('normalizeUrl: canonicalizes and drops tracking parameters', () => {
  assert.equal(
    normalizeUrl('http://www.Example.com/story/?utm_source=rss&utm_medium=feed&id=7#top'),
    'https://example.com/story/?id=7'
  );
});

test('normalizeUrl: resolves relative links against the feed URL', () => {
  assert.equal(normalizeUrl('/posts/story', 'https://security.example.com/feed'), 'https://security.example.com/posts/story');
});

test('normalizeUrl: rejects unusable or non-http URLs', () => {
  assert.equal(normalizeUrl('not-a-url'), '');
  assert.equal(normalizeUrl('javascript:alert(1)'), '');
  assert.equal(normalizeUrl('mailto:someone@example.com'), '');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl(null), '');
});

test('normalizeItem: produces the documented topic shape', () => {
  const [entry] = parseFeed(RSS_SECURITY).entries;
  const item = normalizeItem(entry, SOURCE, NOW);

  assert.deepEqual(Object.keys(item).sort(), [
    'categories', 'publishedAt', 'source', 'sourceTags', 'sourceTier', 'summary', 'title', 'url',
  ]);
  assert.equal(item.title, 'Indirect prompt injection lets attackers exfiltrate data from AI agents');
  assert.equal(item.url, 'https://security.example.com/posts/indirect-prompt-injection');
  assert.equal(item.publishedAt, '2026-08-07T09:12:00.000Z');
  assert.equal(item.source, 'Example Security News');
  assert.ok(item.summary.length > 20);
});

test('normalizeItem: drops entries missing a title or a usable URL', () => {
  assert.equal(normalizeItem({ url: 'https://e.example.com/a', title: '' }, SOURCE, NOW), null);
  assert.equal(normalizeItem({ title: 'A perfectly good title about model security' }, SOURCE, NOW), null);
  assert.equal(normalizeItem({ title: 'Fine title about LLM security', url: 'javascript:alert(1)' }, SOURCE, NOW), null);
  // A bare path is not invalid: feeds legitimately publish relative links, and
  // they resolve against the feed URL.
  assert.equal(
    normalizeItem({ title: 'Fine title about LLM security', url: 'posts/story' }, SOURCE, NOW).url,
    'https://security.example.com/posts/story'
  );
  assert.equal(normalizeItem({ title: 'Short', url: 'https://e.example.com/a' }, SOURCE, NOW), null);
  assert.equal(normalizeItem(null, SOURCE, NOW), null);
  assert.equal(normalizeItem('nonsense', SOURCE, NOW), null);
});

test('normalizeItem: a missing date is kept as null, not a rejection', () => {
  const item = normalizeItem(
    { title: 'Agent sandbox escape through tool-calling confusion', url: 'https://e.example.com/a' },
    SOURCE, NOW
  );
  assert.ok(item);
  assert.equal(item.publishedAt, null);
});

test('normalizeItem: a description identical to the title carries no information', () => {
  const title = 'Guardrail bypass in a hosted LLM API leaks system prompts';
  const item = normalizeItem({ title, url: 'https://e.example.com/a', summary: title }, SOURCE, NOW);
  assert.equal(item.summary, '');
});

test('normalizeItem: long summaries are truncated', () => {
  const item = normalizeItem(
    { title: 'A long report on model security', url: 'https://e.example.com/a', summary: 'word '.repeat(400) },
    SOURCE, NOW
  );
  assert.ok(item.summary.length <= 604, `summary was ${item.summary.length}`);
  assert.ok(item.summary.endsWith('...'));
});

test('normalizeItems: drops every invalid entry and keeps the rest', () => {
  const { entries } = parseFeed(RSS_SECURITY);
  const items = normalizeItems(entries, SOURCE, NOW);

  assert.equal(entries.length, 10);
  assert.equal(items.length, 6, 'no title, no link, too-short title, and a javascript: link are all dropped');
  assert.ok(items.every((item) => item.title && item.url.startsWith('https://')));
  assert.ok(items.every((item) => item.source === SOURCE.name));
  // The entry whose pubDate is "banana" survives with a null date.
  assert.equal(items.filter((item) => item.publishedAt === null).length, 1);
});
