import { loadEnvFile } from 'node:process';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import express from 'express';
import { DbConnection } from '@sync/bindings';
import {
  databaseConfig,
  repoRoot,
} from '../../../scripts/lib/databaseConfig.mjs';
import type { ExecutionJob, ExecutionOutcome } from './adapter.ts';

if (existsSync(resolve(repoRoot, '.env')))
  loadEnvFile(resolve(repoRoot, '.env'));
const config = databaseConfig();
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid PORT');
// No adapter is silently selected. Demo must be explicitly enabled.
const adapterPath = process.env.SYNC_AGENT_ADAPTER;
const adapterUrl =
  adapterPath === 'demo'
    ? new URL('./demoAdapter.ts', import.meta.url).href
    : adapterPath
      ? pathToFileURL(resolve(repoRoot, adapterPath)).href
      : undefined;
const runId = process.env.SYNC_AGENT_RUN_ID
  ? BigInt(process.env.SYNC_AGENT_RUN_ID)
  : undefined;
const scope = createHash('sha256')
  .update(`${config.uri}\n${config.database}`)
  .digest('hex')
  .slice(0, 16);
const dir = resolve(repoRoot, '.local', 'agents');
mkdirSync(dir, { recursive: true });
const tokenFile = resolve(dir, `${scope}.token`);
const lockFile = resolve(dir, `${scope}.lock`);
let locked = false;
if (adapterUrl && runId !== undefined) {
  try {
    const fd = openSync(lockFile, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    locked = true;
  } catch {
    throw new Error(
      `Agent supervisor lock exists: ${lockFile}. Verify the previous supervisor is stopped before removing its stale lock.`,
    );
  }
}
let connected = false,
  subscribed = false,
  identity: string | undefined,
  stopping = false;
let connection: DbConnection | undefined;
type Slot = {
  child: ChildProcess;
  ready: boolean;
  busy?: string;
  cancelSent?: boolean;
  startedAt?: number;
};
const slots = new Map<string, Slot>();
const handling = new Set<string>();
const settled = new Set<string>();
const outcomes = new Map<
  string,
  { jobId: bigint; attempt: number; outcome: ExecutionOutcome }
>();
const app = express();
app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    identity,
    processes: slots.size,
    connected,
    runId: runId?.toString(),
    adapter: adapterPath === 'demo' ? 'demo' : 'custom',
  }),
);
app.get('/ready', (_req, res) => {
  const authorized =
    connection &&
    runId !== undefined &&
    [...connection.db.serviceWorkers.iter()].some(
      (r) => r.runId === runId && r.mode === 'claude',
    );
  const ready = !!(
    adapterUrl &&
    connected &&
    subscribed &&
    authorized &&
    !stopping
  );
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    reason: ready
      ? undefined
      : 'Configure adapter and run ID, then grant this identity service membership.',
    identity,
    processes: slots.size,
  });
});
const server = app.listen(port, '127.0.0.1', () =>
  console.info(
    `Agent supervisor on ${port}. ${adapterUrl && runId !== undefined ? 'Connecting.' : 'Set SYNC_AGENT_ADAPTER and SYNC_AGENT_RUN_ID to enable workers.'}`,
  ),
);
function spawnSlot(id: string): Slot {
  const child = fork(
    fileURLToPath(new URL('./worker.ts', import.meta.url)),
    [],
    {
      cwd: repoRoot,
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, SYNC_AGENT_ADAPTER_URL: adapterUrl },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    },
  );
  const slot: Slot = { child, ready: false };
  slots.set(id, slot);
  child.on(
    'message',
    (message: {
      type: string;
      jobId?: string;
      attempt?: number;
      outcome?: ExecutionOutcome;
    }) => {
      if (message.type === 'ready') slot.ready = true;
      if (
        message.type === 'result' &&
        message.jobId === slot.busy &&
        message.attempt !== undefined
      ) {
        outcomes.set(message.jobId!, {
          jobId: BigInt(message.jobId!),
          attempt: message.attempt,
          outcome: message.outcome ?? 'uncertain',
        });
        // Hold process assignment until the result has been committed in the DB.
      }
    },
  );
  const lost = () => {
    if (slots.get(id) === slot) slots.delete(id);
    if (slot.busy) {
      const job = [...(connection?.db.serviceJobs.iter() ?? [])].find(
        (j) => String(j.id) === slot.busy,
      );
      if (job && !outcomes.has(slot.busy))
        outcomes.set(slot.busy, {
          jobId: job.id,
          attempt: job.attempt,
          outcome: 'uncertain',
        });
    }
  };
  child.once('exit', lost);
  child.once('error', lost);
  return slot;
}
let pumping = false;
async function pump() {
  if (
    pumping ||
    !connected ||
    !subscribed ||
    !connection ||
    runId === undefined ||
    stopping
  )
    return;
  pumping = true;
  try {
    const conn = connection;
    const run = [...conn.db.serviceWorkers.iter()].find(
      (r) => r.runId === runId && r.mode === 'claude',
    );
    if (!run) {
      for (const slot of slots.values())
        if (slot.busy && slot.child.connected)
          slot.child.send({ type: 'cancel', jobId: slot.busy });
      return;
    }
    const workers = [...conn.db.serviceWorkers.iter()].filter(
      (w) => w.runId === runId,
    );
    for (const worker of workers) {
      const key = String(worker.id);
      const slot = slots.get(key);
      if (worker.enabled && !slot) spawnSlot(key);
      if (!worker.enabled && slot && !slot.busy) {
        slot.child.disconnect();
        slots.delete(key);
      }
    }
    const jobs = [...conn.db.serviceJobs.iter()].filter(
      (j) => j.runId === runId,
    );
    for (const [id, result] of outcomes) {
      await conn.reducers.reportAgentResult({ runId, ...result });
      outcomes.delete(id);
      settled.add(id);
      const slot = [...slots.values()].find((s) => s.busy === id);
      if (slot) {
        slot.busy = undefined;
        slot.cancelSent = false;
      }
    }
    for (const job of jobs) {
      const id = String(job.id);
      if (settled.has(id)) continue;
      const slot = slots.get(String(job.workerId));
      if (
        job.status === 'cancel_requested' &&
        job.mine &&
        slot?.busy === id &&
        !slot.cancelSent
      ) {
        slot.cancelSent = true;
        slot.child.send({ type: 'cancel', jobId: id });
      }
      if (
        job.mine &&
        ['claimed', 'accepted', 'cancel_requested'].includes(job.status) &&
        slot?.busy !== id &&
        !handling.has(id) &&
        !outcomes.has(id)
      ) {
        // Supervisor restart: never replay an accepted external action blindly.
        outcomes.set(id, {
          jobId: job.id,
          attempt: job.attempt,
          outcome: 'uncertain',
        });
        continue;
      }
      if (
        run.runStatus !== 'running' ||
        job.status !== 'pending' ||
        !slot?.ready ||
        slot.busy ||
        handling.has(id)
      )
        continue;
      handling.add(id);
      slot.busy = id;
      try {
        await conn.reducers.claimAgentJob({ runId, jobId: job.id });
        await conn.reducers.submitAgentAction({
          runId,
          jobId: job.id,
          attempt: job.attempt,
          action: job.expectedAction,
        });
        const payload: ExecutionJob = {
          id,
          runId: String(runId),
          workerId: String(job.workerId),
          taskId: String(job.taskId),
          attempt: job.attempt,
          action: job.expectedAction,
          observation: JSON.parse(job.observationJson),
        };
        slot.startedAt = performance.now();
        slot.child.send({ type: 'execute', job: payload });
      } catch {
        // Cache catches up next pump; if this identity claimed it, reconciliation retains claims.
        slot.busy = undefined;
      } finally {
        handling.delete(id);
      }
    }
  } catch (error) {
    console.error(
      'Supervisor operation failed:',
      error instanceof Error ? error.message : 'unknown error',
    );
  } finally {
    pumping = false;
  }
}
if (adapterUrl && runId !== undefined) {
  connection = DbConnection.builder()
    .withUri(config.uri)
    .withDatabaseName(config.database)
    .withToken(
      existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8') : undefined,
    )
    .onConnect((conn, id, token) => {
      connected = true;
      identity = id.toHexString();
      writeFileSync(tokenFile, token, { mode: 0o600 });
      console.info(
        `Grant service membership to agent identity ${identity} for run ${runId}.`,
      );
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          subscribed = true;
        })
        .onError(() => {
          subscribed = false;
        })
        .subscribe([
          'SELECT * FROM service_workers',
          'SELECT * FROM service_jobs',
        ]);
    })
    .onConnectError(() =>
      console.error(
        'Agent DB connection failed; check URL/database and published schema.',
      ),
    )
    .onDisconnect(() => {
      connected = false;
      subscribed = false;
      for (const slot of slots.values())
        if (slot.busy) slot.child.send({ type: 'cancel', jobId: slot.busy });
    })
    .build();
}
const timer = setInterval(() => void pump(), 100);
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  for (const slot of slots.values()) {
    if (slot.busy) slot.child.send({ type: 'cancel', jobId: slot.busy });
    slot.child.disconnect();
  }
  connection?.disconnect();
  server.close();
  if (process.connected) process.disconnect?.();
  // Unacknowledged work is intentionally still reserved; next launch marks it uncertain.
  if (locked) {
    unlinkSync(lockFile);
    locked = false;
  }
}
process.on('message', (message: { type?: string }) => {
  if (message?.type === 'shutdown') shutdown();
});
process.on('disconnect', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  if (locked)
    try {
      unlinkSync(lockFile);
    } catch {
      /* retained lock is safe */
    }
});
