import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidates } from '../../src/services/editorial/index.js';
import { editorialMockScript, extractCandidates } from '../../src/services/editorial/mockScript.js';
import { DECISION_SOURCES } from '../../src/services/editorial/schema.js';
import { buildEditorialPrompt } from '../../src/services/editorial/prompt.js';
import { createLlmProvider } from '../../src/services/llm/index.js';
import { createMockProvider } from '../../src/services/llm/mockProvider.js';
import { UsageTracker } from '../../src/services/llm/usage.js';
import { compactCandidates } from '../../src/services/llm/candidates.js';
import { NOW } from '../fixtures/feeds.js';
import {
  PERSONA, STRONG, PROMOTIONAL, THIN, OFF_DOMAIN, manyCandidates, publishDecision, skipDecision,
} from '../fixtures/editorial.js';

/**
 * Editorial behaviour, the confidence gate, and mock mode.
 *
 * A note on what is being tested. The real judgement belongs to the model, and
 * asserting that a live model prefers one story over another would be a flaky
 * test of someone else's weights. What is tested here is the machinery around
 * the judgement: that the application honours a decision, converts a
 * low-confidence publish into a skip, and that mock mode makes defensible
 * choices deterministically with no key and no network.
 */

const evaluate = (candidates, options = {}) =>
  evaluateCandidates(candidates, { persona: PERSONA, now: NOW, ...options });

/** Mock mode as configured in demo: no script, so the editorial fallback drives it. */
const mockProvider = () => createMockProvider({ usage: new UsageTracker(), retries: 0 });

const decisionFor = (candidates, options = {}) =>
  editorialMockScript(buildEditorialPrompt({
    persona: PERSONA, candidates: compactCandidates(candidates), ...options,
  })).json;

test('behaviour: the application publishes what the editor selected, not what ranked first', async () => {
  // Phase 7 put the promotional item first. Honouring the editor's choice of
  // the second is the whole point of spending the call.
  const provider = createMockProvider({
    script: [{ json: publishDecision({ selectedCandidateIndex: 2 }) }],
    usage: new UsageTracker(),
  });

  const result = await evaluate([PROMOTIONAL, STRONG], { provider });

  assert.equal(result.candidate.url, STRONG.url);
  assert.notEqual(result.candidate.url, PROMOTIONAL.url);
});

test('behaviour: a judged skip is honoured even when candidates were available', async () => {
  const provider = createMockProvider({
    script: [{ json: skipDecision() }],
    usage: new UsageTracker(),
  });

  const result = await evaluate([STRONG, PROMOTIONAL, THIN], { provider });

  assert.equal(result.decision, 'skip');
  assert.equal(result.source, DECISION_SOURCES.LLM);
  assert.equal(result.candidate, null);
});

test('mock: selects the specific technical disclosure over the corroborated press release', () => {
  // Three outlets reprinting one announcement must not beat one primary
  // disclosure. PROMOTIONAL carries corroboration 3; STRONG carries 2.
  const decision = decisionFor([PROMOTIONAL, STRONG]);

  assert.equal(decision.decision, 'publish');
  assert.equal(decision.selectedCandidateIndex, 2);
  assert.ok(decision.rejectionReasons.some((reason) => /promotional|non-specific/i.test(reason)));
});

test('mock: skips when the field is only promotional and generic', () => {
  const decision = decisionFor([PROMOTIONAL, THIN, OFF_DOMAIN]);

  assert.equal(decision.decision, 'skip');
  assert.equal(decision.selectedCandidateIndex, null);
  assert.equal(decision.angle, null);
  assert.ok(decision.reason.length > 10);
  assert.ok(decision.rejectionReasons.length > 0);
});

test('mock: publishes when a strong candidate is present', () => {
  const decision = decisionFor([THIN, STRONG, PROMOTIONAL]);

  assert.equal(decision.decision, 'publish');
  assert.equal(decision.selectedCandidateIndex, 2);
  assert.ok(decision.confidence > 0.7);
  assert.ok(decision.angle.length > 0);
});

