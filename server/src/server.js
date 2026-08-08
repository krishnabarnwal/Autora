import { createApp } from './app.js';
import { config, publicConfig } from './config/env.js';
import { logger } from './utils/logger.js';

const log = logger('SERVER');

async function main() {
  const app = createApp();

  const server = app.listen(config.port, () => {
    log.info(`Listening on http://localhost:${config.port}`, publicConfig());
  });

  const shutdown = (signal) => {
    log.info(`Received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    // Don't hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A background autonomous worker must never be killed by a stray rejection.
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', { message: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { message: err.message });
  });
}

main().catch((err) => {
  log.error('Fatal startup error', { message: err.message });
  process.exit(1);
});
