import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT, buildEditorialPrompt, personaBlock } from '../../src/services/editorial/prompt.js';
import { compactCandidates } from '../../src/services/llm/candidates.js';
import { PERSONA, STRONG, PROMOTIONAL, THIN } from '../fixtures/editorial.js';

/**
 * The prompt is the editorial standard, so its contract is worth pinning.
 *
 * These tests check contractual fragments, not wording. Asserting the whole
 * prompt would make every improvement to the phrasing a test failure, which
 * trains the next person to update the snapshot without reading it — the exact
 * opposite of what a test on a prompt should do.
 */

const CANDIDATES = compactCandidates([STRONG, PROMOTIONAL, THIN]);
const prompt = (overrides = {}) =>
  buildEditorialPrompt({ persona: PERSONA, candidates: CANDIDATES, ...overrides });

/** Each rule the system prompt must carry, with a pattern that survives rewording. */
const SYSTEM_RULES = [
  ['acts as an editorial decision-maker, not a summarizer', /editorial decision-maker/i],
  ['explicitly not a summarizer', /not a summarizer/i],
  ['evaluates every candidate', /evaluate every candidate/i],
  ['compares candidates against each other', /compare them against each other/i],
  ['rejects the weak ones with reasons', /reject the weak ones and say why/i],
  ['selects at most one', /at most one/i],
  ['may decline the cycle', /decline the cycle|skip/i],
  ['treats skipping as a correct outcome', /skipping is a correct and expected outcome/i],
  ['forbids inventing facts', /do not invent/i],
  ['names CVE identifiers among the things not to invent', /CVE/i],
  ['states the model has not read the articles', /have NOT read/i],
  ['states the model cannot open URLs', /cannot open URLs/i],
  ['restricts reasoning to the supplied material', /reason only from what you are given/i],
  ['prefers primary sources', /prefer primary sources/i],
  ['weighs independent reporting against commentary and marketing', /independent reporting.*commentary.*marketing/is],
  ['refuses the "three sources means true" shortcut', /count alone proves nothing/i],
  ['treats thin evidence as a reason to skip', /too thin to judge|reason to skip/i],
];

for (const [description, pattern] of SYSTEM_RULES) {
  test(`prompt: the system instruction ${description}`, () => {
    assert.match(SYSTEM_PROMPT, pattern);
  });
}

test('prompt: the system instruction names all eight editorial criteria', () => {
  for (const criterion of [
    /persona relevance/i, /importance/i, /novelty/i, /evidence quality/i,
    /timeliness/i, /specificity/i, /discussion value/i, /risk/i,
  ]) {
    assert.match(SYSTEM_PROMPT, criterion);
  }
});

test('prompt: the system instruction does not ask for the final post', () => {
  // Phase 10 writes the post. A judge asked to draft one starts choosing the
  // candidate that is easiest to write about rather than the one that matters.
  assert.doesNotMatch(SYSTEM_PROMPT, /write (the|a) (post|tweet|thread)/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /\b(280|character limit|hashtag)\b/i);
});

test('prompt: the user turn demands strict JSON with no fence', () => {
  const text = prompt();

  assert.match(text, /Reply with JSON only/i);
  assert.match(text, /no markdown fence/i);
});

test('prompt: the user turn states the exact response contract', () => {
  const text = prompt();

  for (const field of [
    'decision', 'selectedCandidateIndex', 'confidence', 'reason', 'angle', 'evidence', 'rejectionReasons',
  ]) {
    assert.ok(text.includes(`"${field}"`), `expected the contract to name ${field}`);
  }
  assert.match(text, /"publish" \| "skip"/);
});

test('prompt: the contract states both cross-field rules', () => {
  const text = prompt();

  assert.match(text, /"publish" requires a non-null selectedCandidateIndex and a non-null angle/i);
  assert.match(text, /"skip" requires selectedCandidateIndex null and angle null/i);
});

test('prompt: the index range is bound to the actual candidate count', () => {
  assert.match(prompt(), /1-3/);
  assert.match(buildEditorialPrompt({ persona: PERSONA, candidates: CANDIDATES.slice(0, 1) }), /1-1/);
});

test('prompt: the candidate order is explicitly not a recommendation', () => {
  // Without this the model tends to ratify Phase 7's ranking, which would make
  // the whole call decorative.
  assert.match(prompt(), /the order is not a recommendation/i);
});

test('prompt: the persona is described in the terms the judge needs', () => {
  const text = prompt();

  assert.match(text, /Name: Sentinel/);
  assert.match(text, /Domain: AI Security/);
  assert.match(text, /Interests: prompt injection, model supply chain, agent sandboxing/);
  assert.match(text, /Editorial standards: .*primary technical disclosures/);
});

test('prompt: a bare persona still produces a usable block', () => {
  // POST /api/agent/init accepts {name, domain} only, so this is the real shape.
  const text = personaBlock({ name: 'Ada', domain: 'AI Security' });

  assert.match(text, /Name: Ada/);
  assert.match(text, /Domain: AI Security/);
  assert.doesNotMatch(text, /undefined|null/);
});

test('prompt: an empty persona degrades to a labelled default rather than "undefined"', () => {
  const text = personaBlock({});

  assert.match(text, /Unnamed agent/);
  assert.doesNotMatch(text, /undefined/);
});

test('prompt: allowSkip=false says so plainly instead of letting the app overrule silently', () => {
  const forced = prompt({ allowSkip: false });

  assert.match(forced, /configured to publish every cycle/i);
  assert.match(forced, /let your confidence score/i);
  assert.doesNotMatch(prompt(), /configured to publish every cycle/i);
});

test('prompt: only the compacted candidate fields reach the model', () => {
  const text = prompt();

  // Phase 7 scoring internals are how we ranked, not evidence to reason from.
  assert.doesNotMatch(text, /"score"/);
  assert.doesNotMatch(text, /"relevance"/);
  assert.doesNotMatch(text, /"normalizedTopic"/);
  assert.doesNotMatch(text, /"tier"/);
  assert.ok(text.includes(STRONG.title), 'the title the model judges on must be present');
});

test('prompt: the whole editorial turn stays small enough to be cheap', () => {
  // Eight full candidates is the worst realistic case; ~3k chars is ~750 tokens.
  const eight = compactCandidates(Array.from({ length: 8 }, (_unused, index) => ({
    ...STRONG,
    title: `${STRONG.title} ${index}`,
    summary: STRONG.summary.repeat(3),
    url: `${STRONG.url}-${index}`,
  })));

  const text = buildEditorialPrompt({ persona: PERSONA, candidates: eight });
  const total = SYSTEM_PROMPT.length + text.length;

  assert.ok(total < 12_000, `editorial turn is ${total} chars, which is larger than intended`);
});