test('mock: picks the strongest when several are publishable, with a stable tiebreak', () => {
  const decision = decisionFor(manyCandidates(4));

  assert.equal(decision.decision, 'publish');
  // All four are equally strong, so the tiebreak must be deterministic rather
  // than dependent on sort internals.
  assert.equal(decision.selectedCandidateIndex, 1);
});

test('mock: is deterministic across repeated runs', () => {
  const runs = Array.from({ length: 5 }, () => decisionFor([PROMOTIONAL, STRONG, THIN]));

  for (const run of runs) {
    assert.deepEqual(run, runs[0]);
  }
});

test('mock: an empty candidate list yields a coherent skip', () => {
  const decision = editorialMockScript('PERSONA\nName: Ada\n\nCANDIDATES (0)\n[]\n').json;

  assert.equal(decision.decision, 'skip');
  assert.equal(decision.selectedCandidateIndex, null);
  assert.equal(decision.angle, null);
});

test('mock: never emits the incoherent combinations verification rejects', () => {
  // The defect this file exists to prevent: the generic schema-synthesized mock
  // pairs "skip" with a real index about half the time.
  const shortlists = [
    [STRONG], [PROMOTIONAL], [THIN], [OFF_DOMAIN],
    [STRONG, PROMOTIONAL], [PROMOTIONAL, THIN], [THIN, OFF_DOMAIN, STRONG],
    manyCandidates(8),
  ];

  for (const shortlist of shortlists) {
    const decision = decisionFor(shortlist);
    if (decision.decision === 'skip') {
      assert.equal(decision.selectedCandidateIndex, null);
      assert.equal(decision.angle, null);
    } else {
      assert.ok(Number.isInteger(decision.selectedCandidateIndex));
      assert.ok(decision.selectedCandidateIndex >= 1);
      assert.ok(decision.selectedCandidateIndex <= shortlist.length);
      assert.ok(decision.angle && decision.angle.length > 0);
    }
    assert.ok(decision.confidence >= 0 && decision.confidence <= 1);
    assert.ok(decision.reason.length >= 10);
  }
});

test('mock: never cites a URL, so its output cannot read as fabricated evidence', () => {
  // Echoing a candidate title that contains a URL would trip the verifier.
  const decision = decisionFor([
    { ...STRONG, title: 'Advisory at https://elsewhere.example.com/x describes the exploit' },
  ]);

  assert.doesNotMatch(JSON.stringify(decision), /https?:\/\//);
});

test('mock: runs the full path with no key, no network, and one call', async () => {
  let fetched = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetched += 1; return originalFetch(...args); };

  const provider = createLlmProvider({ provider: 'mock', apiKey: '', usage: new UsageTracker() });
  try {
    const result = await evaluate([PROMOTIONAL, STRONG], { provider });

    assert.equal(result.decision, 'publish');
    assert.equal(result.candidate.url, STRONG.url);
    assert.equal(result.llmCalls, 1);
    assert.equal(result.provider, 'mock');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetched, 0, 'mock mode must make no network request');
});

test('mock: demo mode reaches a publishable decision through the real pipeline', async () => {
  const provider = mockProvider();
  const result = await evaluate([THIN, STRONG, PROMOTIONAL], { provider });

  assert.equal(result.decision, 'publish');
  assert.equal(result.candidate.url, STRONG.url);
  assert.equal(result.source, DECISION_SOURCES.LLM);
  assert.ok(result.confidence >= 0.7);
});

test('mock: demo mode skips a weak field through the real pipeline', async () => {
  const provider = mockProvider();
  const result = await evaluate([PROMOTIONAL, THIN], { provider });

  assert.equal(result.decision, 'skip');
  assert.equal(result.candidate, null);
  assert.equal(result.llmCalls, 1);
});

test('mock: a scripted failure still overrides the editorial fallback', () => {
  // Precedence matters: a test saying "fail here" must win over the caller's
  // default, or scripted-failure tests would silently stop testing anything.
  const provider = createMockProvider({
    script: [{ error: 'timeout' }],
    usage: new UsageTracker(),
    retries: 0,
  });

  return assert.rejects(
    () => provider.generateJSON('anything', { fallbackScript: editorialMockScript }),
    (error) => {
      assert.equal(error.code, 'timeout');
      return true;
    }
  );
});

