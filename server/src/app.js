import express from 'express';
import cors from 'cors';
import { config, publicConfig } from './config/env.js';
import { logger } from './utils/logger.js';

const log = logger('HTTP');

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(
    cors({
      origin: config.corsOrigin.includes('*') ? true : config.corsOrigin,
    })
  );

  // Liveness/readiness probe. Phase 2 extends this with database state.
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      service: 'autonomous-ai-creator',
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      ...publicConfig(),
    });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.originalUrl });
  });

  // Final error handler: never leak stack traces to clients.
  // eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity.
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) {
      log.error('Unhandled request error', { path: req.originalUrl, message: err.message });
    }
    res.status(status).json({
      error: err.code || 'internal_error',
      message: status >= 500 ? 'Internal server error' : err.message,
    });
  });

  return app;
}
