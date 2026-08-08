/**
 * Independent verification of a model-written post.
 *
 * The generation schema already proved shape: four fields, right types, arrays
 * within bounds. This module proves the things a schema in this project's subset
 * cannot, and it treats the model's output as untrusted input the whole way
 * through. The order of checks is deliberate — each maps to a specific error
 * code from the Phase 10 taxonomy, and the most specific, most serious failure
 * (a fabricated source) is the one a caller most needs named precisely.
 *
 * The rule that carries the most weight is source integrity. The model cannot
 * browse; the only real link in existence for this post is the one the candidate
 * carried. So every URL the model emits — in the sourceUrls array *and* buried
 * in the prose — is checked against the candidate's own URL, and anything else
 * fails closed as generation_invalid_source. A wrong link in a published post is
 * the worst thing this layer can ship, so it is the thing checked hardest.
 *
 * Nothing here repairs output. A failure throws GenerationError and the cycle
 * ends with no post; it never edits the model's text into something acceptable.
 */
import { canonicalizeUrl } from '../../utils/text.js';
import { GenerationError, GENERATION_ERROR_CODES } from './errors.js';
import { getPlatform } from './platforms.js';
import { isHttpUrl, isValidHashtag, validateFinalPost } from './schema.js';

/** Same URL shape the editorial verifier scans for, for one definition across phases. */
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi;

/** Trailing punctuation clings to a URL in prose and would break a fair comparison. */
const stripTrailingPunctuation = (url) => String(url).trim().replace(/[.,;:!?)\]]+$/, '');

/**
 * The set of links this post is allowed to cite, keyed by canonical form.
 *
 * Built from the candidate the editorial layer selected. In the Phase 7 shape
 * the only real URL is `candidate.url`; `candidate.sources` carries source
 * *names*, not links. We still scan `sources` for anything URL-shaped so that a
 * future adapter which puts corroborating URLs there is honoured — those are
 * still candidate-supplied, which is the only property that matters here.
 *
 * @param {object} candidate
 * @returns {Map<string,string>} canonical URL -> the candidate's own URL string
 */
export function allowedSourceUrls(candidate = {}) {
  const allowed = new Map();
  const add = (value) => {
    if (!isHttpUrl(value)) return;
    const canonical = canonicalizeUrl(value);
    if (!allowed.has(canonical)) allowed.set(canonical, String(value).trim());
  };

  add(candidate.url);
  for (const entry of Array.isArray(candidate.sources) ? candidate.sources : []) add(entry);

  return allowed;
}

/**
 * URLs the model wrote into the post body or hook that the candidate never
 * supplied. A link in the prose is a citation whether or not it is in the
 * sourceUrls array, so it is held to the same bar.
 *
 * @param {string} prose text and hook joined
 * @param {Set<string>} allowedCanonical canonical forms from allowedSourceUrls
 * @returns {string[]} the offending raw URLs, empty when the prose invents none
 */
export function findFabricatedUrls(prose, allowedCanonical) {
  const findings = [];
  for (const match of String(prose).match(URL_PATTERN) || []) {
    const canonical = canonicalizeUrl(stripTrailingPunctuation(match));
    if (!allowedCanonical.has(canonical)) findings.push(match);
  }
  return findings;
}

/**
 * Verify a model-written post and assemble the FinalPost, or fail closed.
 *
 * @param {object} output the schema-valid model response (text, hook, hashtags, sourceUrls)
 * @param {{candidate: object, platform?: string|object}} context
 * @returns {{text:string, hook:string, hashtags:string[], sourceUrls:string[], characterCount:number, platform:string}}
 * @throws {GenerationError} on any failure, with a specific taxonomy code
 */
