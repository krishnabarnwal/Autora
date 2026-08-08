/**
 * Platform constraints for post generation.
 *
 * The spec is explicit that these limits must be configuration/constants in one
 * place, not numbers sprinkled through the generator, prompt and verifier. This
 * module is that place. LinkedIn is the primary target; X/Twitter is supported
 * so the shape is genuinely multi-platform rather than LinkedIn with a flag.
 *
 * The limits are measured against the post's `text` (the body), counted as
 * JavaScript string length. That is an approximation of what each network
 * actually counts — real platforms fold in hashtags, URLs and surrogate pairs
 * differently — but this project simulates publishing, so a single consistent
 * definition that every layer agrees on matters more than matching a specific
 * network's counter. Stated here so the choice is visible in one place.
 */
import { GenerationInputError } from './errors.js';

/**
 * @typedef {object} PlatformSpec
 * @property {string} id            machine id, also the FinalPost.platform value
 * @property {string} label         human label for logs and the dashboard
 * @property {number} maxChars      hard character ceiling on the post body
 * @property {number} maxHashtags   most hashtags a post may carry
 * @property {number} minContentChars floor below which the body is too thin to publish
 * @property {number} maxHookChars  ceiling on the opening hook line
 */

/** The supported platforms and their limits. Frozen so no caller can mutate them. */
export const PLATFORMS = Object.freeze({
  linkedin: Object.freeze({
    id: 'linkedin',
    label: 'LinkedIn',
    // LinkedIn allows ~3000 characters in a post body.
    maxChars: 3000,
    // A handful of tags reads as considered; a wall of them reads as spam.
    maxHashtags: 5,
    // Below this a "post" is really just a headline, which is not what the
    // agent is for. Comfortably clearing this is easy for a real model.
    minContentChars: 200,
    maxHookChars: 220,
  }),
  twitter: Object.freeze({
    id: 'twitter',
    label: 'X (Twitter)',
    // The classic 280-character limit; the simulation targets the free tier.
    maxChars: 280,
    maxHashtags: 3,
    minContentChars: 40,
    maxHookChars: 120,
  }),
});

/** The primary platform, used whenever a caller does not name one. */
export const DEFAULT_PLATFORM = 'linkedin';

/** Every supported platform id, for validation and the schema enum. */
export const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORMS));

/**
 * Resolve a platform id (or an already-resolved spec) to its spec.
 *
 * @param {string|PlatformSpec} [idOrSpec] defaults to the primary platform
 * @returns {PlatformSpec}
 * @throws {GenerationInputError} on an unsupported platform — a caller bug, not
 *   a model failure, so it throws rather than becoming a failed result.
 */
export function getPlatform(idOrSpec = DEFAULT_PLATFORM) {
  if (idOrSpec && typeof idOrSpec === 'object' && idOrSpec.id && PLATFORMS[idOrSpec.id]) {
    return PLATFORMS[idOrSpec.id];
  }
  const id = String(idOrSpec ?? '').trim().toLowerCase();
  const platform = PLATFORMS[id];
  if (!platform) {
    throw new GenerationInputError(
      `Unsupported platform "${idOrSpec}". Supported: ${PLATFORM_IDS.join(', ')}.`,
      'unsupported_platform',
      { supported: [...PLATFORM_IDS] }
    );
  }
  return platform;
}

/** True when the id names a supported platform, without throwing. */
export const isSupportedPlatform = (id) =>
  typeof id === 'string' && Object.prototype.hasOwnProperty.call(PLATFORMS, id.trim().toLowerCase());
