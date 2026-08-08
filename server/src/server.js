import { startServer } from './bootstrap.js';
import { disconnectDatabase } from './config/database.js';
import { logger } from './utils/logger.js';

const log = logger('SERVER');

// A background autonomous worker must never be killed by a stray rejection.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', { message: String(reason) });
});
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { message: err.message, stack: err.stack });
});

startServer()
  .then(({ shutdown }) => {
    let exiting = false;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, async () => {
        if (exiting) return;
        exiting = true;
        try {
          await shutdown(signal);
          process.exit(0);
        } catch {
          process.exit(1);
        }
      });
    }
  })
  .catch(async (err) => {
    log.error('Fatal startup error', { message: err.message });
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });
