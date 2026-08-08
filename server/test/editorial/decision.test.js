import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionSchema, DECISION_VALUES } from '../../src/services/editorial/schema.js';
import { verifyDecision, findFabrications, EditorialDecisionError } from '../../src/services/editorial/verify.js';
import { parseJsonWithSchema } from '../../src/services/llm/json.js';
import { compactCandidates } from '../../src/services/llm/candidates.js';
import { STRONG, PROMOTIONAL, publishDecision, skipDecision } from '../fixtures/editorial.js';

/**
 * Decision validation.
 *
 * Two layers are under test together because they are only correct together:
 * the JSON Schema catches shape, verifyDecision catches meaning. The rule they
 * enforce jointly is that a malformed decision skips the cycle — it is never
 * repaired into something publishable, because a repaired decision arrives with
 * a confident rationale attached to a story nobody chose.
 */

const CANDIDATES = compactCandidates([STRONG, PROMOTIONAL]);
const SCHEMA = buildDecisionSchema(CANDIDATES.length);

/** Run model output through the same path the provider uses, then verify it. */
const judge = (raw, candidates = CANDIDATES) =>
  verifyDecision(parseJsonWithSchema(JSON.stringify(raw), buildDecisionSchema(candidates.length)), candidates);

test('decision: a valid publish decision passes both layers', () => {
  const result = judge(publishDecision());

  assert.equal(result.decision.decision, 'publish');
  assert.equal(result.index, 1);
  assert.equal(result.candidate.url, STRONG.url);
});

test('decision: a valid skip decision passes both layers', () => {
  const result = judge(skipDecision());

  assert.equal(result.decision.decision, 'skip');
  assert.equal(result.candidate, null);
  assert.equal(result.index, null);
});

test('decision: the decision enum is closed', () => {
  assert.deepEqual([...DECISION_VALUES], ['publish', 'skip']);

  for (const decision of ['maybe', 'PUBLISH', 'publish ', '', 'defer', true, 1, null]) {
    assert.throws(
      () => judge(publishDecision({ decision })),
      /schema|enum|decision/i,
      `expected ${JSON.stringify(decision)} to be rejected`
    );
  }
});

test('decision: an out-of-range index is rejected, never clamped', () => {
  // Clamping would publish a real story the editor did not choose, which is
  // strictly worse than publishing nothing.
  for (const index of [3, 99, 0, -1]) {
    assert.throws(
      () => judge(publishDecision({ selectedCandidateIndex: index })),
      (error) => {
        assert.match(String(error.message), /index|maximum|minimum|range/i);
        return true;
      },
      `expected index ${index} to be rejected`
    );
  }
});

test('decision: a non-integer index is rejected', () => {
  for (const index of [1.5, '1', true, {}, []]) {
    assert.throws(
      () => judge(publishDecision({ selectedCandidateIndex: index })),
      undefined,
      `expected index ${JSON.stringify(index)} to be rejected`
    );
  }
});

test('decision: an index outside the supplied candidate list is rejected by verification', () => {
  // Bypass the schema to prove verifyDecision independently refuses the index
  // rather than relying on the validator having caught it first.
  assert.throws(
    () => verifyDecision(publishDecision({ selectedCandidateIndex: 7 }), CANDIDATES),
    (error) => {
      assert.ok(error instanceof EditorialDecisionError);
      assert.equal(error.code, 'decision_rejected');
      assert.match(error.message, /outside the supplied range 1-2/);
      return true;
    }
  );
});

test('decision: confidence outside 0..1 is rejected', () => {
  for (const confidence of [-0.1, 1.1, 42, 'high', null, NaN]) {
    assert.throws(
      () => judge(publishDecision({ confidence })),
      undefined,
      `expected confidence ${JSON.stringify(confidence)} to be rejected`
    );
  }
});

test('decision: confidence at the exact boundaries is accepted', () => {
  assert.equal(judge(publishDecision({ confidence: 0 })).decision.confidence, 0);
  assert.equal(judge(publishDecision({ confidence: 1 })).decision.confidence, 1);
});

test('decision: a missing or empty reason is rejected', () => {
  assert.throws(() => judge(publishDecision({ reason: '' })), /reason|minLength/i);
  assert.throws(() => judge(publishDecision({ reason: '   ' })), /reason/i);

  const { reason: _dropped, ...withoutReason } = publishDecision();
  assert.throws(() => judge(withoutReason), /required|reason/i);
});

