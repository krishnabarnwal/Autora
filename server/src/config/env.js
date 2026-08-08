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

function float(value, fallback) {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value, fallback) {
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const agentMode = AGENT_MODES.includes(process.env.AGENT_MODE)
  ? process.env.AGENT_MODE
  : 'demo';

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 5000),
  corsOrigin: list(process.env.CORS_ORIGIN, ['http://localhost:5173']),

  db: {
    mongoUri: process.env.MONGODB_URI || '',
    // Explicit opt-in only: an in-process ephemeral MongoDB used solely for
    // local testing. Absent this flag, a missing MONGODB_URI is a startup
    // error instead of a silent fallback.
    useEphemeral: bool(process.env.USE_EPHEMERAL_DB, false),
    // Production must require a real connection string. NODE_ENV=production
    // or AGENT_MODE=production both count as production.
    requireMongoUri: process.env.NODE_ENV === 'production' || agentMode === 'production',
    // Escape hatch for networks whose local resolver cannot answer the SRV
    // queries that mongodb+srv:// requires. Empty means use system DNS.
    dnsServers: list(process.env.DNS_SERVERS, []),
  },

  llm: {
    provider: process.env.LLM_PROVIDER || 'gemini',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'gemini-3.5-flash',
  },

  agent: {
    mode: agentMode,
    // Same pipeline in both modes; only the cadence differs.
    cycleIntervalMs: agentMode === 'demo' ? 45_000 : 6 * 60 * 60 * 1000,
  },

  editorial: {
    // How many Phase 7 candidates the editorial judge may consider in one call.
    // The hard ceiling still lives in candidates.js; this is the tuning knob.
    maxCandidates: num(process.env.EDITORIAL_MAX_CANDIDATES, 8),
    // Below this, the application overrides a publish decision to skip. The
    // model's confidence is an editorial signal, not a calibrated probability.
    minConfidence: float(process.env.EDITORIAL_MIN_CONFIDENCE, 0.7),
    // Whether the agent is permitted to publish nothing this cycle. True by
    // default: an editor that cannot decline is not exercising judgement.
    allowSkip: bool(process.env.EDITORIAL_ALLOW_SKIP, true),
  },
};

export const serverPaths = { root: serverRoot };

/**
 * Fail fast on an unusable configuration rather than degrading at runtime.
 *
 * The critical rule: production/evaluation must never silently fall back to an
 * ephemeral database, because every published post would vanish on restart and
 * the feed contract ("previously returned posts remain available") would break.
 *
 * @returns {{warnings: string[]}}
 * @throws {Error} when the configuration cannot support the selected mode
 */
export function validateConfig(cfg = config) {
  const errors = [];
  const warnings = [];

  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    errors.push(`PORT must be a valid port number, received "${process.env.PORT}"`);
  }

  if (cfg.db.requireMongoUri) {
    if (!cfg.db.mongoUri) {
      errors.push(
        'MONGODB_URI is required in production (NODE_ENV=production or AGENT_MODE=production). ' +
          'Refusing to start: an ephemeral database would lose every published post on restart.'
      );
    }
    if (cfg.db.useEphemeral) {
      errors.push(
        'USE_EPHEMERAL_DB cannot be enabled in production. ' +
          'The ephemeral database is a local testing aid only.'
      );
    }
  } else if (!cfg.db.mongoUri && !cfg.db.useEphemeral) {
    errors.push(
      'MONGODB_URI is not set. Set it to a real MongoDB connection string, ' +
        'or set USE_EPHEMERAL_DB=true to explicitly opt into an in-process ' +
        'ephemeral database for local testing (data is lost on shutdown).'
    );
  }

  if (cfg.db.mongoUri && !/^mongodb(\+srv)?:\/\//.test(cfg.db.mongoUri)) {
    errors.push('MONGODB_URI must start with mongodb:// or mongodb+srv://');
  }

  // A placeholder left in from .env.example is a common and confusing failure.
  if (/<[^>]+>/.test(cfg.db.mongoUri)) {
    errors.push(
      'MONGODB_URI still contains a <placeholder>. Replace it with the real value ' +
        '(and URL-encode any special characters in the password).'
    );
  }

  if (cfg.db.useEphemeral && cfg.db.mongoUri) {
    warnings.push('USE_EPHEMERAL_DB=true overrides MONGODB_URI; the real database will not be used.');
  }

  if (!['gemini', 'mock'].includes(cfg.llm.provider)) {
    errors.push(`LLM_PROVIDER must be "gemini" or "mock", received "${cfg.llm.provider}"`);
  }

  // Phase 8 wired the provider up, so a missing key now has consequences. In
  // production it is fatal for the same reason an ephemeral database is: the
  // agent would start, run its cycle on schedule, and publish nothing, which
  // reads as a working deployment. In development it stays a warning so the
  // rest of the pipeline can be worked on without a key.
  if (cfg.llm.provider !== 'mock' && !cfg.llm.apiKey) {
    const message =
      `LLM_API_KEY is not set but LLM_PROVIDER="${cfg.llm.provider}" needs it. ` +
      'Set LLM_API_KEY, or set LLM_PROVIDER=mock to run without an external model.';
    if (cfg.db.requireMongoUri) {
      errors.push(`${message} Refusing to start: every cycle would fail and no post would ever publish.`);
    } else {
      warnings.push(message);
    }
  }

  if (!Number.isInteger(cfg.editorial.maxCandidates)
    || cfg.editorial.maxCandidates < 1 || cfg.editorial.maxCandidates > 10) {
    errors.push(
      `EDITORIAL_MAX_CANDIDATES must be an integer between 1 and 10, received "${process.env.EDITORIAL_MAX_CANDIDATES}". ` +
        'The upper bound is the prompt-size cap in services/llm/candidates.js.'
    );
  }

  if (!(cfg.editorial.minConfidence >= 0 && cfg.editorial.minConfidence <= 1)) {
    errors.push(
      `EDITORIAL_MIN_CONFIDENCE must be between 0 and 1, received "${process.env.EDITORIAL_MIN_CONFIDENCE}"`
    );
  }

  if (!cfg.editorial.allowSkip) {
    warnings.push(
      'EDITORIAL_ALLOW_SKIP=false forces a publish every cycle. The agent will fall back to its '
        + 'top-ranked candidate when it judges that nothing is worth publishing.'
    );
  }

  if (errors.length) {
    const error = new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
    error.code = 'invalid_config';
    throw error;
  }

  return { warnings };
}

/** Redacted view of config, safe to log or expose over HTTP. */
export function publicConfig() {
  return {
    env: config.env,
    agentMode: config.agent.mode,
    cycleIntervalMs: config.agent.cycleIntervalMs,
    llmProvider: config.llm.provider,
    llmModel: config.llm.model,
    llmConfigured: Boolean(config.llm.apiKey),
    databaseConfigured: Boolean(config.db.mongoUri),
  };
}
