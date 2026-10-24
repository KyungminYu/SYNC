/** Explicit opt-in verification against a real local host. Never run by dev/build. */
import assert from 'node:assert/strict';
import { DbConnection } from '../packages/bindings/src';
const clients: DbConnection[] = [];
async function connect(queries: string[]) {
  return new Promise<DbConnection>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Database connection timed out')),
      10000,
    );
    const client = DbConnection.builder()
      .withUri('http://127.0.0.1:3000')
      .withDatabaseName('sync-coffee-dev')
      .onConnect((conn) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timer);
            resolve(conn);
          })
          .onError((ctx) => {
            clearTimeout(timer);
            reject(ctx.event);
          })
          .subscribe(queries);
      })
      .onConnectError((_ctx, error) => {
        clearTimeout(timer);
        reject(error);
      })
      .build();
    clients.push(client);
  });
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 45000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Subscription/lifecycle timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const queries = [
  'SELECT * FROM ui_runs',
  'SELECT * FROM ui_orders',
  'SELECT * FROM ui_resources',
  'SELECT * FROM ui_trays',
  'SELECT * FROM ui_metrics',
  'SELECT * FROM ui_policy_catalog',
];
try {
  const owner = await connect(queries),
    stranger = await connect(queries);
  assert.equal([...owner.db.uiPolicyCatalog.iter()].length, 6);
  await owner.reducers.createRun({
    name: 'Integration verification',
    seed: 42,
    trayCount: 2,
    mode: 'deterministic',
    budgetMicrousd: undefined,
  });
  await until(() => [...owner.db.uiRuns.iter()].length === 1);
  const runId = [...owner.db.uiRuns.iter()][0].id;
  assert.equal([...stranger.db.uiRuns.iter()].length, 0);
  await assert.rejects(
    stranger.reducers.setRunStatus({ runId, running: true }),
  );
  await owner.reducers.grantMember({
    runId,
    identity: stranger.identity!,
    permission: 'viewer',
    enabled: true,
  });
  await until(() => [...stranger.db.uiRuns.iter()].length === 1);
  await assert.rejects(
    stranger.reducers.setRunStatus({ runId, running: true }),
  );
  for (const recipe of ['black_coffee', 'latte'])
    await owner.reducers.enqueueOrder({
      runId,
      externalKey: recipe,
      recipe,
      deadlineInTicks: 120,
      value: 10,
      priority: 1,
      customerUseTicks: 2,
    });
  await owner.reducers.closeArrivals({ runId });
  await owner.reducers.setRunStatus({ runId, running: true });
  await until(() =>
    [...owner.db.uiRuns.iter()].some(
      (r) => r.id === runId && r.status === 'completed',
    ),
  );
  assert.equal(
    [...owner.db.uiOrders.iter()].filter(
      (o) => o.runId === runId && o.status === 'cleaned',
    ).length,
    2,
  );
  assert([...owner.db.uiResources.iter()].every((r) => r.reservedUnits === 0));
  assert.equal([...owner.db.uiMetrics.iter()][0].deliveredOrders, 2);
  await owner.reducers.grantMember({
    runId,
    identity: stranger.identity!,
    permission: 'viewer',
    enabled: false,
  });
  await until(
    () =>
      [...stranger.db.uiRuns.iter()].length === 0 &&
      [...stranger.db.uiOrders.iter()].length === 0,
  );
  console.log(
    JSON.stringify({
      integration: 'passed',
      runId: runId.toString(),
      cleanedOrders: 2,
      policies: 6,
      identityIsolation: true,
      revocation: true,
    }),
  );
} finally {
  for (const client of clients) client.disconnect();
}
