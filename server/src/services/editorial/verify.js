/**
 * Independent verification of a model-produced decision.
 *
 * The schema already guaranteed shape. This checks the things a schema cannot:
 * that the decision is internally coherent, that the identifier it returned
 * points at a candidate we actually supplied, and that its prose did not
 * introduce facts that were never in the input.
 *
 * The stance here is that model output is untrusted input. It happens to be
 * well-formed most of the time, which is precisely why the one time it is not
 * would otherwise sail through into a published post.
 */
import { DECISIONS } from './schema.js';

/** Thrown when a decision cannot be trusted. Never repaired — Phase 9 skips the cycle instead. */
export class EditorialDecisionError extends Error {
  constructor(message, code, details = []) {
    super(message);
    this.name = 'EditorialDecisionError';
    this.code = code;
    this.details = details;
  }
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi;
const CVE_PATTERN = /\bCVE-\d{4}-\d{4,7}\b/gi;

/** Trailing punctuation clings to URLs in prose and would break a fair comparison. */
const normalizeUrl = (url) => String(url).trim().replace(/[.,;:!?)\]]+$/, '').toLowerCase();

/** Every string the model wrote, which is the surface hallucinations appear on. */
function prose(decision) {
  return [
    decision.reason,
    decision.angle,
    ...(decision.evidence || []),
    ...(decision.rejectionReasons || []),
  ].filter((value) => typeof value === 'string').join('\n');
}

/**
 * Catch facts that appeared from nowhere.
 *
 * Two checks, both cheap and both closing a failure mode that would be
 * embarrassing in a published post:
 *
 *  - A URL the model produced that we never supplied. The model cannot browse,
 *    so any such link is fabricated and would send a reader somewhere the agent
 *    never looked.
 *  - A CVE identifier absent from the candidate material. CVE numbers are the
 *    single most confidently-invented artefact in security writing, and a wrong
 *    one is worse than none.
 *
 * This cannot detect every invention — a fabricated statistic in free prose is
 * not mechanically distinguishable from a real one. It closes the two that are.
 *
 * @returns {string[]} findings, empty when nothing was invented
 */
export function findFabrications(decision, candidates) {
  const text = prose(decision);
  const findings = [];

  const suppliedUrls = new Set(candidates.map((candidate) => normalizeUrl(candidate.url || '')));
  for (const match of text.match(URL_PATTERN) || []) {
    if (!suppliedUrls.has(normalizeUrl(match))) {
      findings.push(`cited a URL that was not supplied: ${match}`);
    }
  }

  const suppliedText = JSON.stringify(candidates).toLowerCase();
  for (const match of text.match(CVE_PATTERN) || []) {
    if (!suppliedText.includes(match.toLowerCase())) {
      findings.push(`cited an identifier absent from the candidate material: ${match}`);
    }
  }

  return findings;
}

/**
 * Verify a decision against the candidates that produced it.
 *
 * @param {object} decision schema-valid model output
 * @param {object[]} candidates the compacted list the model was shown
 * @param {object[]} [fullCandidates] the Phase 7 originals, resolved into the result
 * @returns {{decision: object, candidate: object|null, index: number|null}}
 * @throws {EditorialDecisionError}
 */
export function verifyDecision(decision, candidates, fullCandidates = candidates) {
  const problems = [];

  if (decision.decision === DECISIONS.PUBLISH) {
    const index = decision.selectedCandidateIndex;

    if (index === null || index === undefined) {
      problems.push('decision is "publish" but selectedCandidateIndex is null');
    } else if (!Number.isInteger(index)) {
      problems.push(`selectedCandidateIndex must be an integer, received ${JSON.stringify(index)}`);
    } else if (index < 1 || index > candidates.length) {
      // The model invented an identifier. Never resolve it to something nearby.
      problems.push(`selectedCandidateIndex ${index} is outside the supplied range 1-${candidates.length}`);
    }

    if (typeof decision.angle !== 'string' || !decision.angle.trim()) {
      problems.push('decision is "publish" but angle is empty; there is no editorial line to write to');
    }
  } else if (decision.decision === DECISIONS.SKIP) {
    if (decision.selectedCandidateIndex !== null && decision.selectedCandidateIndex !== undefined) {
      problems.push(`decision is "skip" but selectedCandidateIndex is ${JSON.stringify(decision.selectedCandidateIndex)}`);
    }
    if (decision.angle !== null && decision.angle !== undefined && String(decision.angle).trim()) {
      problems.push('decision is "skip" but an angle was supplied');
    }
    if (!String(decision.reason || '').trim()) {
      problems.push('decision is "skip" but no reason was given for publishing nothing');
    }
  } else {
    problems.push(`unknown decision "${decision.decision}"`);
  }

  if (typeof decision.confidence !== 'number'
    || !Number.isFinite(decision.confidence)
    || decision.confidence < 0 || decision.confidence > 1) {
    problems.push(`confidence must be a number in 0..1, received ${JSON.stringify(decision.confidence)}`);
  }

  if (!String(decision.reason || '').trim()) problems.push('reason is empty');

  problems.push(...findFabrications(decision, candidates));

  if (problems.length) {
    throw new EditorialDecisionError(
      `Editorial decision failed verification: ${problems.join('; ')}`,
      'decision_rejected',
      problems
    );
  }

  if (decision.decision === DECISIONS.SKIP) {
    return { decision, candidate: null, index: null };
  }

  const index = decision.selectedCandidateIndex;
  const compacted = candidates[index - 1];
  const resolved = fullCandidates[index - 1];

  // The selected candidate has to survive the same structural bar the precheck
  // applied, because this is the object Phase 10 will build a post from.
  const missing = ['title', 'url'].filter((field) => !String(resolved?.[field] || '').trim());
  if (!resolved || missing.length) {
    throw new EditorialDecisionError(
      `Selected candidate ${index} is unusable: ${missing.length ? `missing ${missing.join(', ')}` : 'not found'}`,
      'selected_candidate_invalid',
      missing
    );
  }

  // Belt and braces: the resolved candidate must be the one the model saw.
  if (compacted && String(compacted.title || '').slice(0, 40) && resolved.title
    && !String(resolved.title).startsWith(String(compacted.title).slice(0, 40).replace(/…$/, ''))) {
    throw new EditorialDecisionError(
      `Selected candidate ${index} does not match the candidate shown to the model`,
      'candidate_mismatch'
    );
  }

  return { decision, candidate: resolved, index };
}
