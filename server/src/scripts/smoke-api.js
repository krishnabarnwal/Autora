/**
 * Live API smoke check for the Phase 4-5 endpoints.
 *
 * Runs against the configured database (real Atlas, not a mock) through the
 * real startup path, then removes everything it created.
 *
 * Usage: node src/scripts/smoke-api.js
 */
import { startServer } from '../bootstrap.js';
import { config } from '../config/env.js';
import { Agent, Post, TopicMemory } from '../models/index.js';

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function main() {
  console.log('--- Live API smoke check (Phase 4-5) ---\n');

  const { shutdown } = await startServer();
  const base = `http://localhost:${config.port}`;
  // Unique persona so repeated smoke runs never collide with a leftover agent.
  const persona = { name: `SmokeApi ${Date.now().toString(36)}`, domain: 'AI Security' };
  let agentId = null;

  try {
    // --- POST /api/agent/init ---
    const init = await call(base, '/api/agent/init', json({ persona }));
    agentId = init.body?.agentId;
    check('init returns 201 + {agentId}', init.status === 201 && /^agt_[0-9a-f]{16}$/.test(agentId || ''),
      `status=${init.status} body=${JSON.stringify(init.body)}`);
    check('init response has exactly one key', JSON.stringify(Object.keys(init.body || {})) === '["agentId"]');

    const persisted = await Agent.findOne({ agentId });
    check('agent persisted in MongoDB', Boolean(persisted), `status=${persisted?.status}`);

    const repeat = await call(base, '/api/agent/init', json({ persona }));
    check('init is safe to call twice (200, same id)',
      repeat.status === 200 && repeat.body?.agentId === agentId, `status=${repeat.status}`);
    check('no duplicate agent created', (await Agent.countDocuments({ agentId })) === 1);

    const noPersona = await call(base, '/api/agent/init', json({}));
    check('init rejects missing persona with 400',
      noPersona.status === 400 && noPersona.body?.error === 'persona_required', `status=${noPersona.status}`);

    const noName = await call(base, '/api/agent/init', json({ persona: { domain: 'AI Security' } }));
    check('init rejects missing name with 400', noName.status === 400 && noName.body?.error === 'name_required');

    const noDomain = await call(base, '/api/agent/init', json({ persona: { name: 'Ada' } }));
    check('init rejects missing domain with 400', noDomain.status === 400 && noDomain.body?.error === 'domain_required');

    // --- GET /api/agent/feed ---
    const empty = await call(base, `/api/agent/feed?agentId=${agentId}`);
    check('feed is {"posts":[]} before anything is published',
      empty.status === 200 && JSON.stringify(empty.body) === '{"posts":[]}', JSON.stringify(empty.body));

    // Seed two posts directly, the way the Phase 12 worker eventually will.
    const older = await Post.create({
      agentId, topic: 'Prompt injection in retrieval pipelines',
      text: 'Older smoke post.', rationale: 'Older rationale.',
      sources: ['https://example.com/older'],
    });
    await Post.updateOne({ postId: older.postId }, { $set: { createdAt: new Date(Date.now() - 60_000) } });
    await Post.create({
      agentId, topic: 'Model weight exfiltration risk',
      text: 'Newer smoke post.', rationale: 'Newer rationale.',
      sources: ['https://example.com/newer'],
    });

    const feed = await call(base, `/api/agent/feed?agentId=${agentId}`);
    const posts = feed.body?.posts || [];
    check('feed returns both posts', feed.status === 200 && posts.length === 2, `count=${posts.length}`);
    check('feed is newest-first', posts[0]?.text === 'Newer smoke post.', `first=${posts[0]?.text}`);
    check('post shape is exactly the contract',
      JSON.stringify(Object.keys(posts[0] || {}).sort()) === '["createdAt","id","rationale","sources","text"]',
      JSON.stringify(Object.keys(posts[0] || {})));
    check('createdAt is ISO 8601 UTC',
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(posts[0]?.createdAt || ''), posts[0]?.createdAt);

    const countBefore = await Post.countDocuments({ agentId });
    await call(base, `/api/agent/feed?agentId=${agentId}`);
    await call(base, `/api/agent/feed?agentId=${agentId}`);
    check('feed creates no posts', (await Post.countDocuments({ agentId })) === countBefore);

    const missing = await call(base, '/api/agent/feed');
    check('feed rejects a missing agentId with 400',
      missing.status === 400 && missing.body?.error === 'agent_id_required', `status=${missing.status}`);

    const unknown = await call(base, '/api/agent/feed?agentId=agt_0000000000000000');
    check('feed 404s an unknown agentId',
      unknown.status === 404 && unknown.body?.error === 'agent_not_found', `status=${unknown.status}`);

    // --- Secret hygiene across every response ---
    const all = JSON.stringify([init.body, repeat.body, feed.body, missing.body, unknown.body]).toLowerCase();
    const leaked = ['mongodb+srv://', '@cluster', 'dmgcspf', 'password', 'apikey', 'llm_api_key']
      .filter((needle) => all.includes(needle));
    check('no secrets in any API response', leaked.length === 0, leaked.join(', ') || 'clean');
  } finally {
    if (agentId) {
      await Promise.all([
        Agent.deleteOne({ agentId }),
        Post.deleteMany({ agentId }),
        TopicMemory.deleteMany({ agentId }),
      ]);
      const leftover = await Post.countDocuments({ agentId });
      check('smoke records cleaned up', leftover === 0 && (await Agent.countDocuments({ agentId })) === 0);
    }
    await shutdown('SMOKE_API');
  }

  console.log(`\n--- ${results.length - failed}/${results.length} passed ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nAPI SMOKE CHECK FAILED:', err.message);
  process.exit(1);
});
