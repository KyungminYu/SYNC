/** Requires the real SpacetimeDB SDK test harness; not a substitute for subscriptions. */
import { expect, it } from 'vitest';
import { ConnectionId, ScheduleAt } from 'spacetimedb';
import {
  createModuleTestHarness,
  TestAuth,
} from 'spacetimedb/server/test-utils';
import schema, * as api from '../src/index.ts';

const principal = (sub: string, n: bigint) =>
  TestAuth.fromJwtPayload(
    JSON.stringify({ iss: 'sync-test', sub }),
    new ConnectionId(n),
  );
it('arms clocks only for running runs, ignores old deliveries, and retires legacy paused clocks', () => {
  const test = createModuleTestHarness(schema, api);
  const owner = principal('clock-owner', 50n);
  test.withReducerTx(owner, (ctx) =>
    api.create_run(ctx, {
      name: 'Clock lifecycle',
      seed: 1,
      trayCount: 1,
      mode: 'deterministic',
      budgetMicrousd: undefined,
    }),
  );
  const runId = api.ui_runs(test.viewContext(owner))[0]!.id;
  test.withReducerTx(owner, (ctx) => {
    expect(ctx.db.clock.runId.find(runId)).toBeFalsy();
    api.set_run_status(ctx, { runId, running: true });
    const first = ctx.db.clock.runId.find(runId)!;
    expect(first).toBeDefined();
    api.set_run_status(ctx, { runId, running: true });
    expect(ctx.db.clock.runId.find(runId)?.scheduledId).toBe(first.scheduledId);
    api.set_run_status(ctx, { runId, running: false });
    expect(ctx.db.clock.runId.find(runId)).toBeFalsy();
    api.set_run_status(ctx, { runId, running: true });
    const resumed = ctx.db.clock.runId.find(runId)!;
    expect(resumed.scheduledId).not.toBe(first.scheduledId);
    const tick = ctx.db.run.id.find(runId)!.tick;
    api.tick_run(ctx, { arg: first });
    expect(ctx.db.run.id.find(runId)!.tick).toBe(tick);
    api.tick_run(ctx, { arg: resumed });
    expect(ctx.db.run.id.find(runId)!.tick).toBe(tick + 1);
    api.set_run_status(ctx, { runId, running: false });
    const legacy = ctx.db.clock.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.interval(200000n),
      runId,
    });
    api.tick_run(ctx, { arg: legacy });
    expect(ctx.db.clock.runId.find(runId)).toBeFalsy();
    expect(ctx.db.run.id.find(runId)!.tick).toBe(tick + 1);
  });
});
it('keeps UI views empty for another identity and exposes a complete DAG to the owner', () => {
  const test = createModuleTestHarness(schema, api);
  const alice = principal('alice', 1n);
  const bob = principal('bob', 2n);
  test.withReducerTx(alice, (ctx) =>
    api.create_run(ctx, {
      name: 'Private cafe',
      seed: 42,
      trayCount: 2,
      mode: 'deterministic',
      budgetMicrousd: undefined,
    }),
  );
  const owned = api.ui_runs(test.viewContext(alice));
  expect(owned).toHaveLength(1);
  const runId = owned[0]!.id;
  test.withReducerTx(alice, (ctx) =>
    api.enqueue_order(ctx, {
      runId,
      externalKey: 'o1',
      recipe: 'latte',
      deadlineInTicks: 60,
      value: 10,
      priority: 1,
      customerUseTicks: 3,
    }),
  );
  expect(api.ui_tasks(test.viewContext(alice))).toHaveLength(10);
  expect(api.ui_runs(test.viewContext(bob))).toEqual([]);
  expect(api.ui_tasks(test.viewContext(bob))).toEqual([]);
  expect(api.ui_metrics(test.viewContext(bob))).toEqual([]);
  expect(() =>
    test.withReducerTx(bob, (ctx) =>
      api.set_run_status(ctx, { runId, running: true }),
    ),
  ).toThrow();
  expect(api.ui_runs(test.viewContext(alice))[0]!.status).toBe('paused');
});
it('executes a complete reducer lifecycle and releases reservations', () => {
  const test = createModuleTestHarness(schema, api);
  const alice = principal('alice', 1n);
  test.withReducerTx(alice, (ctx) =>
    api.create_run(ctx, {
      name: 'Cafe',
      seed: 1,
      trayCount: 1,
      mode: 'deterministic',
      budgetMicrousd: undefined,
    }),
  );
  const runId = api.ui_runs(test.viewContext(alice))[0]!.id;
  test.withReducerTx(alice, (ctx) =>
    api.enqueue_order(ctx, {
      runId,
      externalKey: 'o1',
      recipe: 'black_coffee',
      deadlineInTicks: 60,
      value: 10,
      priority: 1,
      customerUseTicks: 2,
    }),
  );
  test.withReducerTx(alice, (ctx) =>
    api.set_policy(ctx, {
      runId,
      configJson: JSON.stringify({ policy: 'primal_dual' }),
    }),
  );
  test.withReducerTx(alice, (ctx) => api.close_arrivals(ctx, { runId }));
  for (
    let i = 0;
    i < 100 && api.ui_runs(test.viewContext(alice))[0]!.status !== 'completed';
    i++
  )
    test.withReducerTx(alice, (ctx) => api.step_run(ctx, { runId }));
  expect(
    api.ui_orders(test.viewContext(alice))[0]!.status,
    JSON.stringify(api.ui_tasks(test.viewContext(alice)), (_k, v) =>
      typeof v === 'bigint' ? String(v) : v,
    ),
  ).toBe('cleaned');
  expect(
    api
      .ui_resources(test.viewContext(alice))
      .every((r) => r.reserved_units === 0),
  ).toBe(true);
  expect(api.ui_metrics(test.viewContext(alice))[0]!.delivered_orders).toBe(1);
  expect(
    api.ui_planner(test.viewContext(alice))[0]!.replan_count,
  ).toBeGreaterThan(0n);
  expect(api.ui_planner(test.viewContext(principal('outsider', 3n)))).toEqual(
    [],
  );
});
it('rolls back previously successful writes in a failed transaction', () => {
  const test = createModuleTestHarness(schema, api);
  const alice = principal('alice', 1n);
  expect(() =>
    test.withReducerTx(alice, (ctx) => {
      api.create_run(ctx, {
        name: 'Cafe',
        seed: 1,
        trayCount: 1,
        mode: 'deterministic',
        budgetMicrousd: undefined,
      });
      throw new Error('rollback');
    }),
  ).toThrow('rollback');
  expect(api.ui_runs(test.viewContext(alice))).toEqual([]);
});

