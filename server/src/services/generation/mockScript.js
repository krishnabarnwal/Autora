/**
 * Deterministic post-writing behaviour for LLM_PROVIDER=mock.
 *
 * The generic mock builds each field from the schema independently, which cannot
 * honour the cross-field and cross-input rules a post must satisfy: the body has
 * to fit the platform *and* clear its content floor, the hashtags have to be
 * well-formed, and the source has to be the candidate's own URL and nothing
 * invented. So generation supplies its own script, exactly as editorial does,
 * and keeps that knowledge here rather than in the provider.
 *
 * What this is: a stand-in that drives the whole generation path — prompt,
 * parse, schema validation, verification, assembly — on zero quota, so demo mode
 * publishes real-looking posts during a 48-hour observation with no key. What it
 * is not: a writer. It restates the candidate; it never adds a fact, and by
 * construction it never emits a URL the candidate did not carry.
 *
 * The failure cases (malformed JSON, a fabricated source, an over-limit body)
 * are produced by tests through the provider's constructor script; this default
 * only ever needs to produce one valid post.
 */
import { extractKeywords } from '../../utils/text.js';
import { getPlatform } from './platforms.js';
import { isValidHashtag } from './schema.js';

/** URLs echoed into prose would trip the fabricated-source check. Strip them. */
const stripUrls = (text) => String(text || '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();

/** Neutral filler used only to clear a platform's content floor; never a fact. */
const FILLER =
  'The details below come straight from the linked report; this note only points to it and adds no new claims.';

/** Clip to a limit on a word boundary so a trimmed body still reads as a sentence. */
function clip(text, limit) {
  const value = stripUrls(text);
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * Recover the single candidate from the prompt.
 *
 * Reads only what the model was shown — the story JSON on its own line — so mock
 * mode keeps proving that the prompt carries enough to write from. Returns null
 * when the prompt has no parsable story object.
 */
export function extractCandidate(prompt) {
  for (const line of String(prompt).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Not the story line; keep looking.
    }
  }
  return null;
}

/** Read the target platform id the prompt declared, defaulting to the primary. */
export function extractPlatform(prompt) {
  const match = String(prompt).match(/^PLATFORM:\s*(\w+)/m);
  return match ? match[1] : undefined;
}

/** Read the persona domain the prompt declared, for a topical hashtag. */
function extractDomain(prompt) {
  const match = String(prompt).match(/^Domain:\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

/** Turn a phrase into a well-formed hashtag, or '' if nothing usable remains. */
function toHashtag(phrase) {
  const cleaned = String(phrase || '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
  const tag = `#${cleaned}`;
  return isValidHashtag(tag) ? tag : '';
}

/**
 * Produce one valid post for the mock provider.
 *
 * Deterministic by construction: the same prompt yields the same post, with no
 * clock, randomness or network. The body is sized to the platform so it clears
 * the content floor without breaching the character ceiling, and the only source
 * cited is the candidate's own URL.
 *
 * @param {string} prompt the built generation prompt
 * @returns {{json: {text: string, hook: string, hashtags: string[], sourceUrls: string[]}}}
 */
export function generationMockScript(prompt) {
  const candidate = extractCandidate(prompt) || {};
  const platform = getPlatform(extractPlatform(prompt));

  const title = stripUrls(candidate.title) || 'the selected story';
  const summary = stripUrls(candidate.summary);

  // Hook: the headline, trimmed to the platform's hook ceiling.
  const hook = clip(title, platform.maxHookChars) || clip('A development worth noting', platform.maxHookChars);

  // Body: headline then summary, padded with neutral filler only if the platform
  // floor demands it, then clipped to the platform ceiling. On a short platform
  // the clip does the work; on a long one the padding does.
  let body = summary ? `${title} — ${summary}` : title;
  while (body.length < platform.minContentChars) body += ` ${FILLER}`;
  body = clip(body, platform.maxChars);

  // Hashtags: the persona domain plus the strongest keywords from the title,
  // deduped, well-formed, and capped at the platform limit.
  const seen = new Set();
  const hashtags = [];
  for (const phrase of [extractDomain(prompt), ...extractKeywords(title, 4)]) {
    const tag = toHashtag(phrase);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    hashtags.push(tag);
    if (hashtags.length >= platform.maxHashtags) break;
  }

  // Source: only the candidate's own URL. Never anything the candidate lacked.
  const sourceUrls = candidate.url ? [String(candidate.url)] : [];

  return { json: { text: body, hook, hashtags, sourceUrls } };
}
