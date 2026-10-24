import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fork } from 'node:child_process';
import { DbConnection } from '../packages/bindings/src/index.ts';
import { Identity } from 'spacetimedb';
import { databaseConfig, repoRoot } from './lib/databaseConfig.mjs';
const config = databaseConfig();
const scope = createHash('sha256')
  .update(`${config.uri}\n${config.database}`)
  .digest('hex')
  .slice(0, 16);
const dir = resolve(repoRoot, '.local', 'agents');
mkdirSync(dir, { recursive: true });
function connect(file: string, queries: string[]) {
  return new Promise<DbConnection>((resolveConnection, reject) => {
    const timeout = setTimeout(() => {
      conn.disconnect();
      reject(new Error('Connection timeout'));
    }, 15000);
    const conn = DbConnection.builder()
      .withUri(config.uri)
      .withDatabaseName(config.database)
      .withToken(existsSync(file) ? readFileSync(file, 'utf8') : undefined)
      .onConnect((c, _id, token) => {
        writeFileSync(file, token, { mode: 0o600 });
        c.subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timeout);
            resolveConnection(c);
          })
          .onError(() => {
            clearTimeout(timeout);
            c.disconnect();
            reject(new Error('Publish current module before running demo'));
          })
          .subscribe(queries);
      })
      .onConnectError(() => {
        clearTimeout(timeout);
        reject(new Error('Connection failed'));
      })
      .build();
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const service = await connect(resolve(dir, `${scope}.token`), [
  'SELECT * FROM service_jobs',
]);
const serviceId = service.identity!;
// Persist this owner identity so the run remains controllable after this script exits.
const ownerFile = resolve(dir, `${scope}.owner.token`);
const conn = await connect(ownerFile, [
  'SELECT * FROM ui_runs',
  'SELECT * FROM ui_workers',
]);
const name = `External demo ${randomUUID()}`;
let child: ReturnType<typeof fork> | undefined;
try {
  await conn.reducers.createRun({
    name,
    seed: 5,
    trayCount: 2,
    mode: 'claude',
    budgetMicrousd: undefined,
  });
  let run = [...conn.db.uiRuns.iter()].find((r) => r.name === name);
  const deadline = Date.now() + 15000;
  while (!run && Date.now() < deadline) {
    await sleep(50);
    run = [...conn.db.uiRuns.iter()].find((r) => r.name === name);
  }
  if (!run) throw new Error('Run not visible');
  const runId = run.id;
  await conn.reducers.grantMember({
    runId,
    identity: serviceId,
    permission: 'service',
    enabled: true,
  });
  const viewer = process.argv.indexOf('--viewer');
  if (viewer >= 0)
    await conn.reducers.grantMember({
      runId,
      identity: Identity.fromString(process.argv[viewer + 1]),
      permission: 'viewer',
      enabled: true,
    });
  await conn.reducers.setPolicy({
    runId,
    configJson: JSON.stringify({ policy: 'primal_dual' }),
  });
  for (let i = 0; i < 3; i++)
    await conn.reducers.enqueueCart({
      runId,
      cartKey: `external-${i}`,
      items: [
        { recipe: 'latte', quantity: 3 },
        { recipe: 'black_coffee', quantity: 2 },
      ],
      deadlineInTicks: 150,
      value: 2,
      priority: 1,
      customerUseTicks: 2,
    });
  await conn.reducers.closeArrivals({ runId });
  writeFileSync(
    resolve(dir, 'latest-run.json'),
    JSON.stringify(
      {
        uri: config.uri,
        database: config.database,
        runId: String(runId),
        serviceIdentity: serviceId.toHexString(),
        ownerTokenFile: ownerFile,
      },
      null,
      2,
    ),
  );
  child = fork(resolve(repoRoot, 'apps/agent-service/src/main.ts'), [], {
    cwd: repoRoot,
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      SPACETIME_URI: config.uri,
      SPACETIMEDB_DATABASE: config.database,
      SYNC_AGENT_ADAPTER: 'demo',
      SYNC_AGENT_RUN_ID: String(runId),
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  await conn.reducers.setRunStatus({ runId, running: true });
  console.info(
    `External demo run ${runId}; real subprocesses with explicit simulated coffee adapter.`,
  );
  const end = Date.now() + 180000;
  let peak = 0;
  let cancelled = false;
  while (Date.now() < end) {
    await sleep(100);
    if (process.argv.includes('--cancel-once') && !cancelled) {
      const job = [...service.db.serviceJobs.iter()].find(
        (j) => j.runId === runId && j.status === 'accepted',
      );
      if (job) {
        await conn.reducers.requestJobCancellation({ runId, jobId: job.id });
        cancelled = true;
        console.info(`Requested mid-task cancellation for job ${job.id}.`);
      }
    }
    peak = Math.max(
      peak,
      [...conn.db.uiWorkers.iter()].filter(
        (w) => w.runId === runId && w.enabled,
      ).length,
    );
    if (
      [...conn.db.uiRuns.iter()].find((r) => r.id === runId)?.status ===
      'completed'
    ) {
      console.info(
        `Completed run ${runId}; peak ${peak} enabled workers; ${[...service.db.serviceJobs.iter()].filter((j) => j.runId === runId && j.status === 'cancelled').length} acknowledged cancellations.`,
      );
      break;
    }
    if (child.exitCode !== null) throw new Error('Agent supervisor exited');
  }
  if (
    [...conn.db.uiRuns.iter()].find((r) => r.id === runId)?.status !==
    'completed'
  )
    throw new Error(
      'External demo stalled; inspect agent health and uncertain jobs.',
    );
} finally {
  if (child && child.exitCode === null) {
    const exiting = child;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        exiting.kill();
        resolve();
      }, 5000);
      exiting.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      if (exiting.connected) exiting.send({ type: 'shutdown' });
      else exiting.kill();
    });
  }
  conn.disconnect();
  service.disconnect();
}
