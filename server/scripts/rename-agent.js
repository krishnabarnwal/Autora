/**
 * One-time maintenance: give an agent a professional persona name in place.
 *
 * The agent's display name lives in MongoDB (persona.name), set when it was first
 * initialized — it is runtime data, not a value in the code. This script renames
 * it without disturbing anything the agent has done: the same document keeps its
 * agentId, its cycle history, its published posts and its decision memory.
 *
 * Why this is safe:
 *   - personaKey (the unique idempotency key for POST /api/agent/init) is derived
 *     from name+domain by a pre('validate') hook on the schema, so .save()
 *     recomputes it automatically — no orphaned key, no duplicate agent.
 *   - The scheduler resumes agents by status, not by name (findResumable), so a
 *     rename never detaches a running loop from its worker.
 *   - Only persona.name changes; domain, configuration, stats and timestamps are
 *     untouched.
 *
 * Usage (from server/):
 *   npm run rename-agent                         rename the sole agent to the default
 *   npm run rename-agent -- --name "New Name"    choose the name
 *   npm run rename-agent -- --agentId agt_123    disambiguate when several exist
 *
 * It writes to the database this server is configured for (MONGODB_URI). Run it
 * yourself against your own deployment; nothing here runs automatically.
 */

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { Agent } from '../src/models/index.js';
import { logger } from '../src/utils/logger.js';

const log = logger('RENAME');

const DEFAULT_NAME = 'Autora Security Agent';

/** Read `--flag value` and `--flag=value` for the two flags this script accepts. */
function parseArgs(argv) {
  const args = { name: DEFAULT_NAME, agentId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const take = (inline) => (inline !== undefined ? inline : argv[(i += 1)]);
    if (token === '--name' || token.startsWith('--name=')) {
      args.name = take(token.startsWith('--name=') ? token.slice('--name='.length) : undefined);
    } else if (token === '--agentId' || token.startsWith('--agentId=')) {
      args.agentId = take(token.startsWith('--agentId=') ? token.slice('--agentId='.length) : undefined);
    }
  }
  return args;
}

/**
 * Resolve which agent to rename. An explicit id wins; otherwise there must be
 * exactly one agent, or the caller is asked to disambiguate rather than the
 * script guessing.
 */
async function resolveAgent(agentId) {
  if (agentId) {
    const agent = await Agent.findOne({ agentId });
    if (!agent) throw new Error(`No agent found with agentId "${agentId}".`);
    return agent;
  }

  const agents = await Agent.find().sort({ createdAt: 1 });
  if (agents.length === 0) throw new Error('No agent exists yet. Initialize one first.');
  if (agents.length > 1) {
    const list = agents.map((a) => `  ${a.agentId}  ${a.persona?.name} (${a.persona?.domain})`).join('\n');
    throw new Error(`Several agents exist — pass --agentId to choose one:\n${list}`);
  }
  return agents[0];
}

async function main() {
  const { name, agentId } = parseArgs(process.argv.slice(2));
  const newName = String(name || '').trim();
  if (!newName) throw new Error('The new name cannot be empty.');

  await connectDatabase();

  const agent = await resolveAgent(agentId);
  const before = { name: agent.persona.name, personaKey: agent.personaKey };

  if (before.name === newName) {
    log.info('No change: the agent already has this name', { agentId: agent.agentId, name: newName });
    return;
  }

  agent.persona.name = newName;
  await agent.save(); // pre('validate') recomputes personaKey from name+domain

  log.info('Renamed agent in place', {
    agentId: agent.agentId,
    domain: agent.persona.domain,
    before: before.name,
    after: agent.persona.name,
    personaKeyBefore: before.personaKey,
    personaKeyAfter: agent.personaKey,
  });
  log.info('History, posts and decisions are unchanged — same agentId.');
}

main()
  .catch((err) => {
    log.error('Rename failed', { message: err.message });
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase().catch(() => {});
  });
