import mongoose from 'mongoose';
import dns from 'node:dns';
import { config } from './env.js';
import { logger } from '../utils/logger.js';

const log = logger('DB');

// Some networks run a stub resolver that cannot answer the SRV queries behind
// mongodb+srv://. DNS_SERVERS lets the operator point Node at public DNS.
if (config.db.dnsServers.length) {
  dns.setServers(config.db.dnsServers);
  log.info('Using explicit DNS servers', { servers: config.db.dnsServers });
}

/**
 * MongoDB connection lifecycle.
 *
 * MongoDB/Mongoose is the real persistent store. An in-process ephemeral
 * MongoDB exists only for local testing and requires an explicit
 * USE_EPHEMERAL_DB=true opt-in; env validation forbids it in production.
 */

const READY_STATE = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
  99: 'uninitialized',
};

/** @type {{kind:'mongodb'|'ephemeral'|null, connectedAt:string|null, lastError:string|null, attempts:number}} */
const state = { kind: null, connectedAt: null, lastError: null, attempts: 0 };

/** Holds the mongodb-memory-server instance so shutdown can stop it. */
let ephemeralServer = null;

/**
 * Resolve the URI to connect to. Starting an ephemeral server is only reachable
 * through the explicit opt-in checked by validateConfig().
 */
async function resolveUri() {
  if (config.db.useEphemeral) {
    log.warn('USE_EPHEMERAL_DB=true — starting in-process ephemeral MongoDB (LOCAL TESTING ONLY)');
    log.warn('All data will be lost when this process exits');
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    ephemeralServer = await MongoMemoryServer.create();
    return { uri: ephemeralServer.getUri('autonomous_ai_creator'), kind: 'ephemeral' };
  }
  return { uri: config.db.mongoUri, kind: 'mongodb' };
}

/**
 * Connect to MongoDB with bounded retries.
 *
 * @param {{retries?: number, retryDelayMs?: number}} [options]
 */
export async function connectDatabase({ retries = 3, retryDelayMs = 2000 } = {}) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  const { uri, kind } = await resolveUri();
  state.kind = kind;

  mongoose.set('strictQuery', true);

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    state.attempts = attempt;
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
        maxPoolSize: 10,
        retryWrites: true,
      });

      state.connectedAt = new Date().toISOString();
      state.lastError = null;
      log.info('Connected', { kind, database: mongoose.connection.name, attempt });

      // Surface post-handshake drops; the driver reconnects on its own.
      mongoose.connection.on('error', (err) => {
        state.lastError = err.message;
        log.error('Connection error', { message: err.message });
      });
      mongoose.connection.on('disconnected', () => log.warn('Disconnected'));
      mongoose.connection.on('reconnected', () => {
        state.lastError = null;
        log.info('Reconnected');
      });

      return mongoose.connection;
    } catch (err) {
      state.lastError = err.message;
      const last = attempt === retries;
      log.error(`Connection attempt ${attempt}/${retries} failed`, { message: err.message });
      if (last) {
        throw new Error(
          `Could not connect to MongoDB after ${retries} attempts: ${err.message}\n` +
            'Verify MONGODB_URI, that your IP is allowed in Atlas Network Access, ' +
            'and that any special characters in the password are URL-encoded.'
        );
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }

  throw new Error('unreachable');
}

/** Close the connection and stop the ephemeral server if one is running. */
export async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close(false);
    log.info('Connection closed');
  }
  if (ephemeralServer) {
    await ephemeralServer.stop();
    ephemeralServer = null;
    log.info('Ephemeral MongoDB stopped');
  }
  state.kind = null;
  state.connectedAt = null;
}

/**
 * Connection status for /api/health. Contains no credentials.
 * Accepts a connection so tests can exercise the disconnected path.
 */
export function databaseStatus(connection = mongoose.connection) {
  const readyState = connection.readyState;
  return {
    status: READY_STATE[readyState] ?? 'unknown',
    healthy: readyState === 1,
    kind: state.kind,
    persistent: state.kind === 'mongodb',
    database: connection.name || null,
    connectedAt: state.connectedAt,
    connectionAttempts: state.attempts,
    lastError: state.lastError,
  };
}

/** Round-trip ping, so health reflects the server rather than local state. */
export async function pingDatabase(connection = mongoose.connection) {
  if (connection.readyState !== 1) return { ok: false, error: 'not connected' };
  try {
    const started = process.hrtime.bigint();
    await connection.db.admin().ping();
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { ok: true, latencyMs: Math.round(latencyMs * 100) / 100 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
