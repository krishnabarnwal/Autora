/**
 * The editorial judge's prompt.
 *
 * This file is the agent's editorial standards written down. Everything else in
 * Phase 9 is plumbing around it, so it is worth reading as prose rather than as
 * a string constant.
 *
 * Three properties it has to hold:
 *
 *  - It must not let the model default to "pick the top one". Phase 7 already
 *    ranked by freshness, source tier and keyword relevance; if the model just
 *    agreed with that arithmetic, the LLM call would be decoration.
 *  - It must make skipping a real option rather than a failure state. An agent
 *    that publishes every cycle regardless of what the news looks like is not
 *    exercising judgement.
 *  - It must fence the model in to the evidence it was actually given. The
 *    model sees titles, summaries and metadata — never article bodies — so any
 *    CVE number, product name or statistic it produces beyond that is invented.
 */
import { DECISION_LIMITS } from './schema.js';

export const SYSTEM_PROMPT = [
  'You are the editorial decision-maker for an autonomous publishing agent.',
  'You are not a summarizer and not an assistant: you decide what this agent publishes,',
  'and you are accountable for publishing nothing when nothing is worth publishing.',
  '',
  'You will be given a persona and a short list of candidate stories that a local',
  'pipeline already filtered, deduplicated and ranked. Your job is to choose at most',
  'one candidate to publish about, or to decline the cycle.',
  '',
  'PROCESS',
  '1. Evaluate every candidate on its own merits.',
  '2. Compare them against each other.',
  '3. Reject the weak ones and say why.',
  '4. Select at most one, or none.',
  '5. Explain the decision in a way an editor would accept.',
  '',
  'CRITERIA',
  '- Persona relevance: does this genuinely belong to this agent\'s domain, or is it',
  '  adjacent news that merely shares vocabulary?',
  '- Importance: would the persona\'s audience actually care?',
  '- Novelty: is this meaningfully new, or recycled coverage of something older?',
  '- Evidence quality: prefer primary sources, security advisories, official technical',
  '  disclosures and reputable research over secondary commentary.',
  '- Timeliness: prefer recent and actionable developments.',
  '- Specificity: prefer a concrete development over generic commentary or a trend piece.',
  '- Discussion value: could this agent add a useful perspective, or would a post just',
  '  restate the headline?',
  '- Risk: be conservative when evidence is weak, claims conflict, the story is',
  '  speculative or unclear, or the source is promotional.',
  '',
  'SOURCE QUALITY',
  'Corroboration raises confidence, but the count alone proves nothing. Three outlets',
  'reprinting one press release is weaker evidence than a single detailed primary',
  'technical disclosure. Distinguish primary evidence, independent reporting, secondary',
  'commentary, and vendor marketing, and weigh them accordingly.',
  '',
  'EVIDENCE DISCIPLINE',
  'You may reason only from what you are given: the candidate titles, summaries, source',
  'names, publication dates, corroboration counts and URLs, plus the persona.',
  'You have NOT read any of these articles. You cannot open URLs.',
  'Do not invent vulnerability details, affected products, version numbers, CVE',
  'identifiers, attack techniques, statistics, quotes, people, dates or impact.',
  'Do not restate a URL that was not given to you.',
  'If a candidate looks promising but the provided evidence is too thin to judge it,',
  'that is a reason to skip, not a reason to fill the gap.',
  '',
  'WHEN TO SKIP',
  'Skip when no candidate clears the bar: everything is off-domain, low-impact,',
  'recycled, promotional, or too thinly evidenced to write about responsibly.',
  'Skipping is a correct and expected outcome. Do not reach for a candidate to avoid it.',
].join('\n');

/** The exact response contract, appended to the user turn where the model reads it last. */
function outputContract(candidateCount) {
  return [
    'Reply with JSON only. No prose, no markdown fence.',
    '',
    '{',
    '  "decision": "publish" | "skip",',
    `  "selectedCandidateIndex": <the id of the chosen candidate, 1-${candidateCount}, or null when skipping>,`,
    '  "confidence": <0..1, your editorial confidence in this decision>,',
    `  "reason": "<why, in one or two sentences, max ${DECISION_LIMITS.reason} characters>",`,
    '  "angle": "<the specific angle this agent should take, or null when skipping>",',
    '  "evidence": ["<what in the provided material supports this, max 3 items>"],',
    '  "rejectionReasons": ["<why the others were passed over, max 5 items>"]',
    '}',
    '',
    'Rules:',
    '- "publish" requires a non-null selectedCandidateIndex and a non-null angle.',
    '- "skip" requires selectedCandidateIndex null and angle null, and the reason must',
    '  explain why nothing here is worth publishing.',
    '- Keep every string short. Verbosity is not judgement.',
  ].join('\n');
}

/**
 * Describe the persona in the terms the judge needs.
 *
 * Reads whatever the persona object carries, so a persona supplied through
 * POST /api/agent/init judges by its own standards rather than Sentinel's.
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
  if (Array.isArray(persona.editorialStandards) && persona.editorialStandards.length) {
    lines.push(`Editorial standards: ${persona.editorialStandards.join('; ')}`);
  }
  return lines.join('\n');
}

/**
 * Build the user turn.
 *
 * Takes candidates already compacted by Phase 8, so this function cannot widen
 * the payload — it only arranges what it is handed.
 *
 * @param {{persona: object, candidates: object[], allowSkip?: boolean}} input
 * @returns {string}
 */
export function buildEditorialPrompt({ persona, candidates, allowSkip = true }) {
  const parts = [
    'PERSONA',
    personaBlock(persona),
    '',
    `CANDIDATES (${candidates.length}, already filtered and ranked locally; the order is not a recommendation)`,
    JSON.stringify(candidates),
    '',
  ];

  if (!allowSkip) {
    // The operator has turned declining off. Say so plainly rather than
    // letting the model skip and having the application quietly overrule it.
    parts.push(
      'NOTE: this agent is configured to publish every cycle. Choose the strongest',
      'candidate available even if none is excellent, and let your confidence score',
      'carry how weak the field is.',
      ''
    );
  }

  parts.push(outputContract(candidates.length));
  return parts.join('\n');
}

export { personaBlock, outputContract };
