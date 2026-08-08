import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../../src/services/sources/rssParser.js';
import {
  RSS_SECURITY, ATOM_RESEARCH, MALFORMED_XML, NOT_A_FEED, EMPTY_FEED,
} from '../fixtures/feeds.js';

test('parser: reads a well-formed RSS 2.0 feed', () => {
  const { feedTitle, entries } = parseFeed(RSS_SECURITY);
  assert.equal(feedTitle, 'Example Security News');
  assert.equal(entries.length, 10);

  const first = entries[0];
  assert.equal(first.title, 'Indirect prompt injection lets attackers exfiltrate data from AI agents');
  assert.match(first.url, /^https:\/\/security\.example\.com\/posts\/indirect-prompt-injection/);
  assert.equal(first.publishedAt, 'Fri, 07 Aug 2026 09:12:00 GMT');
  assert.deepEqual(first.categories, ['prompt injection', 'agents']);
});

test('parser: unwraps CDATA, strips HTML, decodes entities', () => {
  const [first, second] = parseFeed(RSS_SECURITY).entries;
  assert.equal(
    first.summary,
    "Researchers showed that a poisoned web page can steer an LLM agent into leaking a user's private data."
  );
  assert.ok(!first.summary.includes('<'), 'markup must not survive');
  // &amp; in the description must decode to a literal ampersand.
  assert.ok(second.summary.includes('execution & container escape'), second.summary);
});

test('parser: reads Atom, preferring rel="alternate" over rel="self"/"replies"', () => {
  const { feedTitle, entries } = parseFeed(ATOM_RESEARCH);
  assert.equal(feedTitle, 'Example Research Feed');
  assert.equal(entries.length, 3);
  assert.equal(entries[0].url, 'https://research.example.org/papers/data-poisoning');
  assert.equal(entries[0].publishedAt, '2026-08-07T04:30:00Z');
  // <updated> is the fallback when <published> is absent.
  assert.equal(entries[1].publishedAt, '2026-08-06T22:00:00Z');
  assert.equal(entries[2].publishedAt, '', 'no date anywhere means an empty string, not a throw');
});

test('parser: decodes escaped HTML in Atom <content>', () => {
  const [, second] = parseFeed(ATOM_RESEARCH).entries;
  assert.equal(second.summary, 'An adversary with query access can determine whether a document was in the index.');
});

test('parser: recovers what it can from a truncated feed', () => {
  const { entries } = parseFeed(MALFORMED_XML);
  // The final <item> never closes, so no complete entry survives - and that is
  // a zero-entry result, not a crash.
  assert.equal(Array.isArray(entries), true);
  assert.equal(entries.length, 0);
});

test('parser: rejects a payload that is not a feed at all', () => {
  assert.throws(() => parseFeed(NOT_A_FEED), (err) => err.code === 'feed_unrecognized');
  assert.throws(() => parseFeed(''), (err) => err.code === 'feed_unrecognized');
  assert.throws(() => parseFeed(null), (err) => err.code === 'feed_unrecognized');
});

test('parser: an empty but valid feed yields zero entries', () => {
  const { feedTitle, entries } = parseFeed(EMPTY_FEED);
  assert.equal(feedTitle, 'Quiet Feed');
  assert.deepEqual(entries, []);
});

test('parser: channel title is not stolen from the first item', () => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>Channel Name</title>
    <item><title>Item Name</title><link>https://e.example.com/a</link></item>
  </channel></rss>`;
  const { feedTitle, entries } = parseFeed(feed);
  assert.equal(feedTitle, 'Channel Name');
  assert.equal(entries[0].title, 'Item Name');
});

test('parser: falls back to a URL-shaped guid when <link> is unusable', () => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>G</title>
    <item><title>Guid only entry about model security</title>
    <guid isPermaLink="true">https://guid.example.com/story</guid></item>
  </channel></rss>`;
  assert.equal(parseFeed(feed).entries[0].url, 'https://guid.example.com/story');
});

test('parser: handles namespaced elements', () => {
  const feed = `<?xml version="1.0"?>
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel><title>RDF Feed</title></channel>
    <item><title>RDF entry on adversarial machine learning</title>
      <link>https://rdf.example.com/story</link>
      <dc:date>2026-08-07T03:00:00Z</dc:date></item>
  </rdf:RDF>`;
  const { entries } = parseFeed(feed);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].publishedAt, '2026-08-07T03:00:00Z');
});