test('mock: scripted malformed output is rejected rather than accepted', async () => {
  const provider = createMockProvider({
    script: [{ raw: '{"decision": "publish", "selectedCandidateIndex":' }],
    usage: new UsageTracker(),
    retries: 0,
  });

  const result = await evaluate([STRONG, PROMOTIONAL], { provider });

  assert.equal(result.decision, 'skip');
  assert.ok(result.warnings.some((warning) => /editorial_call_failed/.test(warning)));
});

test('mock: extractCandidates reads only what the prompt actually carries', () => {
  const compacted = compactCandidates([STRONG, PROMOTIONAL]);
  const parsed = extractCandidates(buildEditorialPrompt({ persona: PERSONA, candidates: compacted }));

  assert.deepEqual(parsed, compacted);
  assert.deepEqual(extractCandidates('no candidates here'), []);
});

test('confidence: a publish at or above the floor is accepted', async () => {
  for (const confidence of [0.7, 0.71, 0.95, 1]) {
    const provider = createMockProvider({
      script: [{ json: publishDecision({ confidence }) }],
      usage: new UsageTracker(),
    });

    const result = await evaluate([STRONG, PROMOTIONAL], { provider, minConfidence: 0.7 });

    assert.equal(result.decision, 'publish', `confidence ${confidence} should publish`);
    assert.equal(result.confidence, confidence);
  }
});

test('confidence: a publish below the floor becomes a skip', async () => {
  // The model's number is an editorial signal, not a calibrated probability,
  // which is exactly why the threshold is ours and the override is a skip
  // rather than a warning attached to a published post.
  const provider = createMockProvider({
    script: [{ json: publishDecision({ confidence: 0.42 }) }],
    usage: new UsageTracker(),
  });

  const result = await evaluate([STRONG, PROMOTIONAL], { provider, minConfidence: 0.7 });

  assert.equal(result.decision, 'skip');
  assert.equal(result.selectedCandidateIndex, null);
  assert.equal(result.candidate, null);
  assert.equal(result.angle, null);
  assert.equal(result.source, DECISION_SOURCES.CONFIDENCE_GATE);
  assert.ok(result.warnings.includes('below_confidence_floor'));

  // The original judgement stays legible in the reason, so the dashboard can
  // show why a good-looking candidate was not published.
  assert.match(result.reason, /Below the 0.7 confidence floor \(0.42\)/);
});

test('confidence: the threshold is configuration, not a constant', async () => {
  const decision = publishDecision({ confidence: 0.55 });

  const strict = await evaluate([STRONG, PROMOTIONAL], {
    provider: createMockProvider({ script: [{ json: decision }], usage: new UsageTracker() }),
    minConfidence: 0.8,
  });
  assert.equal(strict.decision, 'skip');

  const lenient = await evaluate([STRONG, PROMOTIONAL], {
    provider: createMockProvider({ script: [{ json: decision }], usage: new UsageTracker() }),
    minConfidence: 0.5,
  });
  assert.equal(lenient.decision, 'publish');
});

test('confidence: the gate never turns a skip into a publish', async () => {
  // A low-confidence skip is still a skip. Reading the gate as "low confidence
  // means do the opposite" would publish on the editor's least certain judgement.
  const provider = createMockProvider({
    script: [{ json: skipDecision({ confidence: 0.1 }) }],
    usage: new UsageTracker(),
  });

  const result = await evaluate([STRONG, PROMOTIONAL], { provider, minConfidence: 0.7 });

  assert.equal(result.decision, 'skip');
  assert.equal(result.source, DECISION_SOURCES.LLM);
});

test('confidence: the gate still costs exactly one call', async () => {
  const provider = createMockProvider({
    script: [{ json: publishDecision({ confidence: 0.1 }) }],
    usage: new UsageTracker(),
  });

  const result = await evaluate([STRONG, PROMOTIONAL], { provider, minConfidence: 0.7 });

  assert.equal(result.llmCalls, 1);
  assert.equal(provider.calls.length, 1);
});
