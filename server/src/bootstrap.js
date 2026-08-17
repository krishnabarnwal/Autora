import { createApp } from './app.js';
import { config, publicConfig, validateConfig } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { syncIndexes, CycleRun } from './models/index.js';
import { getLlmProvider } from './services/llm/index.js';
import { Scheduler, setScheduler } from './scheduler/index.js';
import { setAgentInitializedHandler } from './utils/agentEvents.js';
import { logger } from './utils/logger.js';

const log = logger('SERVER');

/**
 * Close out cycle history rows that a previous process left open.
 *
 * A cycle's row is written `running` before the work starts and updated in place
 * when it ends, so a process that dies mid-cycle — a crash, a container
 * eviction, a redeploy — leaves a row that will never be closed by anyone. This
 * runs once at startup, before any worker is resumed, and marks those rows
 * `interrupted`.
 *
 * Two deliberate constraints:
 *
 *   - Scoped to rows that predate this boot, so a cycle this process is about to
 *     open can never be swept by its own recovery pass.
 *   - No completedAt, no durationMs. The cycle's real end time is genuinely
 *     unknown; writing the recovery time there would fabricate a duration for
 *     work that may have died a second in. `interrupted` is the whole claim.
 *
 * Non-fatal: history is bookkeeping, so a failed sweep is logged and the server
 * still starts. The rows stay `running` and the next boot tries again.
 *
 * Known limitation: with more than one server process sharing a database, this
 * sweep cannot distinguish another live instance's in-flight cycle from an
 * abandoned one, and would mark it interrupted. This deployment runs a single
 * instance; multi-instance recovery would need an owner/lease on the row.
 */
async function recoverInterruptedCycles() {
  try {
    const result = await CycleRun.markInterrupted({ startedBefore: new Date() });
    const count = result?.modifiedCount ?? 0;
    if (count > 0) {
      log.warn('Cycle history rows left open by a previous process marked interrupted', { count });
    }
    return count;
  } catch (err) {
    log.error('Could not recover interrupted cycle history; starting anyway', {
      message: err.message,
    });
    return 0;
  }
}

/**
 * Full server bootstrap: config validation, database connect + index sync,
 * cycle-history recovery, HTTP listen, signal handlers, and graceful shutdown.
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

  // Before any worker can open a new row, settle the ones the last process left.
  await recoverInterruptedCycles();

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
