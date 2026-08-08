import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTopic,
  extractKeywords,
  jaccardSimilarity,
  canonicalizeUrl,
} from '../src/utils/text.js';

/**
 * These helpers run before any LLM call, so their behaviour decides how much
 * the agent spends and whether it repeats itself.
 */

test('normalizeTopic: is order-independent and drops stopwords', () => {
  assert.equal(
    normalizeTopic('Prompt injection in autonomous agents'),
    normalizeTopic('Autonomous agents and prompt injection')
  );
  assert.equal(normalizeTopic('The New Model'), 'model');
});

test('normalizeTopic: strips punctuation, case, and diacritics', () => {
  assert.equal(normalizeTopic('GPT-5 vulnerability'), normalizeTopic('gpt 5 vulnerability!'));
  assert.equal(normalizeTopic('Café security'), 'cafe security');
});

test("normalizeTopic: possessives match their plain form", () => {
  // Without possessive handling these differ (openais vs openai) and the same
  // story slips through dedup twice.
  assert.equal(
    normalizeTopic("OpenAI's model registry"),
    normalizeTopic('OpenAI model registry')
  );
});

test('normalizeTopic: distinct topics stay distinct', () => {
  assert.notEqual(
    normalizeTopic('Prompt injection defenses'),
    normalizeTopic('Model weight exfiltration')
  );
});

test('normalizeTopic: handles empty and junk input without throwing', () => {
  assert.equal(normalizeTopic(''), '');
  assert.equal(normalizeTopic('   '), '');
  assert.equal(normalizeTopic('!!! ??? ---'), '');
});

test('extractKeywords: returns content words, not stopwords', () => {
  const keywords = extractKeywords(
    'A new benchmark for evaluating prompt injection defenses in retrieval systems'
  );
  assert.ok(keywords.includes('injection'));
  assert.ok(keywords.includes('benchmark'));
  assert.ok(!keywords.includes('for'));
  assert.ok(!keywords.includes('in'));
});

test('extractKeywords: respects the limit', () => {
  const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november';
  assert.equal(extractKeywords(text, 5).length, 5);
});

test('jaccardSimilarity: scores overlap correctly', () => {
  assert.equal(jaccardSimilarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccardSimilarity(['a', 'b'], ['c', 'd']), 0);
  assert.equal(jaccardSimilarity([], ['a']), 0);
  // {a,b,c} vs {b,c,d} -> 2 shared / 4 union
  assert.equal(jaccardSimilarity(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
});

test('canonicalizeUrl: strips tracking params, fragments, and www', () => {
  assert.equal(
    canonicalizeUrl('http://www.Example.com/post?utm_source=x&id=7#section'),
    'https://example.com/post?id=7'
  );
});

test('canonicalizeUrl: makes duplicate links from different feeds collide', () => {
  const a = canonicalizeUrl('https://example.com/a/');
  const b = canonicalizeUrl('http://www.example.com/a?utm_campaign=rss');
  assert.equal(a, b);
});

test('canonicalizeUrl: returns malformed input unchanged rather than throwing', () => {
  assert.equal(canonicalizeUrl('not a url'), 'not a url');
  assert.equal(canonicalizeUrl(''), '');
});