test('decision: publish without an angle is rejected', () => {
  // Without an angle there is no editorial line for Phase 10 to write to, and
  // the post would be a restated headline.
  assert.throws(
    () => verifyDecision(publishDecision({ angle: '' }), CANDIDATES),
    (error) => {
      assert.match(error.message, /angle is empty/);
      return true;
    }
  );
  assert.throws(() => verifyDecision(publishDecision({ angle: null }), CANDIDATES), /angle is empty/);
});

test('decision: publish with a null index is rejected', () => {
  assert.throws(
    () => verifyDecision(publishDecision({ selectedCandidateIndex: null }), CANDIDATES),
    /publish" but selectedCandidateIndex is null/
  );
});

test('decision: skip with a non-null index is rejected', () => {
  // The half-formed decision the generic schema-synthesized mock would produce.
  assert.throws(
    () => verifyDecision(skipDecision({ selectedCandidateIndex: 1 }), CANDIDATES),
    (error) => {
      assert.ok(error instanceof EditorialDecisionError);
      assert.match(error.message, /"skip" but selectedCandidateIndex is 1/);
      return true;
    }
  );
});

test('decision: skip with an angle is rejected', () => {
  assert.throws(
    () => verifyDecision(skipDecision({ angle: 'What this means for practitioners' }), CANDIDATES),
    /"skip" but an angle was supplied/
  );
});

test('decision: skip must explain itself', () => {
  assert.throws(
    () => verifyDecision(skipDecision({ reason: '  ' }), CANDIDATES),
    /no reason was given for publishing nothing/
  );
});

test('decision: every cross-field problem is reported at once', () => {
  // One rejection listing three faults beats three runs finding one each.
  assert.throws(
    () => verifyDecision(
      { decision: 'skip', selectedCandidateIndex: 2, confidence: 5, reason: '', angle: 'an angle' },
      CANDIDATES
    ),
    (error) => {
      assert.ok(error.details.length >= 4, `expected several problems, got ${error.details.length}`);
      return true;
    }
  );
});

test('decision: unexpected properties are rejected, not quietly dropped', () => {
  // additionalProperties:false is deliberate. A decision carrying fields nobody
  // asked for is not the contract, and stripping them would hide the fact that
  // the model answered a different question than the one we posed.
  assert.throws(
    () => parseJsonWithSchema(
      JSON.stringify(publishDecision({ publishImmediately: true, autoPost: 'yes' })),
      SCHEMA
    ),
    (error) => {
      assert.equal(error.code, 'schema_invalid');
      assert.deepEqual(error.details, [
        '$.publishImmediately: unexpected field',
        '$.autoPost: unexpected field',
      ]);
      return true;
    }
  );
});

test('decision: a missing decision field is rejected', () => {
  const { decision: _dropped, ...withoutDecision } = publishDecision();

  assert.throws(
    () => judge(withoutDecision),
    (error) => {
      assert.equal(error.code, 'schema_invalid');
      assert.ok(error.details.some((d) => /decision.*required|missing/i.test(d)), error.details.join('; '));
      return true;
    }
  );
});

test('decision: every required field is actually required', () => {
  const complete = publishDecision();
  const required = [
    'decision', 'selectedCandidateIndex', 'confidence', 'reason', 'angle', 'evidence', 'rejectionReasons',
  ];

  for (const field of required) {
    const { [field]: _dropped, ...partial } = complete;
    assert.throws(
      () => parseJsonWithSchema(JSON.stringify(partial), SCHEMA),
      (error) => {
        assert.equal(error.code, 'schema_invalid');
        return true;
      },
      `expected a decision without "${field}" to be rejected`
    );
  }
});

test('decision: malformed JSON is rejected before any verification runs', () => {
  for (const raw of ['', '   ', 'not json at all', '{"decision": "publish"', '{decision: publish}']) {
    assert.throws(
      () => parseJsonWithSchema(raw, SCHEMA),
      (error) => {
        // The taxonomy distinguishes "said nothing" from "said something unparsable";
        // both end the cycle, and neither is repaired.
        assert.ok(
          ['empty_response', 'invalid_response'].includes(error.code),
          `unexpected code ${error.code} for ${JSON.stringify(raw)}`
        );
        return true;
      },
      `expected ${JSON.stringify(raw)} to be rejected`
    );
  }
});

test('decision: JSON wrapped in prose or a fence is still recovered', () => {
  // The model ignoring "JSON only" is a formatting slip, not a bad decision.
  // Phase 8 already handles it; this pins that the editorial schema rides along.
  const body = JSON.stringify(publishDecision());

  for (const raw of [`\`\`\`json\n${body}\n\`\`\``, `Here is my decision:\n${body}`]) {
    const parsed = parseJsonWithSchema(raw, SCHEMA);
    assert.equal(parsed.decision, 'publish');
  }
});

