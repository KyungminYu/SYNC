import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { repoRoot } from '../../scripts/lib/databaseConfig.mjs';

/**
 * Dev-server only: lets the dashboard run and stop the test feeder
 * (scripts/feed-scenario.ts). The dashboard never writes to SpacetimeDB; the
 * feeder process does.
 *   POST   /__dev/feed  {"scenario":"Mid-2","viewer":"<hex>"} → starts a job (ends a running one)
 *   GET    /__dev/feed  → {running, state, lastLine, scenario, jobId, clock}
 *     clock = {startedAt, tickMs}: the job's global clock (tick n due at
 *     startedAt + n × tickMs), read from the feeder's `clock …` line
 *   DELETE /__dev/feed  → stops the running job (state "stopped"; its runs stay unfinished)
 */
export function devFeederPlugin(config: {
  uri: string;
  database: string;
}): Plugin {
  let child: ChildProcess | undefined;
  let lastLine = '';
  let state:
    | 'idle'
    | 'starting'
    | 'running'
    | 'completed'
    | 'failed'
    | 'stopped' = 'idle';
  let scenario: string | undefined;
  let jobId = 0;
  /** Global clock of the current job, once the feeder announced it. */
  let clock: { startedAt: number; tickMs: number } | undefined;
  return {
    name: 'sync-dev-feeder',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('close', () => child?.kill());
      server.middlewares.use('/__dev/feed', (req, res) => {
        const reply = (code: number, body: object) => {
          if (res.writableEnded) return;
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify(body));
        };
        // The endpoint writes via a privileged local process: allow same-origin only.
        if (
          req.headers.origin &&
          req.headers.origin !== `http://${req.headers.host}` &&
          req.headers.origin !== `https://${req.headers.host}`
        )
          return reply(403, {
            error: 'Cross-origin feeder requests are not allowed.',
          });
        if (req.method === 'GET')
          return reply(200, {
            running: !!child,
            state,
            lastLine,
            scenario,
            jobId,
            clock,
          });
        if (req.method === 'DELETE') {
          // Stop from the dashboard: the feeder ends, its runs stay where they are.
          const stopped = !!child;
          if (child) {
            state = 'stopped';
            lastLine = 'Stopped from the dashboard.';
            child.kill();
          }
          return reply(200, { stopped, jobId });
        }
        if (req.method !== 'POST')
          return reply(405, { error: 'POST, GET or DELETE required' });
        let raw = '';
        req.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
          if (raw.length > 4096) {
            reply(413, { error: 'Request too large' });
            req.destroy();
          }
        });
        req.on('error', () => reply(400, { error: 'Request interrupted' }));
        req.on('end', () => {
          if (res.writableEnded) return;
          let body: { scenario?: unknown; viewer?: unknown };
          try {
            body = JSON.parse(raw);
            if (!body || typeof body !== 'object') throw new Error();
          } catch {
            return reply(400, { error: 'Invalid JSON' });
          }
          const requested = String(body.scenario ?? '');
          const viewer = String(body.viewer ?? '');
          if (!/^(Low|Mid|High)-[123]$/.test(requested))
            return reply(400, { error: 'Scenario must be Low-1 … High-3' });
          if (!/^[0-9a-f]{64}$/.test(viewer))
            return reply(400, { error: 'Viewer must be a 64-hex identity' });
          // One scenario at a time: starting another ends the running one
          // (its runs stay unfinished, shown as stopped).
          if (child) {
            child.kill();
            child = undefined;
          }
          scenario = requested;
          lastLine = 'Starting scenario…';
          state = 'starting';
          jobId++;
          clock = undefined;
          const currentJobId = jobId;
          // Node resolves tsx's loader on every OS, without shell wrappers or .cmd files.
          const current = spawn(
            process.execPath,
            [
              '--import',
              'tsx',
              resolve(repoRoot, 'scripts/feed-scenario.ts'),
              '--scenario',
              scenario,
              '--uri',
              config.uri,
              '--db',
              config.database,
              '--viewer',
              viewer,
            ],
            {
              cwd: repoRoot,
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
            },
          );
          child = current;
          current.once('spawn', () => {
            state = 'running';
            reply(202, { started: true, scenario, jobId });
          });
          current.once('error', () => {
            state = 'failed';
            lastLine =
              'Could not launch the scenario feeder. Check Node and run pnpm install.';
            if (child === current) child = undefined;
            reply(500, { error: lastLine });
          });
          const keep = (chunk: Buffer) => {
            const lines = chunk.toString().trim().split('\n');
            for (const line of lines) {
              const m = line.match(/^clock (\d+) (\d+)$/);
              if (m && jobId === currentJobId)
                clock = { startedAt: Number(m[1]), tickMs: Number(m[2]) };
            }
            lastLine = (lines.at(-1) ?? lastLine).slice(-1000);
          };
          current.stdout?.on('data', keep);
          current.stderr?.on('data', keep);
          current.once('close', (code) => {
            if (jobId !== currentJobId) return;
            if (child === current) child = undefined;
            if (state !== 'failed' && state !== 'stopped')
              state = code === 0 ? 'completed' : 'failed';
            if (code !== 0 && state !== 'stopped' && !lastLine)
              lastLine = 'Scenario feeder stopped before completion.';
          });
        });
      });
    },
  };
}
