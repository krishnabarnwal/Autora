import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { Agent } from '../../src/models/index.js';
import { config } from '../../src/config/env.js';

const SENTINEL = {
  persona: {
    name: 'Sentinel',
    domain: 'AI Security',
    identity: 'An autonomous AI security researcher.',
    interests: ['prompt injection', 'model security'],
    editorialStandards: ['no speculation without sources'],
  },
};

test.before(async () => startTestDb());
test.after(async () => stopTestDb());
test.beforeEach(async () => clearTestDb());

test('agent: creates with generated agentId and ISO createdAt', async () => {
  const agent = await Agent.create(SENTINEL);
  assert.match(agent.agentId, /^agt_[0-9a-f]{16}$/);
  assert.equal(agent.persona.name, 'Sentinel');
  assert.equal(agent.persona.domain, 'AI Security');
  assert.equal(agent.status, 'initializing');
  assert.equal(agent.configuration.mode, 'demo');
  // The schema default is `() => config.agent.cycleIntervalMs`, so that is what
  // this asserts. A literal here would instead be asserting the developer's
  // AGENT_CYCLE_INTERVAL_MS, and would fail on any machine that sets it.
  assert.equal(agent.configuration.cycleIntervalMs, config.agent.cycleIntervalMs);
  assert.equal(agent.stats.postsPublished, 0);

  const createdAt = new Date(agent.createdAt.toISOString());
  assert.ok(!Number.isNaN(createdAt.getTime()), 'createdAt must be a valid date');
});

test('agent: agentId is unique', async () => {
  // Distinct personas: personaKey is unique, so the same persona intentionally
  // cannot produce two agents (see the idempotency test below).
  const first = await Agent.create(SENTINEL);
  const second = await Agent.create({ persona: { name: 'Ada', domain: 'AI Security' } });
  assert.notEqual(second.agentId, first.agentId, 'generated ids must differ');

  // Forcing a collision must be rejected by the unique index.
  second.agentId = first.agentId;
  await assert.rejects(second.save(), (err) => err.code === 11000);
});

test('agent: the same persona cannot create two agents', async () => {
  await Agent.create(SENTINEL);

  // Backs POST /api/agent/init idempotency: the database, not the handler, is
  // the arbiter, so concurrent inits cannot both win.
  await assert.rejects(Agent.create(SENTINEL), (err) => err.code === 11000);

  // Case and spacing differences must not slip past the constraint.
  await assert.rejects(
    Agent.create({ persona: { name: '  sentinel ', domain: 'ai   SECURITY' } }),
    (err) => err.code === 11000
  );

  assert.equal(await Agent.countDocuments({}), 1);
});

test('agent: personaKey is derived, not caller-supplied', async () => {
  const agent = await Agent.create({
    persona: { name: 'Ada', domain: 'AI Security' },
    personaKey: 'attacker-controlled',
  });
  assert.equal(agent.personaKey, 'ada::ai security');
});

test('agent: toPublicJSON exposes the contract shape without _id', async () => {
  const agent = await Agent.create(SENTINEL);
  const json = agent.toPublicJSON();
  assert.equal(json.agentId, agent.agentId);
  assert.equal(json.persona.name, 'Sentinel');
  assert.equal(json.status, 'initializing');
  assert.equal(typeof json.createdAt, 'string');
  assert.equal(typeof json.updatedAt, 'string');
  assert.equal(json._id, undefined);
  assert.equal(json.__v, undefined);
});

test('agent: resumable query picks up autonomous and initializing agents', async () => {
  // Distinct personas so the unique personaKey index does not reject them.
  await Agent.create({ persona: { name: 'Auto', domain: 'AI Security' }, status: 'autonomous' });
  await Agent.create({ persona: { name: 'Paused', domain: 'AI Security' }, status: 'paused' });
  await Agent.create({ persona: { name: 'Errored', domain: 'AI Security' }, status: 'error' });
  const resumable = await Agent.findResumable();
  assert.equal(resumable.length, 2);
  const statuses = resumable.map((a) => a.status).sort();
  assert.deepEqual(statuses, ['autonomous', 'error']);
});

test('agent: invalid status is rejected', async () => {
  await assert.rejects(Agent.create({ ...SENTINEL, status: 'flying' }));
});

test('agent: accepts a minimal persona (name + domain only)', async () => {
  const agent = await Agent.create({ persona: { name: 'Ada', domain: 'AI Security' } });
  assert.equal(agent.persona.name, 'Ada');
  assert.equal(agent.persona.interests.length, 0);
});
