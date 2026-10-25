import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createFeederHandler } from './feederHandler';
import { repoRoot } from './databaseConfig.mjs';

export function createRunnerServer(
  config: { uri: string; database: string },
  token: string,
  origin: string,
  options: { webRoot?: string } = {},
) {
  if (token.length < 32 || !/^https?:\/\/[^/]+$/.test(origin))
    throw new Error(
      'Set SYNC_RUNNER_TOKEN (32+ characters) and SYNC_RUNNER_ORIGIN (exact dashboard origin).',
    );
  const feeder = createFeederHandler({ ...config, publicStatus: true });
  const webRoot = resolve(
    options.webRoot ?? resolve(repoRoot, 'apps/web/dist'),
  );
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
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      res.writeHead(400).end('Invalid URL');
      return;
    }
    if (path === '/health' && req.method === 'GET') {
      res.end(JSON.stringify({ status: 'ok', runtime: 'sync-container' }));
      return;
    }
    if (
      path === '/sync-config.js' &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.setHeader('x-content-type-options', 'nosniff');
      res.end(
        req.method === 'HEAD'
          ? undefined
          : `globalThis.__SYNC_CONFIG__ = ${JSON.stringify({ spacetimeUri: config.uri, database: config.database })};`,
      );
      return;
    }
    if (path === '/feed') {
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
              error:
                'Invalid runner access code. Retry with the operator code.',
            }),
          );
          return;
        }
      }
      res.setHeader('content-type', 'application/json');
      feeder.handle(req, res);
      return;
    }

    // Serve Vite's production build from the same origin as /feed.
    let requested: string;
    try {
      requested = decodeURIComponent(path === '/' ? '/index.html' : path);
    } catch {
      res.writeHead(400).end('Invalid path');
      return;
    }
    const file = resolve(webRoot, `.${requested}`);
    if (file !== webRoot && !file.startsWith(`${webRoot}${sep}`)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    void (async () => {
      try {
        let body: Buffer;
        let served = file;
        try {
          body = await readFile(file);
        } catch {
          if (extname(file)) {
            res.writeHead(404).end('File not found');
            return;
          }
          served = resolve(webRoot, 'index.html');
          body = await readFile(served);
        }
        const types: Record<string, string> = {
          '.css': 'text/css; charset=utf-8',
          '.html': 'text/html; charset=utf-8',
          '.ico': 'image/x-icon',
          '.js': 'text/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.woff2': 'font/woff2',
        };
        res.statusCode = 200;
        res.setHeader(
          'content-type',
          types[extname(served)] ?? 'application/octet-stream',
        );
        res.setHeader(
          'cache-control',
          served.endsWith('index.html')
            ? 'no-cache'
            : 'public, max-age=31536000, immutable',
        );
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch {
        res
          .writeHead(404)
          .end('Build the dashboard before starting the server.');
      }
    })();
  });
  return {
    server,
    close() {
      feeder.close();
      server.close();
    },
  };
}
