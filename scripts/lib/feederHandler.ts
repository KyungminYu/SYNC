import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { repoRoot } from './databaseConfig.mjs';

/** True when an Anthropic API key is set (environment, or root .env / .env.local). */
function llmAvailable() {
  if (process.env.ANTHROPIC_API_KEY) return true;
  return ['.env', '.env.local'].some((name) => {
    const path = resolve(repoRoot, name);
    return (
      existsSync(path) &&
      !!parseEnv(readFileSync(path, 'utf8')).ANTHROPIC_API_KEY
    );
  });
}

export function createFeederHandler(config: {
  uri: string;
  database: string;
  publicStatus?: boolean;
}) {
  let child: ChildProcess | undefined;
  let lastLine = '';
  let state:
    'idle' | 'starting' | 'running' | 'completed' | 'failed' | 'stopped' =
    'idle';
  let scenario: string | undefined;
  /** Planner of the current job's SYNC run. */
  let planner: 'algorithm' | 'llm' = 'algorithm';
  let jobId = 0;
  /** Global clock of the current job, once the feeder announced it. */
  let clock: { startedAt: number; tickMs: number } | undefined;
  return {
    close() {
      child?.kill();
    },
    handle(req: IncomingMessage, res: ServerResponse) {
      const reply = (code: number, body: object) => {
        if (res.writableEnded) return;
        res.statusCode = code;
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET')
        return reply(200, {
          running: !!child,
          state,
          lastLine: config.publicStatus
            ? state === 'failed'
              ? 'Scenario failed. Check the runner service logs.'
              : ''
            : lastLine,
          scenario,
          jobId,
          clock,
          planner,
          llmAvailable: llmAvailable(),
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
        let body: { scenario?: unknown; viewer?: unknown; planner?: unknown };
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
        const requestedPlanner = String(body.planner ?? 'algorithm');
        if (requestedPlanner !== 'algorithm' && requestedPlanner !== 'llm')
          return reply(400, { error: 'Planner must be algorithm or llm' });
        if (requestedPlanner === 'llm' && !llmAvailable())
          return reply(400, {
            error:
              'LLM planner needs ANTHROPIC_API_KEY in the repo root .env.local.',
          });
        if (child)
          return reply(409, {
            error:
              'A scenario is already running. Stop it before starting another.',
          });
        scenario = requested;
        planner = requestedPlanner;
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
            '--planner',
            planner,
          ],
          {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );
        child = current;
        current.once('spawn', () => {
          if (jobId !== currentJobId) return;
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
          if (jobId !== currentJobId) return;
          if (config.publicStatus) process.stdout.write(chunk);
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
    },
  };
}
