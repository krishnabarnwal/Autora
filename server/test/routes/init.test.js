import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { startTestServer, stopTestServer, post, request } from '../helpers/http.js';
import { Agent } from '../../src/models/index.js';

const ADA = { persona: { name: 'Ada', domain: 'AI Security' } };

test.before(async () => {
  await startTestDb();
  await startTestServer();
});
test.after(async () => {
  await stopTestServer();
  await stopTestDb();
});
test.beforeEach(async () => clearTestDb());

// --- 1. Successful initialization -----------------------------------------

test('init: creates an agent and returns the contract shape', async () => {
  const res = await post('/api/agent/init', ADA);

  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body), ['agentId'], 'response must be exactly {agentId}');
  assert.match(res.body.agentId, /^agt_[0-9a-f]{16}$/);
});

test('init: persists the agent in MongoDB with an appropriate initial status', async () => {
  const res = await post('/api/agent/init', ADA);

  const stored = await Agent.findOne({ agentId: res.body.agentId });
  assert.ok(stored, 'agent must be persisted, not held in memory');
  assert.equal(stored.persona.name, 'Ada');
  assert.equal(stored.persona.domain, 'AI Security');
  // The autonomous worker arrives in Phase 12, so claiming "autonomous" here
  // would misreport reality.
  assert.equal(stored.status, 'initializing');
  assert.equal(stored.stats.postsPublished, 0);
});

test('init: accepts an optional richer persona without breaking the contract', async () => {
  const res = await post('/api/agent/init', {
    persona: {
      name: 'Sentinel',
      domain: 'AI Security',
      identity: 'An autonomous AI security researcher.',
      interests: ['prompt injection', 'agent security'],
      editorialStandards: ['no speculation without sources'],
    },
  });

  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body), ['agentId']);

  const stored = await Agent.findOne({ agentId: res.body.agentId });
  assert.equal(stored.persona.interests.length, 2);
  assert.equal(stored.persona.editorialStandards.length, 1);
});

// --- 2/3/4. Validation failures -------------------------------------------

test('init: rejects a missing persona', async () => {
  const res = await post('/api/agent/init', {});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'persona_required');
  assert.equal(await Agent.countDocuments({}), 0, 'nothing may be persisted on a rejected request');
});

test('init: rejects a missing name', async () => {
  const res = await post('/api/agent/init', { persona: { domain: 'AI Security' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'name_required');
  assert.equal(await Agent.countDocuments({}), 0);
});

test('init: rejects a missing domain', async () => {
  const res = await post('/api/agent/init', { persona: { name: 'Ada' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'domain_required');
  assert.equal(await Agent.countDocuments({}), 0);
});

test('init: rejects blank, wrong-typed, and oversized persona fields', async () => {
  const cases = [
    [{ persona: { name: '   ', domain: 'AI Security' } }, 'name_required'],
    [{ persona: { name: 'Ada', domain: '  ' } }, 'domain_required'],
    [{ persona: { name: 42, domain: 'AI Security' } }, 'name_required'],
    [{ persona: { name: 'Ada', domain: { nested: true } } }, 'domain_required'],
    [{ persona: 'Ada' }, 'persona_invalid'],
    [{ persona: ['Ada'] }, 'persona_invalid'],
    [{ persona: null }, 'persona_required'],
    [{ persona: { name: 'A'.repeat(81), domain: 'AI Security' } }, 'name_too_long'],
    [{ persona: { name: 'Ada', domain: 'D'.repeat(121) } }, 'domain_too_long'],
  ];

  for (const [body, expected] of cases) {
    const res = await post('/api/agent/init', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(res.body.error, expected, `wrong code for ${JSON.stringify(body)}`);
  }
  assert.equal(await Agent.countDocuments({}), 0);
});

test('init: rejects a malformed JSON body as 400, not 500', async () => {
  const res = await request('/api/agent/init', { method: 'POST', raw: '{"persona": ' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_json');
});

// --- 5. Unique agent ids ---------------------------------------------------

test('init: distinct personas receive unique agent ids', async () => {
  const personas = [
    { name: 'Ada', domain: 'AI Security' },
    { name: 'Sentinel', domain: 'AI Security' },
    { name: 'Ada', domain: 'Cloud Infrastructure' },
    { name: 'Turing', domain: 'Cryptography' },
  ];

  const ids = [];
  for (const persona of personas) {
    const res = await post('/api/agent/init', { persona });
    assert.equal(res.status, 201);
    ids.push(res.body.agentId);
  }

  assert.equal(new Set(ids).size, personas.length, 'every agent id must be unique');
  assert.equal(await Agent.countDocuments({}), personas.length);
});

// --- Safe to call multiple times ------------------------------------------

test('init: repeat calls are idempotent and return the same agentId', async () => {
  const first = await post('/api/agent/init', ADA);
  const second = await post('/api/agent/init', ADA);
  const third = await post('/api/agent/init', ADA);

  assert.equal(first.status, 201, 'first call creates');
  assert.equal(second.status, 200, 'later calls reuse');
  assert.equal(third.status, 200);
  assert.equal(second.body.agentId, first.body.agentId);
  assert.equal(third.body.agentId, first.body.agentId);
  assert.equal(await Agent.countDocuments({}), 1, 'must not spawn a rival agent');
});

test('init: idempotency ignores case and whitespace differences', async () => {
  const first = await post('/api/agent/init', ADA);
  const variant = await post('/api/agent/init', {
    persona: { name: '  ada  ', domain: 'ai   security' },
  });

  assert.equal(variant.status, 200);
  assert.equal(variant.body.agentId, first.body.agentId);
  assert.equal(await Agent.countDocuments({}), 1);
});

test('init: concurrent identical calls still yield one agent', async () => {
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => post('/api/agent/init', ADA))
  );

  const ids = new Set(responses.map((res) => res.body.agentId));
  assert.equal(ids.size, 1, 'a race must not create two agents');
  assert.equal(await Agent.countDocuments({}), 1);
  assert.equal(responses.filter((res) => res.status === 201).length, 1, 'exactly one create');
});

// --- Secret hygiene --------------------------------------------------------

test('init: response exposes no configuration or secrets', async () => {
  const res = await post('/api/agent/init', ADA);
  const serialized = JSON.stringify(res.body);

  for (const forbidden of ['mongodb', '@cluster', 'apiKey', 'LLM_API_KEY', 'password']) {
    assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `leaked ${forbidden}`);
  }
});
