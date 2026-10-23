import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { DbConnection } from '../packages/bindings/src';
import { Identity } from 'spacetimedb';
const connections: DbConnection[] = [];
async function connect(token?: string) {
  return new Promise<DbConnection>((resolve, reject) => {
    const connection = DbConnection.builder()
      .withUri('http://127.0.0.1:3000')
      .withDatabaseName('sync-local')
      .withToken(token)
      .onConnect((conn, _identity, authToken) => {
        if (!token) {
          mkdirSync('.local', { recursive: true });
          writeFileSync('.local/integration-controller-token', authToken, {
            mode: 0o600,
          });
        }
        conn
          .subscriptionBuilder()
          .onApplied(() => resolve(conn))
          .onError((ctx) => reject(ctx.event))
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, error) => reject(error))
      .build();
    connections.push(connection);
  });
}
async function until(predicate: () => boolean, timeout = 45000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end)
      throw new Error('Timed out waiting for deterministic lifecycle');
    await new Promise((r) => setTimeout(r, 100));
  }
}
try {
  const health = await fetch('http://127.0.0.1:3001/ready');
  assert.equal(health.status, 200, 'Start pnpm dev:agents first');
  const serviceIdentity = Identity.fromString(
    readFileSync('.local/agent-identity', 'utf8'),
  );
  const token = existsSync('.local/integration-controller-token')
    ? readFileSync('.local/integration-controller-token', 'utf8')
    : undefined;
  const controller = await connect(token);
  const previous = new Set([...controller.db.run.iter()].map((r) => r.id));
  await controller.reducers.createDemoRun({
    seed: 42,
    policy: 'resource-aware',
  });
  await until(() =>
    [...controller.db.run.iter()].some((r) => !previous.has(r.id)),
  );
  const run = [...controller.db.run.iter()].find((r) => !previous.has(r.id))!;
  await controller.reducers.registerService({
    runId: run.id,
    identity: serviceIdentity,
  });
  await controller.reducers.startRun({ runId: run.id });
  await until(() => controller.db.run.id.find(run.id)?.status === 'complete');
  const tasks = [...controller.db.task.iter()].filter(
      (t) => t.runId === run.id,
    ),
    events = [...controller.db.executionEvent.iter()].filter(
      (e) => e.runId === run.id,
    );
  assert.equal(tasks.length, 8);
  assert(tasks.every((t) => t.state === 'succeeded'));
  assert.equal(
    [...controller.db.reservation.iter()].filter((r) => r.runId === run.id)
      .length,
    0,
  );
  assert(
    [...controller.db.worker.iter()]
      .filter((w) => w.runId === run.id)
      .every((w) => w.taskId === undefined),
  );
  for (const task of tasks)
    assert.equal(
      events.filter((e) => e.taskId === task.id && e.kind === 'COMPLETED')
        .length,
      1,
    );
  assert(
    [...controller.db.agentJob.iter()]
      .filter((j) => j.runId === run.id)
      .every(
        (j) => j.state === 'accepted' && j.claimant?.isEqual(serviceIdentity),
      ),
  );
  console.log(
    JSON.stringify({
      integration: 'passed',
      runId: run.id.toString(),
      completed: tasks.length,
      tick: controller.db.run.id.find(run.id)!.tick,
      reservations: 0,
    }),
  );
} finally {
  for (const c of connections) c.disconnect();
}
