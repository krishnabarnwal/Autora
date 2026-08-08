import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORMS,
  PLATFORM_IDS,
  DEFAULT_PLATFORM,
  getPlatform,
  isSupportedPlatform,
} from '../../src/services/generation/platforms.js';
import { GenerationInputError } from '../../src/services/generation/errors.js';

/**
 * Platform constraints are the one place limits live, per the spec. These tests
 * pin that contract: the two required platforms exist, LinkedIn is primary, the
 * limits are sane, the table is immutable, and resolution is total (every input
 * either resolves or throws a caller error — never returns undefined).
 */

test('platforms: linkedin and twitter are both supported, linkedin is the default', () => {
  assert.deepEqual([...PLATFORM_IDS].sort(), ['linkedin', 'twitter']);
  assert.equal(DEFAULT_PLATFORM, 'linkedin');
  assert.ok(isSupportedPlatform('linkedin'));
  assert.ok(isSupportedPlatform('twitter'));
});

test('platforms: each spec carries every limit the generator relies on', () => {
  for (const id of PLATFORM_IDS) {
    const p = PLATFORMS[id];
    assert.equal(p.id, id);
    assert.equal(typeof p.label, 'string');
    for (const field of ['maxChars', 'maxHashtags', 'minContentChars', 'maxHookChars']) {
      assert.equal(typeof p[field], 'number', `${id}.${field}`);
      assert.ok(p[field] > 0, `${id}.${field} must be positive`);
    }
    // The floor must sit below the ceiling, or no post could ever pass both.
    assert.ok(p.minContentChars < p.maxChars, `${id}: floor below ceiling`);
  }
});

test('platforms: the well-known limits are what downstream code assumes', () => {
  assert.equal(PLATFORMS.linkedin.maxChars, 3000);
  assert.equal(PLATFORMS.linkedin.maxHashtags, 5);
  assert.equal(PLATFORMS.twitter.maxChars, 280);
  assert.equal(PLATFORMS.twitter.maxHashtags, 3);
});

test('platforms: getPlatform resolves ids case-insensitively and defaults to linkedin', () => {
  assert.equal(getPlatform().id, 'linkedin');
  assert.equal(getPlatform(undefined).id, 'linkedin');
  assert.equal(getPlatform('LinkedIn').id, 'linkedin');
  assert.equal(getPlatform(' twitter ').id, 'twitter');
  // An already-resolved spec passes through.
  assert.equal(getPlatform(PLATFORMS.twitter).id, 'twitter');
});

test('platforms: an unsupported platform is a caller error, not a silent default', () => {
  assert.throws(
    () => getPlatform('mastodon'),
    (err) => err instanceof GenerationInputError
      && err.code === 'unsupported_platform'
      && Array.isArray(err.details.supported),
  );
  assert.equal(isSupportedPlatform('mastodon'), false);
  assert.equal(isSupportedPlatform(''), false);
  assert.equal(isSupportedPlatform(null), false);
});

test('platforms: the table cannot be mutated by a caller', () => {
  assert.ok(Object.isFrozen(PLATFORMS));
  assert.ok(Object.isFrozen(PLATFORMS.linkedin));
  assert.throws(() => { PLATFORMS.linkedin.maxChars = 1; }, TypeError);
});
