import test from 'node:test';
import assert from 'node:assert/strict';
import {
  precheckCandidates, inspectCandidate, EditorialInputError,
} from '../../src/services/editorial/precheck.js';
import { DECISION_SOURCES } from '../../src/services/editorial/schema.js';
import { STRONG, PROMOTIONAL, THIN, manyCandidates } from '../fixtures/editorial.js';

/**
 * Input handling, before any model is consulted.
 *
 * The value of this layer is entirely economic: every decision reached here is
 * a cycle that cost zero tokens. It is also the layer that decides what counts
 * as a caller bug (throw) versus a quiet news day (skip), and getting that line
 * wrong would either hide regressions or crash the scheduler on an empty feed.
 */

test('precheck: zero candidates skips without consulting the model', () => {
  const result = precheckCandidates([]);

  assert.equal(result.decision.decision, 'skip');
  assert.equal(result.decision.source, DECISION_SOURCES.PRECHECK);
  assert.equal(result.decision.selectedCandidateIndex, null);
  assert.equal(result.decision.angle, null);
  assert.match(result.decision.reason, /nothing to judge/i);
  assert.deepEqual(result.candidates, []);
});

test('precheck: one valid candidate proceeds to the model', () => {
  const result = precheckCandidates([STRONG]);

  // A single candidate is still a real editorial question — publish or not.
  assert.equal(result.decision, null);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.issues, []);
  assert.equal(result.dropped, 0);
});

test('precheck: eight candidates is within bounds and proceeds', () => {
  const result = precheckCandidates(manyCandidates(8));

  assert.equal(result.decision, null);
  assert.equal(result.candidates.length, 8);
});

test('precheck: more candidates than configured fails loudly rather than truncating', () => {
  // Silent truncation would hide whatever upstream change produced the overflow,
  // and the prompt is sized for this bound.
  assert.throws(
    () => precheckCandidates(manyCandidates(9), { maxCandidates: 8 }),
    (error) => {
      assert.ok(error instanceof EditorialInputError);
      assert.equal(error.code, 'too_many_candidates');
      assert.match(error.message, /Received 9 candidates/);
      assert.equal(error.details.received, 9);
      assert.equal(error.details.maxCandidates, 8);
      return true;
    }
  );
});

test('precheck: the configured maximum is honoured, not a hardcoded 8', () => {
  assert.doesNotThrow(() => precheckCandidates(manyCandidates(3), { maxCandidates: 3 }));
  assert.throws(
    () => precheckCandidates(manyCandidates(4), { maxCandidates: 3 }),
    /above the configured maximum of 3/
  );
});

test('precheck: malformed input throws instead of reaching the model', () => {
  for (const input of [null, undefined, 'candidates', 42, { title: 'not an array' }]) {
    assert.throws(
      () => precheckCandidates(input),
      (error) => {
        assert.ok(error instanceof EditorialInputError);
        assert.equal(error.code, 'invalid_input');
        return true;
      },
      `expected ${JSON.stringify(input)} to be rejected`
    );
  }
});

test('precheck: a candidate missing a URL is dropped, not judged', () => {
  // Phase 10 has to cite a source, so a candidate that cannot be linked is
  // unusable no matter how good the headline is.
  const { title, summary, source } = STRONG;
  const result = precheckCandidates([{ title, summary, source }, PROMOTIONAL]);

  assert.equal(result.decision, null);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].url, PROMOTIONAL.url);
  assert.equal(result.dropped, 1);
  assert.ok(result.issues.some((issue) => /missing or invalid url/.test(issue)));
});

test('precheck: a non-http URL counts as missing', () => {
  for (const url of ['javascript:alert(1)', 'ftp://example.com/x', 'not a url', '']) {
    const inspection = inspectCandidate({ ...STRONG, url }, 1);
    assert.equal(inspection.usable, false, `expected ${JSON.stringify(url)} to be rejected`);
  }
});

test('precheck: a candidate missing a summary is flagged but still judged', () => {
  // A headline, source and date is thin but judgeable; dropping it would throw
  // away a legitimately publishable story.
  const result = precheckCandidates([{ ...STRONG, summary: '' }]);

  assert.equal(result.decision, null);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.dropped, 0);
  assert.ok(result.issues.some((issue) => /missing summary/.test(issue)));
});

test('precheck: a candidate missing a title is dropped', () => {
  const result = precheckCandidates([{ ...STRONG, title: '   ' }, THIN]);

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].title, THIN.title);
  assert.ok(result.issues.some((issue) => /missing title/.test(issue)));
});

test('precheck: when every candidate is unusable it skips without a call', () => {
  const result = precheckCandidates([
    { summary: 'no title, no url' },
    { title: 'no url' },
    'not an object',
  ]);

  assert.equal(result.decision.decision, 'skip');
  assert.equal(result.decision.source, DECISION_SOURCES.PRECHECK);
  assert.match(result.decision.reason, /structurally unusable/i);
  assert.ok(result.decision.rejectionReasons.length > 0);
  assert.equal(result.dropped, 3);
});

test('precheck: skips without a call when deterministic scoring proves nothing is relevant', () => {
  const result = precheckCandidates([
    { ...STRONG, relevance: 0 },
    { ...THIN, relevance: 0 },
  ]);

  assert.equal(result.decision.decision, 'skip');
  assert.match(result.decision.reason, /relevance/i);
});

test('precheck: one relevant candidate is enough to justify the call', () => {
  const result = precheckCandidates([
    { ...STRONG, relevance: 0.9 },
    { ...THIN, relevance: 0 },
  ]);

  assert.equal(result.decision, null);
  assert.equal(result.candidates.length, 2);
});

test('precheck: unscored candidates never trigger the relevance shortcut', () => {
  // Phase 7 owns relevance. If it did not score these, this layer has no
  // opinion to act on and must not invent one.
  const { relevance: _unusedA, ...unscoredStrong } = STRONG;
  const { relevance: _unusedB, ...unscoredThin } = THIN;

  const result = precheckCandidates([unscoredStrong, unscoredThin]);
  assert.equal(result.decision, null);
});

test('precheck: does not mutate or reorder the candidates it was given', () => {
  const input = [STRONG, PROMOTIONAL, THIN];
  const before = JSON.parse(JSON.stringify(input));

  const result = precheckCandidates(input);

  assert.deepEqual(input, before);
  assert.deepEqual(result.candidates.map((c) => c.url), before.map((c) => c.url));
});
