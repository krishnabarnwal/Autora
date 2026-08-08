import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..', '..');

// Load server/.env if present. Missing file is fine: hosts inject real env vars.
dotenv.config({ path: path.join(serverRoot, '.env'), quiet: true });

const AGENT_MODES = ['demo', 'production'];

function num(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value, fallback) {
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const agentMode = AGENT_MODES.includes(process.env.AGENT_MODE)
  ? process.env.AGENT_MODE
  : 'demo';

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 5000),
  corsOrigin: list(process.env.CORS_ORIGIN, ['http://localhost:5173']),

  mongoUri: process.env.MONGODB_URI || '',

  llm: {
    provider: process.env.LLM_PROVIDER || 'gemini',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'gemini-2.5-flash',
  },

  agent: {
    mode: agentMode,
    // Same pipeline in both modes; only the cadence differs.
    cycleIntervalMs: agentMode === 'demo' ? 45_000 : 6 * 60 * 60 * 1000,
  },
};

export const serverPaths = { root: serverRoot };

/** Redacted view of config, safe to log or expose over HTTP. */
export function publicConfig() {
  return {
    env: config.env,
    agentMode: config.agent.mode,
    cycleIntervalMs: config.agent.cycleIntervalMs,
    llmProvider: config.llm.provider,
    llmModel: config.llm.model,
    llmConfigured: Boolean(config.llm.apiKey),
    databaseConfigured: Boolean(config.mongoUri),
  };
}
