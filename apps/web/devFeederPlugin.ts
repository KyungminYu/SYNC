import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Dev-server only: lets the dashboard start the test feeder
 * (scripts/feed-scenario.ts) for checking work in progress. The dashboard
 * never writes to SpacetimeDB itself; it asks this local endpoint, and the
 * feeder process writes the scenario.
 *
 *   POST /__dev/feed  {"scenario":"Mid-2","viewer":"<identity hex>"}
 *     202 started · 409 a feeder is already running · 400 bad input
 *   GET  /__dev/feed  → {"running": boolean, "lastLine": string}
 */
export function devFeederPlugin(database: string): Plugin {
  const repoRoot = resolve(__dirname, '../..');
  let child: ChildProcess | undefined;
  let lastLine = '';
  return {
    name: 'sync-dev-feeder',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/feed', (req, res) => {
        const reply = (code: number, body: object) => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method === 'GET')
          return reply(200, { running: !!child, lastLine });
        if (req.method !== 'POST') return reply(405, { error: 'POST or GET' });
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          let body: { scenario?: string; viewer?: string };
          try {
            body = JSON.parse(raw || '{}');
          } catch {
            return reply(400, { error: 'invalid JSON' });
          }
          const scenario = String(body.scenario ?? '');
          const viewer = String(body.viewer ?? '');
          // Fixed scenario ids (sync/scenarioCatalog.ts): Low-1 … High-3.
          if (!/^(Low|Mid|High)-[123]$/.test(scenario))
            return reply(400, { error: 'scenario must be Low-1 … High-3' });
          if (!/^[0-9a-f]{64}$/.test(viewer))
            return reply(400, { error: 'viewer must be a 64-hex identity' });
          if (child) return reply(409, { error: 'a feeder is already running', lastLine });
          // Same command as `corepack pnpm feed …`, run from the repo root.
          child = spawn(
            resolve(repoRoot, 'node_modules/.bin/tsx'),
            ['scripts/feed-scenario.ts', '--scenario', scenario, '--db', database, '--viewer', viewer],
            { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          const keep = (chunk: Buffer) => {
            const lines = chunk.toString().trim().split('\n');
            lastLine = lines[lines.length - 1] ?? lastLine;
          };
          child.stdout?.on('data', keep);
          child.stderr?.on('data', keep);
          child.on('exit', () => (child = undefined));
          reply(202, { started: true, scenario });
        });
      });
    },
  };
}