it('persists duplicate-cart membership, recipes and joined delivery through real reducers', () => {
  const test = createModuleTestHarness(schema, api);
  const alice = principal('cart-owner', 9n);
  test.withReducerTx(alice, (ctx) =>
    api.create_run(ctx, {
      name: 'Cart',
      seed: 5,
      trayCount: 1,
      mode: 'deterministic',
      budgetMicrousd: undefined,
    }),
  );
  const runId = api.ui_runs(test.viewContext(alice))[0]!.id;
  test.withReducerTx(alice, (ctx) =>
    api.enqueue_cart(ctx, {
      runId,
      cartKey: 'five',
      items: [{ recipe: 'latte', quantity: 5 }],
      deadlineInTicks: 100,
      value: 1,
      priority: 1,
      customerUseTicks: 1,
    }),
  );
  test.withReducerTx(alice, (ctx) =>
    api.set_policy(ctx, {
      runId,
      configJson: JSON.stringify({ policy: 'primal_dual' }),
    }),
  );
  test.withReducerTx(alice, (ctx) => api.close_arrivals(ctx, { runId }));
  for (
    let i = 0;
    i < 250 && api.ui_runs(test.viewContext(alice))[0]!.status !== 'completed';
    i++
  )
    test.withReducerTx(alice, (ctx) => api.step_run(ctx, { runId }));
  const orders = api.ui_orders(test.viewContext(alice));
  expect(orders).toHaveLength(5);
  expect(
    orders.every((o) => o.recipe_key === 'latte' && o.status === 'cleaned'),
  ).toBe(true);
  expect(new Set(orders.map((o) => o.delivered_tick)).size).toBe(1);
  expect(
    api
      .ui_tasks(test.viewContext(alice))
      .some((t) => t.order_ids.length === 5 && t.kind === 'deliver_order'),
  ).toBe(true);
  expect(
    api.service_workers(test.viewContext(principal('outsider', 10n))),
  ).toEqual([]);
});
