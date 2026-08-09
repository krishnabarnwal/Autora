import { createApp } from './app.js';
import { config, publicConfig, validateConfig } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { syncIndexes } from './models/index.js';
import { getLlmProvider } from './services/llm/index.js';
import { Scheduler, setScheduler } from './scheduler/index.js';
import { setAgentInitializedHandler } from './utils/agentEvents.js';
import { logger } from './utils/logger.js';

const log = logger('SERVER');

/**
 * Full server bootstrap: config validation, database connect + index sync,
 * HTTP listen, signal handlers, and graceful shutdown.
 *
 * Extracted from server.js so tests and smoke scripts can drive the exact
 * production startup/shutdown path.
 *
 * @returns {Promise<{server: import('node:http').Server, shutdown: (signal:string)=>Promise<void>}>}
 */
export async function startServer() {
  // Fail before binding a port if the configuration cannot support this mode.
  const { warnings } = validateConfig();
  for (const warning of warnings) log.warn(warning);

  await connectDatabase();
  await syncIndexes();

  const app = createApp();

  const server = await new Promise((resolve, reject) => {
    const httpServer = app.listen(config.port);
    httpServer.once('listening', () => resolve(httpServer));
    httpServer.once('error', reject);
  });

  log.info(`Listening on http://localhost:${config.port}`, publicConfig());

  // The autonomous loop starts only here, in the real server bootstrap. Tests
  // build the app directly via createApp(), so they never register a worker and
  // never arm a timer.
  const scheduler = new Scheduler({ provider: getLlmProvider() });
  setScheduler(scheduler);
  // Newly created agents begin cycling immediately: the init route announces
  // them, and this is the only place that connects that announcement to the
  // scheduler, keeping the HTTP layer free of any scheduler dependency.
  setAgentInitializedHandler((agentId) => scheduler.register(agentId));
  const resumed = await scheduler.resumeAll();
  log.info('Autonomous scheduler started', {
    agents: resumed,
    cycleIntervalMs: config.agent.cycleIntervalMs,
    maxBackoffMs: config.agent.maxBackoffMs,
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);

    // Hard cap: never hang a deploy host waiting on a stuck socket.
    const failsafe = setTimeout(() => {
      log.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000);
    failsafe.unref();

    // Stop the cycles first: a worker must never start a cycle against a
    // database that is already closing. stopAll clears every pending timer, so
    // nothing is left holding the event loop open, and detaching the init hook
    // stops a late request from registering a worker mid-shutdown.
    setAgentInitializedHandler(null);
    scheduler.stopAll();
    setScheduler(null);

    try {
      await new Promise((resolve) => server.close(resolve));
      log.info('HTTP server closed');
      await disconnectDatabase();
      clearTimeout(failsafe);
      log.info('Shutdown complete');
    } catch (err) {
      log.error('Error during shutdown', { message: err.message });
      throw err;
    }
  };

  // Signal handling belongs to the process entrypoint (server.js), not here,
  // so tests can call shutdown() directly without touching process state.
  return { server, shutdown, scheduler };
}
