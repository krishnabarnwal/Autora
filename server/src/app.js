import express from 'express';
import cors from 'cors';
import { config, publicConfig } from './config/env.js';
import { databaseStatus, pingDatabase } from './config/database.js';
import { agentRouter } from './routes/agent.js';
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

  // Liveness/readiness probe. Reports 503 when the database is unusable so a
  // deploy host can tell "process alive" from "actually able to serve".
  app.get('/api/health', async (req, res) => {
    const db = databaseStatus();
    const ping = db.healthy ? await pingDatabase() : { ok: false, error: db.status };
    const ok = db.healthy && ping.ok;

    res.status(ok ? 200 : 503).json({
      ok,
      service: 'autonomous-ai-creator',
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      ...publicConfig(),
      database: {
        ...db,
        ping: ping.ok ? { ok: true, latencyMs: ping.latencyMs } : { ok: false, error: ping.error },
      },
    });
  });

  // Public agent API (the problem statement contract).
  app.use('/api/agent', agentRouter());

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.originalUrl });
  });

  // Final error handler: never leak stack traces to clients.
  // eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity.
  app.use((err, req, res, next) => {
    // express.json() rejects malformed bodies without an error code; without
    // this a 400 would be reported to the client as "internal_error".
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON.' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'Request body is too large.' });
    }

    const status = err.status || 500;
    if (status >= 500) {
      log.error('Unhandled request error', { path: req.originalUrl, message: err.message });
    }
    return res.status(status).json({
      error: err.code || 'internal_error',
      message: status >= 500 ? 'Internal server error' : err.message,
    });
  });

  return app;
}