test('decision: schema-invalid JSON is rejected with every fault listed', () => {
  assert.throws(
    () => parseJsonWithSchema(
      JSON.stringify({
        decision: 'defer',
        selectedCandidateIndex: 'two',
        confidence: 3,
        reason: 'x',
        angle: 5,
        evidence: 'not an array',
        rejectionReasons: [],
      }),
      SCHEMA
    ),
    (error) => {
      assert.equal(error.code, 'schema_invalid');
      assert.ok(error.details.length >= 5, `expected several faults, got ${error.details.length}`);
      return true;
    }
  );
});

test('decision: the resolved candidate is the Phase 7 original, not the compacted copy', () => {
  // Phase 10 needs the full record. Handing it the compacted one would make it
  // re-resolve the index, which is a second chance at an off-by-one.
  const full = [STRONG, PROMOTIONAL];
  const result = verifyDecision(publishDecision(), CANDIDATES, full);

  assert.equal(result.candidate, full[0]);
  assert.equal(result.candidate.score, STRONG.score);
});

test('decision: a selected candidate missing a title or url is rejected', () => {
  const broken = [{ ...STRONG, url: '' }, PROMOTIONAL];

  assert.throws(
    () => verifyDecision(publishDecision(), CANDIDATES, broken),
    (error) => {
      assert.equal(error.code, 'selected_candidate_invalid');
      assert.match(error.message, /missing url/);
      return true;
    }
  );
});

test('decision: a resolved candidate that does not match what the model saw is rejected', () => {
  // Guards against the two lists drifting out of alignment between compaction
  // and resolution — the failure that would publish the wrong story silently.
  const misaligned = [PROMOTIONAL, STRONG];

  assert.throws(
    () => verifyDecision(publishDecision(), CANDIDATES, misaligned),
    (error) => {
      assert.equal(error.code, 'candidate_mismatch');
      return true;
    }
  );
});

test('decision: a truncated title still matches its original', () => {
  // compactCandidates truncates at 200 chars with an ellipsis; that must not
  // read as a mismatch.
  const long = {
    ...STRONG,
    title: `${'Reproducible sandbox escape in a widely deployed agent framework '.repeat(5)}end`,
  };
  const compacted = compactCandidates([long]);

  assert.ok(compacted[0].title.length < long.title.length, 'fixture should exercise truncation');
  const result = verifyDecision(publishDecision(), compacted, [long]);
  assert.equal(result.candidate, long);
});

test('fabrication: a URL that was never supplied is caught', () => {
  const findings = findFabrications(
    publishDecision({ evidence: ['See https://attacker.example.com/not-supplied for detail.'] }),
    CANDIDATES
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0], /not supplied/);
});

test('fabrication: a supplied URL is accepted, including with trailing punctuation', () => {
  assert.deepEqual(
    findFabrications(publishDecision({ evidence: [`Reported at ${STRONG.url}.`] }), CANDIDATES),
    []
  );
  assert.deepEqual(
    findFabrications(publishDecision({ reason: `Per ${PROMOTIONAL.url}, the vendor says otherwise.` }), CANDIDATES),
    []
  );
});

test('fabrication: an invented CVE identifier is caught', () => {
  const findings = findFabrications(
    publishDecision({ angle: 'Why CVE-2026-31337 changes the calculus for agent operators.' }),
    CANDIDATES
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0], /CVE-2026-31337/);
});

test('fabrication: a CVE present in the candidate material is accepted', () => {
  const candidates = compactCandidates([
    { ...STRONG, summary: `${STRONG.summary} Tracked as CVE-2026-1234.` },
  ]);

  assert.deepEqual(
    findFabrications(publishDecision({ reason: 'CVE-2026-1234 is described in the disclosure.' }), candidates),
    []
  );
});

test('fabrication: findings are scanned across every prose field', () => {
  const findings = findFabrications(
    publishDecision({
      reason: 'Backed by https://one.example.com/a',
      angle: 'Framed around https://two.example.com/b',
      evidence: ['CVE-2026-9999 is severe'],
      rejectionReasons: ['Contradicted by https://three.example.com/c'],
    }),
    CANDIDATES
  );

  assert.equal(findings.length, 4);
});

test('fabrication: verification rejects a decision carrying invented evidence', () => {
  assert.throws(
    () => verifyDecision(
      publishDecision({ evidence: ['Confirmed at https://invented.example.com/report'] }),
      CANDIDATES
    ),
    (error) => {
      assert.equal(error.code, 'decision_rejected');
      assert.match(error.message, /cited a URL that was not supplied/);
      return true;
    }
  );
});
