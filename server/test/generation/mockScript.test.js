import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generationMockScript,
  extractCandidate,
  extractPlatform,
} from '../../src/services/generation/mockScript.js';
import { buildPostPrompt } from '../../src/services/generation/prompt.js';
import { isValidHashtag } from '../../src/services/generation/schema.js';
import { verifyGeneratedPost } from '../../src/services/generation/verify.js';
import { compactCandidates } from '../../src/services/llm/candidates.js';
import { PERSONA, CANDIDATE, publishDecisionResult } from '../fixtures/generation.js';

/**
 * The offline mock writer. It has one job: drive the whole generation path on
 * zero quota and always produce a post that survives verifyGeneratedPost. So the
 * tests check both that it reads only what the prompt shows and that its output
 * is genuinely publishable — for both platforms.
 */

const [compactCandidate] = compactCandidates([CANDIDATE], { limit: 1 });
const promptFor = (platform) =>
  buildPostPrompt({ persona: PERSONA, candidate: compactCandidate, decision: publishDecisionResult(), platform });

test('mock: extractCandidate recovers the story object from the prompt', () => {
  const recovered = extractCandidate(promptFor('linkedin'));
  assert.equal(recovered.title, compactCandidate.title);
  assert.equal(recovered.url, CANDIDATE.url);
  assert.equal(extractCandidate('no json here'), null);
});

test('mock: extractPlatform recovers the declared platform', () => {
  assert.equal(extractPlatform(promptFor('twitter')), 'twitter');
  assert.equal(extractPlatform(promptFor('linkedin')), 'linkedin');
  assert.equal(extractPlatform('no platform line'), undefined);
});

test('mock: is deterministic — same prompt in, same post out', () => {
  const prompt = promptFor('linkedin');
  assert.deepEqual(generationMockScript(prompt), generationMockScript(prompt));
});

test('mock: cites only the candidate URL and puts no URL in the prose', () => {
  const { json } = generationMockScript(promptFor('linkedin'));
  assert.deepEqual(json.sourceUrls, [CANDIDATE.url]);
  assert.doesNotMatch(json.text, /https?:\/\//);
  assert.doesNotMatch(json.hook, /https?:\/\//);
});

test('mock: produces only well-formed hashtags within the platform cap', () => {
  const { json } = generationMockScript(promptFor('linkedin'));
  assert.ok(json.hashtags.length <= 5);
  for (const tag of json.hashtags) assert.ok(isValidHashtag(tag), tag);
});

test('mock: its output passes verifyGeneratedPost on LinkedIn', () => {
  const { json } = generationMockScript(promptFor('linkedin'));
  const post = verifyGeneratedPost(json, { candidate: CANDIDATE, platform: 'linkedin' });
  assert.equal(post.platform, 'linkedin');
  assert.ok(post.text.length >= 200 && post.text.length <= 3000);
});

test('mock: its output passes verifyGeneratedPost on Twitter (tighter limits)', () => {
  const { json } = generationMockScript(promptFor('twitter'));
  const post = verifyGeneratedPost(json, { candidate: CANDIDATE, platform: 'twitter' });
  assert.equal(post.platform, 'twitter');
  assert.ok(post.text.length <= 280);
  assert.ok(post.hashtags.length <= 3);
});

test('mock: a candidate with no URL yields no source (which verify then rejects)', () => {
  // The mock never invents a URL: if the candidate lacks one, sourceUrls is empty
  // and the downstream verifier fails closed rather than the mock papering over it.
  const prompt = buildPostPrompt({
    persona: PERSONA,
    candidate: { ...compactCandidate, url: undefined },
    decision: publishDecisionResult(),
    platform: 'linkedin',
  });
  const { json } = generationMockScript(prompt);
  assert.deepEqual(json.sourceUrls, []);
});
