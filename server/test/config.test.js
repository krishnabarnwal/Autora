import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config/env.js';

/**
 * The central safety property of Phase 2: production must never silently
 * degrade to an ephemeral database.
 */

/** Minimal valid config, overridable per case (nested objects merge). */
function makeConfig(overrides = {}) {
  const { db, llm, agent, editorial, ...rest } = overrides;
  return {
    env: 'development',
    port: 5000,
    ...rest,
    db: {
      mongoUri: 'mongodb://localhost:27017/test',
      useEphemeral: false,
      requireMongoUri: false,
      ...db,
    },
    llm: { provider: 'gemini', apiKey: 'set', model: 'gemini-2.5-flash', ...llm },
    agent: { mode: 'demo', cycleIntervalMs: 45_000, ...agent },
    // Phase 9 added editorial validation to validateConfig; the real config
    // always builds this block, so the minimal fixture must mirror its shape.
    editorial: { maxCandidates: 8, minConfidence: 0.7, allowSkip: true, ...editorial },
  };
}

test('config: accepts a valid development configuration', () => {
  const { warnings } = validateConfig(makeConfig());
  assert.deepEqual(warnings, []);
});

test('config: production REQUIRES MONGODB_URI', () => {
  assert.throws(
    () => validateConfig(makeConfig({ db: { mongoUri: '', requireMongoUri: true } })),
    (err) => err.code === 'invalid_config' && /MONGODB_URI is required in production/.test(err.message)
  );
});

test('config: production REFUSES the ephemeral database even with a URI present', () => {
  assert.throws(
    () =>
      validateConfig(
        makeConfig({ db: { mongoUri: 'mongodb://localhost:27017/x', useEphemeral: true, requireMongoUri: true } })
      ),
    (err) => /USE_EPHEMERAL_DB cannot be enabled in production/.test(err.message)
  );
});

test('config: development without a URI fails unless ephemeral is explicitly opted into', () => {
  assert.throws(
    () => validateConfig(makeConfig({ db: { mongoUri: '', useEphemeral: false } })),
    (err) => /MONGODB_URI is not set/.test(err.message)
  );

  // Explicit opt-in is allowed in development.
  const { warnings } = validateConfig(makeConfig({ db: { mongoUri: '', useEphemeral: true } }));
  assert.deepEqual(warnings, []);
});

test('config: ephemeral opt-in alongside a real URI warns that the URI is ignored', () => {
  const { warnings } = validateConfig(
    makeConfig({ db: { mongoUri: 'mongodb://localhost:27017/x', useEphemeral: true } })
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /overrides MONGODB_URI/);
});

test('config: rejects a malformed MONGODB_URI', () => {
  assert.throws(
    () => validateConfig(makeConfig({ db: { mongoUri: 'http://not-mongo' } })),
    (err) => /must start with mongodb/.test(err.message)
  );
});

test('config: rejects an unreplaced <placeholder> in MONGODB_URI', () => {
  assert.throws(
    () =>
      validateConfig(
        makeConfig({ db: { mongoUri: 'mongodb+srv://user:<password>@cluster0.example.net/' } })
      ),
    (err) => /still contains a <placeholder>/.test(err.message)
  );
});

test('config: rejects an unknown LLM provider and an invalid port', () => {
  assert.throws(() => validateConfig(makeConfig({ llm: { provider: 'openai' } })), /LLM_PROVIDER/);
  assert.throws(() => validateConfig(makeConfig({ port: 0 })), /PORT must be a valid port/);
});

test('config: missing LLM key warns in development but does not block startup', () => {
  const { warnings } = validateConfig(makeConfig({ llm: { apiKey: '' } }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /LLM_API_KEY is not set/);
  // The warning has to name the way out, or it just reads as noise.
  assert.match(warnings[0], /LLM_PROVIDER=mock/);
});

test('config: missing LLM key is fatal in production', () => {
  // Same principle as the database rule above: a deployment that starts,
  // schedules cycles, and publishes nothing is worse than one that refuses.
  assert.throws(
    () => validateConfig(makeConfig({ llm: { apiKey: '' }, db: { requireMongoUri: true } })),
    (err) => {
      assert.equal(err.code, 'invalid_config');
      assert.match(err.message, /LLM_API_KEY is not set/);
      assert.match(err.message, /no post would ever publish/);
      return true;
    }
  );

  // Explicitly choosing the mock is a valid production configuration for a
  // demo deployment, and must not be blocked by the key rule.
  const { warnings } = validateConfig(
    makeConfig({ llm: { provider: 'mock', apiKey: '' }, db: { requireMongoUri: true } })
  );
  assert.deepEqual(warnings, []);
});

test('config: rejects an out-of-range EDITORIAL_MAX_CANDIDATES', () => {
  // The upper bound is the prompt-size cap in candidates.js, so it is a hard
  // error rather than a clamp: a config that would blow the budget must not start.
  for (const maxCandidates of [0, 11, 2.5]) {
    assert.throws(
      () => validateConfig(makeConfig({ editorial: { maxCandidates } })),
      (err) => err.code === 'invalid_config' && /EDITORIAL_MAX_CANDIDATES must be an integer/.test(err.message),
      `maxCandidates=${maxCandidates} should be rejected`
    );
  }
});

test('config: rejects an EDITORIAL_MIN_CONFIDENCE outside 0..1', () => {
  for (const minConfidence of [-0.1, 1.5]) {
    assert.throws(
      () => validateConfig(makeConfig({ editorial: { minConfidence } })),
      /EDITORIAL_MIN_CONFIDENCE must be between 0 and 1/
    );
  }
  // The bounds themselves are valid.
  assert.deepEqual(validateConfig(makeConfig({ editorial: { minConfidence: 0 } })).warnings, []);
  assert.deepEqual(validateConfig(makeConfig({ editorial: { minConfidence: 1 } })).warnings, []);
});

test('config: EDITORIAL_ALLOW_SKIP=false warns rather than blocking', () => {
  // Forcing a publish every cycle is a legitimate demo choice, but it changes
  // the agent's behaviour enough to deserve a startup warning.
  const { warnings } = validateConfig(makeConfig({ editorial: { allowSkip: false } }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EDITORIAL_ALLOW_SKIP=false forces a publish/);
});
