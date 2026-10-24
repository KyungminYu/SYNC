import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import express from 'express';
import { z } from 'zod';
if (existsSync('.env')) loadEnvFile('.env');
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .default(3001)
  .parse(process.env.PORT);
const app = express();
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', integration: 'pending' }),
);
app.get('/ready', (_req, res) =>
  res.status(503).json({
    status: 'not_ready',
    reason:
      'Agent integration is not implemented. See docs/INTEGRATION_HANDOFF.md.',
  }),
);
const server = app.listen(port, '127.0.0.1', () =>
  console.info(
    'Agent integration placeholder listening on port ' +
      port +
      '. No jobs are claimed.',
  ),
);
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
