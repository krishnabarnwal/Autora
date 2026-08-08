/**
 * The post writer's prompt.
 *
 * Phase 9 already decided *what* to write about and *why*; this prompt governs
 * only *how* it is written. So it is deliberately narrow. It does not ask the
 * model to weigh candidates, reconsider the angle, or decide whether to publish
 * — doing any of those would duplicate editorial judgement and give the model a
 * second chance to overrule a decision that was already made and gated.
 *
 * The single hard rule it enforces in prose, and verify.js enforces in code, is
 * evidence discipline: the post may contain only what the candidate carried. No
 * invented statistics, CVE numbers, quotes, versions or dates, and no source
 * URL other than the one the candidate supplied. The model cannot browse; every
 * fact beyond the candidate is a fabrication, and a fabricated source in a
 * published post is the worst outcome this layer can produce.
 */
import { getPlatform } from './platforms.js';

export const GENERATION_SYSTEM_PROMPT = [
  'You are the post writer for an autonomous publishing agent.',
  'A separate editorial step has already chosen the single story to cover and the',
  'angle to take. Your only job is to write that one post well, in the agent\'s voice.',
  '',
  'You do not choose the topic, rank stories, or decide whether to publish — those',
  'decisions are made and final. Do not second-guess them. Write the post you are asked for.',
  '',
  'EVIDENCE DISCIPLINE (the rule that matters most)',
  'Use only the facts contained in the provided story: its title, summary, source name,',
  'publication date and URL. You have NOT read the article and cannot open the URL.',
  'Do not invent or embellish: no statistics, CVE identifiers, version numbers, product',
  'names, quotes, people, dates, or impact that are not already in the provided material.',
  'Do not add any source, link or URL other than the one provided with the story.',
  'If the evidence is thin, write a shorter, more careful post — never fill the gap with',
  'invention. Preserving the factual meaning of the source is more important than flair.',
  '',
  'CRAFT',
  '- Open with a strong, specific hook that earns attention without clickbait.',
  '- Give the reader useful context and a reason the development matters.',
  '- Match the persona\'s voice and domain. Write as that persona, not as a generic assistant.',
  '- Be concise and concrete. Cut filler, hype, and empty phrases like "game-changer",',
  '  "in today\'s fast-paced world", or "the future is here".',
  '- Make no claim the provided evidence does not support.',
  '- Use a few relevant hashtags at most. A wall of hashtags reads as spam.',
  '',
  'Return strict JSON only, matching the requested shape. No prose or markdown around it.',
].join('\n');

/**
 * Describe the persona in the terms the writer needs. Reads whatever the stored
 * persona carries, so a post is written in the voice of the agent that was
 * initialised — never a second, invented persona.
 */
function personaBlock(persona = {}) {
  const lines = [
    `Name: ${persona.name || 'Unnamed agent'}`,
    `Domain: ${persona.domain || 'general technology'}`,
  ];
  const description = persona.description || persona.identity;
  if (description) lines.push(`Identity: ${description}`);
  if (persona.voice) lines.push(`Voice: ${persona.voice}`);
  if (Array.isArray(persona.interests) && persona.interests.length) {
    lines.push(`Interests: ${persona.interests.join(', ')}`);
  }
  return lines.join('\n');
}

/** State the platform and its limits so the model writes to the target, not a generic length. */
function platformBlock(platform) {
  return [
    `PLATFORM: ${platform.id}`,
    `- Write for ${platform.label}.`,
    `- The post body must be at most ${platform.maxChars} characters.`,
    `- Use at most ${platform.maxHashtags} hashtags.`,
    `- Aim for at least ${platform.minContentChars} characters of real content; do not pad.`,
  ].join('\n');
}

/** The exact response contract, appended last where the model reads it before answering. */
function outputContract(platform) {
  return [
    'Reply with JSON only. No prose, no markdown fence. Exactly these four fields:',
    '',
    '{',
    '  "text": "<the full post body, ready to publish>",',
    '  "hook": "<the opening line of the post, the part that earns attention>",',
    '  "hashtags": ["#Relevant", "#Tags"],',
    '  "sourceUrls": ["<the exact URL(s) from the story below, and nothing else>"]',
    '}',
    '',
    'Rules:',
    `- The post body must be at most ${platform.maxChars} characters.`,
    `- Include at most ${platform.maxHashtags} hashtags, each a single #word with no spaces.`,
    '- sourceUrls must contain only URLs that appear in the story below. Add no other link.',
    '- Do not include a character count or a platform field; those are added for you.',
  ].join('\n');
}

/**
 * Build the writer's user turn.
 *
 * @param {{
 *   persona?: object,
 *   candidate: object,       // already compacted by Phase 8 (id, title, summary, source, publishedAt, url)
 *   decision?: object,       // the editorial decision, for angle/reason
 *   platform?: string|object,
 * }} input
 * @returns {string}
 */
export function buildPostPrompt({ persona = {}, candidate, decision = {}, platform: platformInput }) {
  const platform = getPlatform(platformInput);

  const parts = [
    'PERSONA',
    personaBlock(persona),
    '',
    platformBlock(platform),
    '',
    'EDITORIAL DIRECTION (already decided; write to this, do not reopen it)',
    `Angle: ${decision.angle || 'Report the story clearly and accurately for this audience.'}`,
  ];

  if (decision.reason) parts.push(`Why this story: ${decision.reason}`);

  parts.push(
    '',
    'STORY (the only facts you may use; the URL is the only source you may cite)',
    // On its own line as JSON, mirroring the editorial prompt, so the offline
    // mock can recover exactly what the model was shown and nothing more.
    JSON.stringify(candidate),
    '',
    outputContract(platform)
  );

  return parts.join('\n');
}

export { personaBlock, platformBlock, outputContract };
