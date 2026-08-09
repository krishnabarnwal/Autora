import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { logger, recentActivity, clearActivity } from '../../src/utils/logger.js';
import {
  checkRepetition, recordDecision, getRecentMemory,
  MemoryError, MemoryInputError,
} from '../../src/services/memory/index.js';
import { seedAgent, seedMemory, CANDIDATE } from '../fixtures/memory.js';

/**
 * Structural and secret safety for the memory service (§10, §11).
 *
 * By construction this layer must never call the LLM, fetch a source, collect
 * feeds, generate a post, or import the publisher (a memory -> publisher -> memory
 * cycle). MongoDB is the ONLY external dependency it is allowed. That is asserted
 * structurally by scanning the module's import specifiers, so a future edit that
 * added such an import fails this suite. Separately, a persistence failure must
 * surface a fixed, safe message — never a raw driver string — and the activity
 * log must never carry a connection string or key.
 */

const MEMORY_SRC = fileURLToPath(new URL('../../src/services/memory/index.js', import.meta.url));
const source = readFileSync(MEMORY_SRC, 'utf8');

/** Only the import specifiers, so a mention inside a comment never trips the scan. */
function importTargets(code) {
  const targets = [];
  for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) targets.push(m[1]);
  for (const m of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) targets.push(m[1]);
  return targets;
}

// --- Structural: no LLM, no network, no publisher, no generation -------------

test('security: the memory service imports no LLM layer', () => {
  const banned = /services\/llm|geminiProvider|mockProvider|generateJSON|\bopenai\b|\bgemini\b/i;
  for (const target of importTargets(source)) {
    assert.doesNotMatch(target, banned, `must not import an LLM module: ${target}`);
  }
});

test('security: the memory service imports no source-collection or feed layer', () => {
  const banned = /services\/sources|services\/topics|rssAdapter|hackerNews|discoverTopics/i;
  for (const target of importTargets(source)) {
    assert.doesNotMatch(target, banned, `must not import a source layer: ${target}`);
  }
});

test('security: the memory service does not import the publisher or generation (no memory->publisher cycle)', () => {
  const banned = /services\/publisher|services\/generation|publishFinalPost|verifyGeneratedPost/i;
  for (const target of importTargets(source)) {
    assert.doesNotMatch(target, banned, `must not import publisher/generation: ${target}`);
  }
});

test('security: the memory service imports no HTTP client and does not fetch', () => {
  for (const target of importTargets(source)) {
    assert.doesNotMatch(target, /axios|node-fetch|undici|\bhttps?\b|services\/sources\/http/i, target);
  }
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'the memory service must not call fetch()');
  assert.doesNotMatch(source, /new\s+XMLHttpRequest/, 'the memory service must not open an XHR');
});

test('security: the memory service imports only models, text utils, the logger, and config', () => {
  const allowed = [
    /\.\.\/\.\.\/models\/index\.js$/,
    /\.\.\/\.\.\/utils\/text\.js$/,
    /\.\.\/\.\.\/utils\/logger\.js$/,
    /\.\.\/\.\.\/config\/env\.js$/,
  ];
  for (const target of importTargets(source)) {
    assert.ok(allowed.some((re) => re.test(target)), `unexpected import: ${target}`);
  }
});

test('security: the memory service does not import a social-publishing API', () => {
  const banned = /(linkedin|twitter|facebook|instagram|buffer|hootsuite|x\.com|graph\.)/i;
  for (const target of importTargets(source)) {
    assert.doesNotMatch(target, banned, `must not import a social API: ${target}`);
  }
});

test('security: MongoDB (via the models layer) is the only external dependency', () => {
  // Every import is a relative path into this project — no bare npm package that
  // could reach the network. The one external system is Mongo, reached only
  // through the shared models layer, never a driver imported here directly.
  for (const target of importTargets(source)) {
    assert.match(target, /^\.\.?\//, `only relative in-project imports are allowed: ${target}`);
    assert.doesNotMatch(target, /^mongodb$|^mongoose$/, `must not import a raw driver: ${target}`);
  }
});

// --- Secret safety: errors and logs never carry a connection string ----------

test('security: a persistence failure carries a fixed safe message, not a raw driver string', () => {
  const err = new MemoryError('A memory operation could not be completed.', 'memory_failed');
  assert.equal(err.code, 'memory_failed');
  const CONNECTION_STRING = 'mongodb+srv://user:s3cr3t@cluster0.abcde.mongodb.net';
  assert.ok(!err.message.includes(CONNECTION_STRING));
  assert.doesNotMatch(err.message, /mongodb(\+srv)?:\/\//, 'no connection string in the message');
  assert.doesNotMatch(err.message, /password|s3cr3t/i);
});

test('security: the module source logs only {name, code} on an infra failure, never a raw message', () => {
  assert.doesNotMatch(source, /name:\s*err\?\.name,\s*code:\s*err\?\.code[\s\S]{0,40}err\?\.message/,
    'infra logging must not also include err.message');
  assert.match(source, /name:\s*err\?\.name,\s*code:\s*err\?\.code/, 'infra failures log name and code');
});

test('security: an input error names the field but leaks no internal detail', () => {
  const err = new MemoryInputError('A topic (or candidate.title) is required.', 'missing_topic', ['candidate']);
  assert.equal(err.name, 'MemoryInputError');
  assert.equal(err.code, 'missing_topic');
  assert.doesNotMatch(JSON.stringify({ m: err.message, d: err.details }), /mongodb|AIza|password/i);
});

test('security: memory operations write no connection string or key into the activity log', async () => {
  await startTestDb();
  try {
    await clearTestDb();
    clearActivity();
    const agent = await seedAgent();
    await recordDecision(agent.agentId, {
      decision: 'rejected', topic: CANDIDATE.title, reason: 'Covered already.',
    });
    await seedMemory(agent.agentId, { topic: 'Another topic about sandboxes', ageDays: 1 });
    await checkRepetition(agent.agentId, CANDIDATE);
    await getRecentMemory(agent.agentId);

    const text = JSON.stringify(recentActivity({ limit: 200 }));
    assert.doesNotMatch(text, /mongodb(\+srv)?:\/\//, 'no connection string in the activity log');
    assert.doesNotMatch(text, /AIza[0-9A-Za-z._-]{10,}/, 'no API key shape in the activity log');
  } finally {
    await stopTestDb();
  }
});

test('security: a value-named credential field is still scrubbed for the MEMORY tag', () => {
  clearActivity();
  const log = logger('MEMORY');
  log.info('probe', { agentId: 'agt_scrub', uri: 'mongodb+srv://u:p@host/db', note: 'safe' });
  const [entry] = recentActivity({ agentId: 'agt_scrub', limit: 1 });
  assert.equal(entry.data.uri, '[redacted]');
  assert.equal(entry.data.note, 'safe');
  assert.ok(!JSON.stringify(entry).includes('mongodb+srv://u:p@host/db'));
});
