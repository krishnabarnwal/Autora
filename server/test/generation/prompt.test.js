import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPostPrompt, GENERATION_SYSTEM_PROMPT } from '../../src/services/generation/prompt.js';
import { compactCandidates, assertBounded } from '../../src/services/llm/candidates.js';
import { PERSONA, CANDIDATE, publishDecisionResult } from '../fixtures/generation.js';

/**
 * The writer's prompt. It must carry exactly what the writer needs — persona,
 * platform, the editorial direction, and the one story — while forbidding the
 * two things that would let the model overreach: choosing a topic, or citing a
 * source the candidate did not supply. It must also stay bounded.
 */

const [compactCandidate] = compactCandidates([CANDIDATE], { limit: 1 });
const build = (overrides = {}) =>
  buildPostPrompt({ persona: PERSONA, candidate: compactCandidate, decision: publishDecisionResult(), platform: 'linkedin', ...overrides });

test('prompt: carries the persona voice from the stored persona, not a second one', () => {
  const prompt = build();
  assert.match(prompt, /Sentinel/);
  assert.match(prompt, /AI Security/);
  assert.match(prompt, /Precise, sceptical/); // PERSONA.voice
});

test('prompt: carries a machine-readable PLATFORM line and the platform limits', () => {
  const prompt = build();
  assert.match(prompt, /^PLATFORM:\s*linkedin/m);
  assert.match(prompt, /3000 characters/);
  assert.match(prompt, /at most 5 hashtags/);
});

test('prompt: embeds the candidate as a parseable JSON line', () => {
  const prompt = build();
  const line = prompt.split('\n').find((l) => l.trim().startsWith('{'));
  assert.ok(line, 'a JSON candidate line must be present');
  const parsed = JSON.parse(line.trim());
  assert.equal(parsed.title, compactCandidate.title);
  assert.equal(parsed.url, CANDIDATE.url);
});

test('prompt: carries the editorial angle and reason so the model writes to the decision', () => {
  const decision = publishDecisionResult();
  const prompt = build({ decision });
  assert.ok(prompt.includes(decision.angle));
  assert.ok(prompt.includes(decision.reason));
});

test('prompt: names exactly the four output fields and forbids the computed two', () => {
  const prompt = build();
  for (const field of ['text', 'hook', 'hashtags', 'sourceUrls']) {
    assert.ok(prompt.includes(`"${field}"`), `output contract should name ${field}`);
  }
  // The model must not be asked for characterCount or platform.
  assert.match(prompt, /do not include a character count or a platform field/i);
});

test('prompt: instructs the model not to reopen topic selection or invent sources', () => {
  const prompt = build();
  assert.match(prompt, /do not reopen it|already decided/i);
  assert.match(prompt, /only URLs that appear in the story|no other link/i);
  // The system prompt owns the evidence-discipline rule.
  assert.match(GENERATION_SYSTEM_PROMPT, /EVIDENCE DISCIPLINE/);
  assert.match(GENERATION_SYSTEM_PROMPT, /do not choose the topic|already chosen/i);
});

test('prompt: returns strict-JSON-only instructions', () => {
  assert.match(build(), /JSON only/i);
  assert.match(GENERATION_SYSTEM_PROMPT, /strict JSON only/i);
});

test('prompt: falls back to safe defaults when optional persona/decision fields are absent', () => {
  const prompt = buildPostPrompt({ persona: {}, candidate: compactCandidate, decision: {}, platform: 'twitter' });
  assert.match(prompt, /^PLATFORM:\s*twitter/m);
  assert.match(prompt, /Domain: general technology/);
  // A missing angle still yields a usable instruction rather than "undefined".
  assert.doesNotMatch(prompt, /undefined/);
});

test('prompt: stays comfortably bounded for a single candidate', () => {
  // One compacted candidate through the same guard the generator uses.
  const bounds = assertBounded([compactCandidate]);
  assert.ok(bounds.chars < 12_000);
  assert.ok(build().length < 6000, 'a single-candidate prompt should be small');
});
