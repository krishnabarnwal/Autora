import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyGeneratedPost,
  allowedSourceUrls,
  findFabricatedUrls,
} from '../../src/services/generation/verify.js';
import { GenerationError, GENERATION_ERROR_CODES } from '../../src/services/generation/errors.js';
import { CANDIDATE, CANDIDATE_MULTI_URL, validGeneration } from '../fixtures/generation.js';

/**
 * Independent verification is the layer that decides what is publishable. The
 * schema already proved shape, so every test here is about coherence and — above
 * all — source integrity: the model may cite only the URL the candidate carried,
 * in the array and in the prose, and anything else fails closed.
 */

/** Assert a verification throws GenerationError with the expected taxonomy code. */
function assertFails(output, code, context = { candidate: CANDIDATE, platform: 'linkedin' }) {
  assert.throws(
    () => verifyGeneratedPost(output, context),
    (err) => {
      assert.ok(err instanceof GenerationError, `expected GenerationError, got ${err?.name}`);
      assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
      return true;
    }
  );
}

test('verify: a valid output assembles a FinalPost with computed metadata', () => {
  const post = verifyGeneratedPost(validGeneration(), { candidate: CANDIDATE, platform: 'linkedin' });
  assert.deepEqual(
    Object.keys(post).sort(),
    ['characterCount', 'hashtags', 'hook', 'platform', 'sourceUrls', 'text'].sort()
  );
  // characterCount and platform are ours, true by construction.
  assert.equal(post.characterCount, post.text.length);
  assert.equal(post.platform, 'linkedin');
  assert.deepEqual(post.sourceUrls, [CANDIDATE.url]);
});

test('verify: the body is trimmed before it is measured or stored', () => {
  const post = verifyGeneratedPost(validGeneration({ overrides: { text: `   ${validGeneration().text}   ` } }), {
    candidate: CANDIDATE, platform: 'linkedin',
  });
  assert.equal(post.text, post.text.trim());
  assert.equal(post.characterCount, post.text.length);
});

test('verify: an empty or whitespace-only body fails as verification_failed', () => {
  assertFails(validGeneration({ overrides: { text: '' } }), GENERATION_ERROR_CODES.VERIFICATION_FAILED);
  assertFails(validGeneration({ overrides: { text: '    ' } }), GENERATION_ERROR_CODES.VERIFICATION_FAILED);
});

test('verify: an over-limit body is the distinct too_long code, not a generic failure', () => {
  assertFails(validGeneration({ overrides: { text: 'x'.repeat(3001) } }), GENERATION_ERROR_CODES.TOO_LONG);
});

test('verify: a body under the platform content floor fails', () => {
  assertFails(validGeneration({ overrides: { text: 'Too short to be a post.' } }), GENERATION_ERROR_CODES.VERIFICATION_FAILED);
});

test('verify: an empty or over-long hook fails', () => {
  assertFails(validGeneration({ overrides: { hook: '' } }), GENERATION_ERROR_CODES.VERIFICATION_FAILED);
  assertFails(validGeneration({ overrides: { hook: 'y'.repeat(221) } }), GENERATION_ERROR_CODES.VERIFICATION_FAILED);
});

test('verify: an invalid hashtag or too many hashtags fails', () => {
  assertFails(validGeneration({ overrides: { hashtags: ['#ok', 'no hash'] } }), GENERATION_ERROR_CODES.VERIFICATION_FAILED);
  assertFails(validGeneration({ overrides: { hashtags: ['#a', '#b', '#c', '#d', '#e', '#f'] } }), GENERATION_ERROR_CODES.VERIFICATION_FAILED);
});

test('verify: a source not present in the candidate fails as invalid_source', () => {
  assertFails(
    validGeneration({ overrides: { sourceUrls: ['https://evil.example.com/made-up'] } }),
    GENERATION_ERROR_CODES.INVALID_SOURCE
  );
});

