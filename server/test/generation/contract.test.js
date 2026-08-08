import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERATION_FIELDS,
  FINAL_POST_FIELDS,
  buildGenerationSchema,
  buildFinalPostSchema,
  validateFinalPost,
  isValidHashtag,
  isHttpUrl,
} from '../../src/services/generation/schema.js';
import { validateSchema } from '../../src/services/llm/json.js';

/**
 * The FinalPost contract. The spec is strict: exact fields, no extras, and the
 * cross-field coherence a schema in this project's subset cannot express is
 * proven by validateFinalPost. These tests hold both layers to that line.
 */

/** A well-formed FinalPost the whole suite can perturb one field at a time. */
function finalPost(overrides = {}) {
  const text = 'A concrete, specific post body that comfortably clears the LinkedIn content floor of two hundred characters, '
    + 'so length checks exercise the real limit rather than tripping the minimum. It cites one real source only.';
  return {
    text,
    hook: 'A specific, non-clickbait opening line.',
    hashtags: ['#AISecurity', '#PromptInjection'],
    sourceUrls: ['https://research.example.org/disclosure'],
    characterCount: text.length,
    platform: 'linkedin',
    ...overrides,
  };
}

test('contract: the model schema asks for exactly the four creative fields', () => {
  const schema = buildGenerationSchema('linkedin');
  assert.deepEqual([...schema.required].sort(), [...GENERATION_FIELDS].sort());
  assert.equal(schema.additionalProperties, false);
  // The model is never asked for characterCount or platform — those are ours.
  assert.ok(!('characterCount' in schema.properties));
  assert.ok(!('platform' in schema.properties));
});

test('contract: the FinalPost schema is the strict six-field shape', () => {
  const schema = buildFinalPostSchema('twitter');
  assert.deepEqual([...schema.required].sort(), [...FINAL_POST_FIELDS].sort());
  assert.equal(schema.additionalProperties, false);
  // The platform enum is pinned to the single target, so a wrong platform fails.
  assert.deepEqual(schema.properties.platform.enum, ['twitter']);
});

test('contract: a valid FinalPost passes both the schema and the cross-field checks', () => {
  const post = finalPost();
  assert.ok(validateSchema(post, buildFinalPostSchema('linkedin')).valid);
  const { valid, errors } = validateFinalPost(post);
  assert.ok(valid, errors.join('; '));
});

test('contract: an extra field is rejected, never stripped and stored', () => {
  const { valid, errors } = validateFinalPost(finalPost({ sponsored: true }));
  assert.ok(!valid);
  assert.ok(errors.some((e) => /unexpected|additional|sponsored/i.test(e)), errors.join('; '));
});

test('contract: a missing required field fails', () => {
  const post = finalPost();
  delete post.hook;
  assert.ok(!validateFinalPost(post).valid);
});

test('contract: characterCount must equal the real text length', () => {
  const { valid, errors } = validateFinalPost(finalPost({ characterCount: 12 }));
  assert.ok(!valid);
  assert.ok(errors.some((e) => /characterCount .* does not match/.test(e)), errors.join('; '));
});

test('contract: a post over the platform limit fails on the exact limit', () => {
  // 2900 passes the runaway ceiling (maxChars*2) but breaches the real 3000 cap
  // only at 3001; check the boundary rather than a value miles past it.
  const okText = 'a'.repeat(3000);
  const okPost = finalPost({ text: okText, characterCount: okText.length });
  assert.ok(validateFinalPost(okPost).valid, 'exactly at the limit is allowed');

  const overText = 'a'.repeat(3001);
  const overPost = finalPost({ text: overText, characterCount: overText.length });
  const { valid, errors } = validateFinalPost(overPost);
  assert.ok(!valid);
  assert.ok(errors.some((e) => /exceeds the LinkedIn limit/.test(e)), errors.join('; '));
});

test('contract: twitter enforces its own tighter limit', () => {
  const text = 'a'.repeat(281);
  const post = finalPost({ text, characterCount: text.length, platform: 'twitter' });
  assert.ok(!validateFinalPost(post, 'twitter').valid);
});

test('contract: too many hashtags for the platform fails', () => {
  const post = finalPost({ hashtags: ['#a', '#b', '#c', '#d', '#e', '#f'] }); // 6 > linkedin's 5
  const { valid, errors } = validateFinalPost(post);
  assert.ok(!valid);
  assert.ok(errors.some((e) => /hashtags exceeds/.test(e)), errors.join('; '));
});

test('contract: isValidHashtag accepts real tags and rejects malformed ones', () => {
  for (const good of ['#AI', '#AISecurity', '#gpt5', '#a', '#prompt_injection', '#Café']) {
    assert.ok(isValidHashtag(good), good);
  }
  for (const bad of ['#', '##ai', '#has space', 'noHash', '#-lead', '#', '#a!', '', null, 42]) {
    assert.ok(!isValidHashtag(bad), JSON.stringify(bad));
  }
});

test('contract: isHttpUrl accepts http(s) and rejects everything else', () => {
  assert.ok(isHttpUrl('https://example.com/x'));
  assert.ok(isHttpUrl('http://example.com'));
  for (const bad of ['ftp://example.com', 'javascript:alert(1)', 'example.com', '', '   ', null, 'data:text/html,x']) {
    assert.ok(!isHttpUrl(bad), JSON.stringify(bad));
  }
});

test('contract: an invalid source URL in a FinalPost fails validation', () => {
  assert.ok(!validateFinalPost(finalPost({ sourceUrls: ['not-a-url'] })).valid);
});
