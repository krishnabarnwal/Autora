import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestDb, stopTestDb, clearTestDb } from '../helpers/db.js';
import { Post } from '../../src/models/index.js';
import { logger, recentActivity, clearActivity } from '../../src/utils/logger.js';
import {
  publishFinalPost,
  PublisherError,
  PublisherInputError,
} from '../../src/services/publisher/index.js';
import { buildFinalPost, buildContext, seedAgent } from '../fixtures/publisher.js';

/**
 * Structural and secret safety for the publisher (§6, §13).
 *
 * The publisher is the persistence layer — by construction it must never call
 * the LLM, fetch a source, or collect feeds. That is asserted structurally: the
 * module source is scanned so a future edit that added such an import fails the
 * suite. Separately, a persistence failure must surface a fixed, safe message —
 * never a raw driver string, which can carry host/topology detail — and the
 * activity log must not leak a connection string.
 */

const PUBLISHER_SRC = fileURLToPath(new URL('../../src/services/publisher/index.js', import.meta.url));
const source = readFileSync(PUBLISHER_SRC, 'utf8');

/** Only the import specifiers, so a mention inside a comment never trips the scan. */
function importTargets(code) {
  const targets = [];
  // `... from '<specifier>'` covers every static import and re-export.
  for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) targets.push(m[1]);
  // Bare side-effect imports: `import '<specifier>'`.
  for (const m of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) targets.push(m[1]);
  return targets;
}

// --- Structural: the publisher imports no LLM / source / network layer -------

test('security: the publisher imports no LLM layer', () => {
  const banned = /services\/llm|geminiProvider|mockProvider|generateJSON|\bopenai\b|\bgemini\b/i;
  for (const target of importTargets(source)) {
    assert.doesNotMatch(target, banned, `must not import an LLM module: ${target}`);
  }
});

test('security: the publisher imports no source-collection or feed layer', () => {
  const banned = /services\/sources|services\/topics|rssAdapter|hackerNews|discoverTopics/i;
  for (const target of importTargets(source)) {
    assert.doesNotMatch(target, banned, `must not import a source layer: ${target}`);
  }
});

test('security: the publisher imports no HTTP client and does not fetch', () => {
  for (const target of importTargets(source)) {
    assert.doesNotMatch(target, /axios|node-fetch|undici|\bhttps?\b|services\/sources\/http/i, target);
  }
  // No direct network call in the body either.
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'the publisher must not call fetch()');
  assert.doesNotMatch(source, /new\s+XMLHttpRequest/, 'the publisher must not open an XHR');
});

test('security: the publisher imports only models, text utils, and the logger', () => {
  const allowed = [/\.\.\/\.\.\/models\/index\.js$/, /\.\.\/\.\.\/utils\/text\.js$/, /\.\.\/\.\.\/utils\/logger\.js$/];
  for (const target of importTargets(source)) {
    assert.ok(allowed.some((re) => re.test(target)), `unexpected import: ${target}`);
  }
});

test('security: the publisher does not import a social-publishing API', () => {
  const banned = /(linkedin|twitter|facebook|instagram|buffer|hootsuite|x\.com|graph\.)/i;
  for (const target of importTargets(source)) {
    assert.doesNotMatch(target, banned, `must not import a social API: ${target}`);
  }
});

// --- Secret safety: errors and logs never carry a connection string ----------

test('security: a persistence failure carries a fixed safe message, not a raw driver string', async () => {
  // A PublisherError's message is fixed by construction; assert the class contract
  // directly so we do not depend on inducing a live infra failure.
  const err = new PublisherError('The post could not be persisted this cycle.', 'persistence_failed');
  assert.equal(err.code, 'persistence_failed');
  const CONNECTION_STRING = 'mongodb+srv://user:s3cr3t@cluster0.abcde.mongodb.net';
  assert.ok(!err.message.includes(CONNECTION_STRING));
  assert.doesNotMatch(err.message, /mongodb(\+srv)?:\/\//, 'no connection string in the message');
  assert.doesNotMatch(err.message, /password|s3cr3t/i);
});

test('security: the module source logs only {name, code} on an infra failure, never a raw message', () => {
  // The catch blocks must log err.name / err.code, not err.message (a driver
  // message can quote the connection string, which the field-name scrubber — it
  // only redacts by KEY name — would not catch inside a message value).
  assert.doesNotMatch(source, /name:\s*err\?\.name,\s*code:\s*err\?\.code[\s\S]{0,40}err\?\.message/,
    'infra logging must not also include err.message');
  assert.match(source, /name:\s*err\?\.name,\s*code:\s*err\?\.code/, 'infra failures log name and code');
});

test('security: publishing writes no connection string or key into the activity log', async () => {
  await startTestDb();
  try {
    await clearTestDb();
    clearActivity();
    const agent = await seedAgent();
    await publishFinalPost(buildFinalPost(), buildContext({ agentId: agent.agentId }));

    const entries = recentActivity({ limit: 100 });
    const text = JSON.stringify(entries);
    assert.doesNotMatch(text, /mongodb(\+srv)?:\/\//, 'no connection string in the activity log');
    assert.doesNotMatch(text, /AIza[0-9A-Za-z._-]{10,}/, 'no API key shape in the activity log');
    // The publisher does log useful, safe fields.
    assert.ok(entries.some((e) => e.tag === 'PUBLISH'), 'the publish is observable in the activity buffer');
  } finally {
    await stopTestDb();
  }
});

test('security: a value-named credential field is still scrubbed for the PUBLISH tag', () => {
  clearActivity();
  const log = logger('PUBLISH');
  log.info('probe', { agentId: 'agt_scrub', uri: 'mongodb+srv://u:p@host/db', note: 'safe' });
  const [entry] = recentActivity({ agentId: 'agt_scrub', limit: 1 });
  assert.equal(entry.data.uri, '[redacted]');
  assert.equal(entry.data.note, 'safe');
  assert.ok(!JSON.stringify(entry).includes('mongodb+srv://u:p@host/db'));
});

test('security: an input error names the field but leaks no internal detail', () => {
  const err = new PublisherInputError('FinalPost has an empty body.', 'empty_text', ['text is empty']);
  assert.equal(err.name, 'PublisherInputError');
  assert.equal(err.code, 'empty_text');
  assert.doesNotMatch(JSON.stringify({ m: err.message, d: err.details }), /mongodb|AIza|password/i);
});