test('verify: citing no source at all fails as invalid_source', () => {
  assertFails(validGeneration({ overrides: { sourceUrls: [] } }), GENERATION_ERROR_CODES.INVALID_SOURCE);
});

test('verify: a non-URL value in sourceUrls fails as invalid_source', () => {
  assertFails(validGeneration({ overrides: { sourceUrls: ['see the link'] } }), GENERATION_ERROR_CODES.INVALID_SOURCE);
});

test('verify: the stored source is the candidate URL even when the model mutates it cosmetically', () => {
  // Same link with tracking params and a trailing slash — canonicalises to the
  // candidate's URL, so it is accepted, but the *stored* value is the candidate's
  // own string, not the model's decorated one.
  const decorated = `${CANDIDATE.url}/?utm_source=twitter`;
  const post = verifyGeneratedPost(validGeneration({ overrides: { sourceUrls: [decorated] } }), {
    candidate: CANDIDATE, platform: 'linkedin',
  });
  assert.deepEqual(post.sourceUrls, [CANDIDATE.url]);
});

test('verify: duplicate citations of the one real source collapse to a single entry', () => {
  const post = verifyGeneratedPost(validGeneration({ overrides: { sourceUrls: [CANDIDATE.url, CANDIDATE.url] } }), {
    candidate: CANDIDATE, platform: 'linkedin',
  });
  assert.deepEqual(post.sourceUrls, [CANDIDATE.url]);
});

test('verify: a fabricated URL hidden in the body fails even when sourceUrls is clean', () => {
  const body = `${validGeneration().text} Read more at https://fake.example.com/invented.`;
  assertFails(
    validGeneration({ overrides: { text: body, sourceUrls: [CANDIDATE.url] } }),
    GENERATION_ERROR_CODES.INVALID_SOURCE
  );
});

test('verify: the candidate URL appearing in the body is allowed', () => {
  const body = `${validGeneration().text} Full writeup: ${CANDIDATE.url}`;
  const post = verifyGeneratedPost(validGeneration({ overrides: { text: body } }), {
    candidate: CANDIDATE, platform: 'linkedin',
  });
  assert.ok(post.text.includes(CANDIDATE.url));
});

test('verify: a corroborating URL carried in candidate.sources is an allowed source', () => {
  const mirror = 'https://mirror.example.net/poc-writeup';
  const post = verifyGeneratedPost(validGeneration({ candidate: CANDIDATE_MULTI_URL, overrides: { sourceUrls: [mirror] } }), {
    candidate: CANDIDATE_MULTI_URL, platform: 'linkedin',
  });
  assert.deepEqual(post.sourceUrls, [mirror]);
});

test('allowedSourceUrls: names are ignored, only real URLs become allowed sources', () => {
  const allowed = allowedSourceUrls(CANDIDATE); // sources are names, not URLs
  assert.equal(allowed.size, 1);
  assert.ok(allowed.has([...allowed.keys()][0]));
  // The multi-URL candidate contributes both real links.
  assert.equal(allowedSourceUrls(CANDIDATE_MULTI_URL).size, 2);
});

test('findFabricatedUrls: flags only URLs outside the allowed set', () => {
  const allowed = new Set(allowedSourceUrls(CANDIDATE).keys());
  assert.deepEqual(findFabricatedUrls(`see ${CANDIDATE.url} for details`, allowed), []);
  assert.deepEqual(
    findFabricatedUrls('via https://made-up.example.com/x', allowed),
    ['https://made-up.example.com/x']
  );
  // Trailing punctuation must not smuggle a real URL into the "fabricated" list.
  assert.deepEqual(findFabricatedUrls(`(${CANDIDATE.url}).`, allowed), []);
});

test('verify: twitter applies its tighter ceiling', () => {
  assertFails(
    validGeneration({ overrides: { text: 'x'.repeat(281) } }),
    GENERATION_ERROR_CODES.TOO_LONG,
    { candidate: CANDIDATE, platform: 'twitter' }
  );
});
