import express from 'express';
import { healthSchema } from '@sync/contracts';
export function createApp(
  ready: () => boolean,
  mode: 'deterministic' | 'claude',
) {
  const app = express();
  app.get('/health', (_req, res) =>
    res.json(healthSchema.parse({ status: 'ok', database: ready(), mode })),
  );
  app.get('/ready', (_req, res) =>
    res.status(ready() ? 200 : 503).json(
      healthSchema.parse({
        status: ready() ? 'ok' : 'not_ready',
        database: ready(),
        mode,
      }),
    ),
  );
  return app;
}
