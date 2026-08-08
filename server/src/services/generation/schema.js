/**
 * The FinalPost contract.
 *
 * Same two-layer split as the editorial decision, and for the same reason: a
 * JSON Schema proves shape, and code proves the cross-field coherence a schema
 * in this project's subset cannot express (no `pattern`, no field-to-field
 * comparison). There are two schemas here because there are two objects:
 *
 *  - buildGenerationSchema(platform) — what the MODEL must return. Exactly four
 *    creative fields: text, hook, hashtags, sourceUrls. `additionalProperties:
 *    false`, so an extra field is a rejection, never a silent strip-and-store.
 *
 *  - buildFinalPostSchema(platform) — the assembled FinalPost the rest of the
 *    system consumes. Six fields: the four above plus characterCount and
 *    platform. Also `additionalProperties: false`, with the platform enum pinned
 *    to the single target.
 *
 * Why the model is not asked for characterCount or platform. Character counting
 * is something models do unreliably, so trusting a returned count would mean
 * either failing good posts over an off-by-one or storing a wrong number; we
 * compute it from the text instead, which makes "characterCount matches the
 * text" true by construction — the strongest form of that guarantee. Platform
 * is the caller's decision (config), never the model's, exactly as topic
 * selection was Phase 9's decision and not the writer's. Assigning both
 * ourselves is authoritative metadata, not repair of model content.
 */
import { validateSchema } from '../llm/json.js';
import { getPlatform } from './platforms.js';

/** The four creative fields the model produces. */
export const GENERATION_FIELDS = Object.freeze(['text', 'hook', 'hashtags', 'sourceUrls']);

/** The full FinalPost field set. Anything else is rejected, never stored. */
export const FINAL_POST_FIELDS = Object.freeze([...GENERATION_FIELDS, 'characterCount', 'platform']);

/** Bounds that do not depend on the platform. */
const LIMITS = Object.freeze({
  hashtag: 60, // a longer string is not a tag; format itself is checked below
  sourceUrl: 500, // a longer string is not a URL we produced
  maxSources: 6, // a real post cites one or two; this is a runaway guard
});

/**
 * Well-formed hashtag: a single `#`, then a letter or digit, then letters,
 * digits or underscores — no spaces, no punctuation, no bare `#`. Unicode
 * letters are allowed so a non-English persona is not penalised.
 */
const HASHTAG_PATTERN = /^#[\p{L}\p{N}][\p{L}\p{N}_]*$/u;

/** True for a syntactically valid, spaceless hashtag. */
export const isValidHashtag = (value) =>
  typeof value === 'string' && value.length <= LIMITS.hashtag && HASHTAG_PATTERN.test(value);

/** True for an http(s) URL. Used to reject anything that is not a real link. */
export function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Schema for the model's response — the four creative fields only.
 *
 * The text ceiling is a runaway guard set well above the platform limit on
 * purpose: over-limit-but-not-absurd output must reach verify.js so it produces
 * the specific `generation_too_long`, while genuinely malformed output (a body
 * several times the maximum, or a non-string) fails here as `schema_invalid`.
 * `text` has no minLength so an empty body reaches verify.js as the named
 * "empty post" check rather than a generic schema error.
 *
 * @param {string|object} [platformIdOrSpec]
 * @returns {object} schema in the subset Phase 8's validator supports
 */
export function buildGenerationSchema(platformIdOrSpec) {
  const platform = getPlatform(platformIdOrSpec);
  const textCeiling = platform.maxChars * 2;

  return {
    type: 'object',
    required: [...GENERATION_FIELDS],
    additionalProperties: false,
    properties: {
      text: { type: 'string', maxLength: textCeiling },
      hook: { type: 'string', maxLength: platform.maxHookChars * 2 },
      hashtags: {
        type: 'array',
        maxItems: platform.maxHashtags,
        items: { type: 'string', maxLength: LIMITS.hashtag },
      },
      sourceUrls: {
        type: 'array',
        minItems: 1,
        maxItems: LIMITS.maxSources,
        items: { type: 'string', maxLength: LIMITS.sourceUrl },
      },
    },
  };
}

/**
 * Schema for the assembled FinalPost — the strict, six-field contract.
 *
 * The platform enum is pinned to exactly the target platform, so a FinalPost
 * that claims the wrong platform is a schema failure rather than a stored lie.
 *
 * @param {string|object} [platformIdOrSpec]
 * @returns {object}
 */
export function buildFinalPostSchema(platformIdOrSpec) {
  const platform = getPlatform(platformIdOrSpec);
  const textCeiling = platform.maxChars * 2;

  return {
    type: 'object',
    required: [...FINAL_POST_FIELDS],
    additionalProperties: false,
    properties: {
      text: { type: 'string', minLength: 1, maxLength: textCeiling },
      hook: { type: 'string', minLength: 1, maxLength: platform.maxHookChars * 2 },
      hashtags: {
        type: 'array',
        maxItems: platform.maxHashtags,
        items: { type: 'string', maxLength: LIMITS.hashtag },
      },
      sourceUrls: {
        type: 'array',
        minItems: 1,
        maxItems: LIMITS.maxSources,
        items: { type: 'string', maxLength: LIMITS.sourceUrl },
      },
      characterCount: { type: 'integer', minimum: 0, maximum: textCeiling },
      platform: { type: 'string', enum: [platform.id] },
    },
  };
}

/**
 * Validate an assembled FinalPost against the strict contract.
 *
 * Runs the six-field schema (shape, the closed platform enum, no extra fields)
 * and then the deterministic cross-field checks the schema cannot express:
 * characterCount equals the real text length, every hashtag is well-formed and
 * within the platform cap, every source is an http(s) URL, and the body fits
 * the platform's exact character limit.
 *
 * Source-came-from-the-candidate is NOT checked here — it needs the candidate,
 * so it lives in verify.js. This function is candidate-agnostic and can be
 * called on any FinalPost, which is what the contract tests do.
 *
 * @param {object} post
 * @param {string|object} [platformIdOrSpec] defaults to post.platform
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateFinalPost(post, platformIdOrSpec) {
  const platform = getPlatform(platformIdOrSpec ?? post?.platform);
  const { valid, errors } = validateSchema(post, buildFinalPostSchema(platform));
  const problems = valid ? [] : [...errors];

  if (post && typeof post === 'object') {
    if (typeof post.text === 'string' && post.characterCount !== post.text.length) {
      problems.push(
        `characterCount ${post.characterCount} does not match the text length ${post.text.length}`
      );
    }
    if (typeof post.text === 'string' && post.text.length > platform.maxChars) {
      problems.push(`text length ${post.text.length} exceeds the ${platform.label} limit of ${platform.maxChars}`);
    }
    if (Array.isArray(post.hashtags)) {
      for (const tag of post.hashtags) {
        if (!isValidHashtag(tag)) problems.push(`invalid hashtag: ${JSON.stringify(tag)}`);
      }
      if (post.hashtags.length > platform.maxHashtags) {
        problems.push(`${post.hashtags.length} hashtags exceeds the ${platform.label} limit of ${platform.maxHashtags}`);
      }
    }
    if (Array.isArray(post.sourceUrls)) {
      for (const url of post.sourceUrls) {
        if (!isHttpUrl(url)) problems.push(`invalid source URL: ${JSON.stringify(url)}`);
      }
    }
  }

  return { valid: problems.length === 0, errors: problems };
}

export { LIMITS as POST_SCHEMA_LIMITS };