export function verifyGeneratedPost(output, { candidate, platform: platformInput } = {}) {
  const platform = getPlatform(platformInput);

  if (!output || typeof output !== 'object') {
    throw new GenerationError(
      'Generated post is not an object.',
      GENERATION_ERROR_CODES.VERIFICATION_FAILED,
      ['output was not an object']
    );
  }

  // --- The post body -------------------------------------------------------
  // Trim first so leading/trailing whitespace neither pads the length nor
  // sneaks a "post" that is blank once the padding is removed past the checks.
  const text = String(output.text ?? '').trim();

  if (!text) {
    throw new GenerationError(
      'Generated post has an empty body.',
      GENERATION_ERROR_CODES.VERIFICATION_FAILED,
      ['post body is empty']
    );
  }
  // Over-limit is its own named failure so a caller can tell "too long" from
  // "malformed" — the spec calls this out as a distinct code.
  if (text.length > platform.maxChars) {
    throw new GenerationError(
      `Generated post is ${text.length} characters, over the ${platform.label} limit of ${platform.maxChars}.`,
      GENERATION_ERROR_CODES.TOO_LONG,
      [`length ${text.length} exceeds ${platform.maxChars}`]
    );
  }
  if (text.length < platform.minContentChars) {
    throw new GenerationError(
      `Generated post is ${text.length} characters, under the ${platform.label} floor of ${platform.minContentChars}.`,
      GENERATION_ERROR_CODES.VERIFICATION_FAILED,
      [`length ${text.length} is below the ${platform.minContentChars}-character floor`]
    );
  }

  // --- The hook ------------------------------------------------------------
  const hook = String(output.hook ?? '').trim();
  if (!hook) {
    throw new GenerationError(
      'Generated post has an empty hook.',
      GENERATION_ERROR_CODES.VERIFICATION_FAILED,
      ['hook is empty']
    );
  }
  if (hook.length > platform.maxHookChars) {
    throw new GenerationError(
      `Hook is ${hook.length} characters, over the ${platform.label} hook limit of ${platform.maxHookChars}.`,
      GENERATION_ERROR_CODES.VERIFICATION_FAILED,
      [`hook length ${hook.length} exceeds ${platform.maxHookChars}`]
    );
  }

  // --- Hashtags ------------------------------------------------------------
  const hashtags = Array.isArray(output.hashtags) ? output.hashtags : null;
  if (!hashtags) {
    throw new GenerationError(
      'Generated post hashtags are not an array.',
      GENERATION_ERROR_CODES.VERIFICATION_FAILED,
      ['hashtags was not an array']
    );
  }
  if (hashtags.length > platform.maxHashtags) {
    throw new GenerationError(
      `Generated post has ${hashtags.length} hashtags, over the ${platform.label} limit of ${platform.maxHashtags}.`,
      GENERATION_ERROR_CODES.VERIFICATION_FAILED,
      [`${hashtags.length} hashtags exceeds ${platform.maxHashtags}`]
    );
  }
  for (const tag of hashtags) {
    if (!isValidHashtag(tag)) {
      throw new GenerationError(
        `Generated post contains an invalid hashtag: ${JSON.stringify(tag)}.`,
        GENERATION_ERROR_CODES.VERIFICATION_FAILED,
        [`invalid hashtag ${JSON.stringify(tag)}`]
      );
    }
  }

  // --- Sources (the check that matters most) -------------------------------
  const allowed = allowedSourceUrls(candidate);
  const allowedCanonical = new Set(allowed.keys());

  const claimed = Array.isArray(output.sourceUrls) ? output.sourceUrls : null;
  if (!claimed || claimed.length === 0) {
    throw new GenerationError(
      'Generated post cites no source.',
      GENERATION_ERROR_CODES.INVALID_SOURCE,
      ['no source URLs were provided']
    );
  }

  // Store the candidate's own URL for each match, deduplicated, in cited order —
  // never the model's echoed string, so the stored link is provably the
  // candidate's and not a near-miss the model mutated.
  const sourceUrls = [];
  const kept = new Set();
  for (const raw of claimed) {
    if (!isHttpUrl(raw)) {
      throw new GenerationError(
        `Generated post cites a value that is not a URL: ${JSON.stringify(raw)}.`,
        GENERATION_ERROR_CODES.INVALID_SOURCE,
        [`not a URL: ${JSON.stringify(raw)}`]
      );
    }
    const canonical = canonicalizeUrl(raw);
    if (!allowedCanonical.has(canonical)) {
      // The model produced a link the candidate never carried. Fail; never keep it.
      throw new GenerationError(
        `Generated post cites a source not present in the candidate: ${raw}.`,
        GENERATION_ERROR_CODES.INVALID_SOURCE,
        [`source not in candidate: ${raw}`]
      );
    }
    const candidateUrl = allowed.get(canonical);
    if (!kept.has(candidateUrl)) {
      kept.add(candidateUrl);
      sourceUrls.push(candidateUrl);
    }
  }

  // A fabricated link hidden in the prose is a fabricated source too.
  const fabricated = findFabricatedUrls(`${text}\n${hook}`, allowedCanonical);
  if (fabricated.length) {
    throw new GenerationError(
      `Generated post body cites a URL not present in the candidate: ${fabricated[0]}.`,
      GENERATION_ERROR_CODES.INVALID_SOURCE,
      fabricated.map((url) => `body cites unsupplied URL: ${url}`)
    );
  }

  // --- Assemble and re-gate ------------------------------------------------
  // characterCount is computed, platform is assigned; both are ours, not the
  // model's, so the two facts the schema most wants to trust are true by
  // construction rather than by belief.
  const finalPost = {
    text,
    hook,
    hashtags: [...hashtags],
    sourceUrls,
    characterCount: text.length,
    platform: platform.id,
  };

  // Belt and braces: the assembled object must itself pass the strict contract.
  // If it does not, our own assembly is inconsistent — fail rather than ship it.
  const { valid, errors } = validateFinalPost(finalPost, platform);
  if (!valid) {
    throw new GenerationError(
      `Assembled post failed the FinalPost contract: ${errors.join('; ')}.`,
      GENERATION_ERROR_CODES.VERIFICATION_FAILED,
      errors
    );
  }

  return finalPost;
}
