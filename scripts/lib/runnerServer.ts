import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createFeederHandler } from './feederHandler';

export function createRunnerServer(
  config: { uri: string; database: string },
  token: string,
  origin: string,
) {
  if (token.length < 32 || !/^https?:\/\/[^/]+$/.test(origin))
    throw new Error(
      'Set SYNC_RUNNER_TOKEN (32+ characters) and SYNC_RUNNER_ORIGIN (exact dashboard origin).',
    );
  const feeder = createFeederHandler({ ...config, publicStatus: true });
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json');
    res.setHeader('Vary', 'Origin');
    if (req.headers.origin && req.headers.origin !== origin) {
      res.writeHead(403).end(JSON.stringify({ error: 'Origin not allowed.' }));
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.url !== '/feed') {
      res.writeHead(404).end('{}');
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    // Read-only status supports the public dashboard. Mutations require an
    // operator credential supplied interactively, never compiled into the UI.
    if (req.method !== 'GET') {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        res.writeHead(401).end(
          JSON.stringify({
            error: 'Invalid runner access code. Retry with the operator code.',
          }),
        );
        return;
      }
    }
    feeder.handle(req, res);
  });
  return {
    server,
    close() {
      feeder.close();
      server.close();
    },
  };
}
