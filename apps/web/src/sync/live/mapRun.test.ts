import { describe, expect, it } from 'vitest';
import { buildLanes } from '../../dashboard/model/lanes';
import { peakWaiting, sceneAt } from '../../dashboard/model/scene';
import { checkRun, normalizeRun } from '../../dashboard/model/normalize';
import { cartKeyFor, parseCartKey } from '../menu';
import { mapRun, type RunRows, type TaskRow } from './mapRun';

/**
 * Engine rows → contract. One customer, c1, orders a latte and a black coffee
 * (two engine orders in one cart); the engine's 7 default workers.
 */
const workers = [
  ['cashier', 2],
  ['barista', 2],
  ['server', 2],
  ['cleaner', 1],
].flatMap(([role, n], r) =>
  Array.from({ length: n as number }, (_, i) => ({
    id: BigInt(r * 10 + i + 1),
    runId: 1n,
    label: `${role} ${i + 1}`,
    role: role as string,
  })),
);
const cartKey = cartKeyFor('c1', [
  { name: 'Latte', complexity: 'medium' },
  { name: 'Black coffee', complexity: 'simple' },
]);
let nextTask = 100n;
/** A finished task of `order` worked by worker `w` from `s` to `f`. */
const task = (
  order: bigint,
  kind: string,
  role: string,
  w: bigint,
  s: number,
  f?: number,
): TaskRow => ({
  id: nextTask++,
  runId: 1n,
  orderId: order,
  kind,
  role,
  workerId: w,
  startedTick: s,
  finishedTick: f,
  finishAtTick: f ?? s + 2,
  durationTicks: 2,
});
const rows: RunRows = {
  run: {
    id: 1n,
    name: 'SYNC sync_greedy · seed 5',
    seed: 5,
    tick: 40,
    status: 'running',
  },
  orders: [
    {
      id: 11n,
      runId: 1n,
      cartKey,
      recipe: 'latte',
      arrivalTick: 10,
      deadlineTick: 98,
      deliveredTick: 30,
    },
    {
      id: 12n,
      runId: 1n,
      cartKey,
      recipe: 'black_coffee',
      arrivalTick: 10,
      deadlineTick: 98,
      deliveredTick: 33,
    },
  ],
  tasks: [
    task(11n, 'capture_order', 'cashier', 1n, 11, 13),
    task(12n, 'capture_order', 'cashier', 2n, 11, 13),
    task(11n, 'take_payment', 'cashier', 1n, 13, 15),
    task(12n, 'take_payment', 'cashier', 2n, 13, 16),
    task(11n, 'assemble_drink', 'barista', 11n, 20, 22),
    task(11n, 'pick_up_drink', 'server', 21n, 27, 28),
    task(11n, 'deliver_order', 'server', 21n, 28, 30),
    task(12n, 'deliver_order', 'server', 22n, 31, 33),
  ],
  workers,
  decisions: [
    {
      runId: 1n,
      sequence: 7n,
      tick: 11,
      taskId: 100n,
      workerId: 1n,
      score: 0.82,
      reasonCodes: ['sync_greedy', 'compatible_worker'],
      snapshotVersion: 12n,
    },
  ],
};

describe('menu cart keys', () => {
  it('round-trips the customer and drinks', () => {
    expect(cartKey).toBe('c1:latte+black_coffee');
    expect(parseCartKey(cartKey).items.map((i) => i.name)).toEqual([
      'Latte',
      'Black coffee',
    ]);
  });
});

describe('mapRun', () => {
  const data = normalizeRun(mapRun(rows, 'sync'));

  it('produces contract-valid rows', () => {
    expect(checkRun(data)).toEqual([]);
    expect(data.layout.agents.map((a) => a.id)).toEqual([
      'cashier1',
      'cashier2',
      'barista1',
      'barista2',
      'server1',
      'server2',
      'cleaner1',
    ]);
  });

  it('groups a cart into one customer with its drinks', () => {
    expect(data.jobs).toHaveLength(1);
    const job = data.jobs[0];
    expect(job).toMatchObject({
      id: 'c1',
      label: 'Latte + Black coffee',
      arrival: 10,
      deadline: 98,
    });
  });

  it('completes the customer when the last drink is delivered', () => {
    const done = data.events.filter((e) => e.type === 'job.completed');
    expect(done).toEqual([
      expect.objectContaining({ t: 33, jobId: 'c1', data: { onTime: true } }),
    ]);
  });

  it('maps decisions to assign rows with score and reasons', () => {
    expect(data.decisions[0]).toMatchObject({
      kind: 'assign',
      agentId: 'cashier1',
      resourceId: 'reg1',
      candidates: [],
      detail: 'score 0.82 · reasons: sync_greedy, compatible_worker',
    });
  });

  it('marks planning time as not measured without coordinator samples', () => {
    expect(data.score?.planningMs).toBeNull();
    expect(data.score).toMatchObject({
      completedInT: 1,
      lateCount: 0,
      totalJobs: 1,
    });
  });

  it('moves the customer to waiting only after the last register task', () => {
    const lanes = buildLanes(data.layout, Math.max(10, peakWaiting(data)));
    expect(sceneAt(data, 14, lanes).customers[0].stage).toBe('ordering');
    expect(sceneAt(data, 16, lanes).customers[0].stage).toBe('waiting');
    expect(sceneAt(data, 27, lanes).customers[0].stage).toBe('ready');
    expect(peakWaiting(data)).toBe(1);
  });
});

describe('mapRun with one engine order holding several drinks', () => {
  // c1: one order (id 21) for a latte and a black coffee.
  const key = cartKeyFor('c1', [
    { name: 'Latte', complexity: 'medium' },
    { name: 'Black coffee', complexity: 'simple' },
  ]);
  let id = 500n;
  const t = (
    kind: string,
    role: string,
    w: bigint,
    s: number,
    f: number,
  ): TaskRow => ({
    id: id++,
    runId: 1n,
    orderId: 21n,
    kind,
    role,
    workerId: w,
    startedTick: s,
    finishedTick: f,
    finishAtTick: f,
    durationTicks: f - s,
  });
  const rows2: RunRows = {
    run: { id: 1n, name: 'Low-2 · SYNC', seed: 5, tick: 40, status: 'running' },
    orders: [
      {
        id: 21n,
        runId: 1n,
        cartKey: key,
        recipe: 'latte',
        arrivalTick: 10,
        deadlineTick: 98,
        deliveredTick: 34,
      },
    ],
    // Creation order: order tasks, then per drink coffee (+ milk) and assembly.
    tasks: [
      t('capture_order', 'cashier', 1n, 11, 14),
      t('take_payment', 'cashier', 1n, 14, 16),
      t('prepare_coffee', 'barista', 11n, 16, 21),
      t('prepare_milk', 'barista', 12n, 16, 20),
      t('assemble_drink', 'barista', 11n, 21, 23),
      t('prepare_coffee', 'barista', 12n, 20, 25),
      t('assemble_drink', 'barista', 12n, 25, 27),
      t('pick_up_drink', 'server', 21n, 28, 29),
      t('deliver_order', 'server', 21n, 29, 34),
    ],
    workers,
    decisions: [],
  };
  const data = normalizeRun(mapRun(rows2, 'sync'));

  it('gives every task its own id and numbers the drinks', () => {
    const ids = data.tasks.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('c1.prepare_coffee.1');
    expect(ids).toContain('c1.prepare_coffee.2');
    expect(data.tasks.find((x) => x.id === 'c1.assemble_drink.2')?.label).toBe(
      'Make drink (2/2)',
    );
    // One order task and one payment for the customer.
    expect(data.tasks.filter((x) => x.type === 'register')).toHaveLength(2);
    expect(data.tasks.find((x) => x.id === 'c1.capture_order.1')?.label).toBe(
      'Take order',
    );
    expect(checkRun(data)).toEqual([]);
  });

  it('moves to waiting after paying and completes on delivery', () => {
    const lanes = buildLanes(data.layout, 10);
    expect(sceneAt(data, 15, lanes).customers[0].stage).toBe('ordering');
    expect(sceneAt(data, 17, lanes).customers[0].stage).toBe('waiting');
    expect(data.events.find((e) => e.type === 'job.completed')?.t).toBe(34);
    expect(data.jobs[0].label).toBe('Latte + Black coffee');
  });
});

it('cup preparation does not call a customer to pickup, and retries use authoritative current cost', () => {
  const prep = task(11n, 'prepare_cups', 'server', 21n, 17, 20);
  const data = mapRun(
    {
      ...rows,
      tasks: [...rows.tasks, prep],
      metrics: {
        runId: 1n,
        reportedCoordinatorMs: 0,
        coordinatorSampleCount: 0,
        modeledSpentMicrousd: 166000n,
      },
    },
    'sync',
  );
  expect(sceneAt(data, 18).customers[0].stage).toBe('waiting');
  expect(
    data.tasks.find((t) => t.id.includes('prepare_cups'))?.customerHandoff,
  ).toBe(false);
  expect(data.scoreTimeline?.at(-1)?.execCost).toBe(0.166);
});
it('shared task membership and dependency edges survive mapping without duplicating execution', () => {
  const shared = { ...rows.tasks[4], orderIds: [11n, 12n] };
  const data = mapRun(
    {
      ...rows,
      tasks: [...rows.tasks.filter((t) => t.id !== shared.id), shared],
      edges: [{ fromTaskId: rows.tasks[2].id, toTaskId: shared.id }],
    },
    'sync',
  );
  const mapped = data.tasks.find((t) => t.label.includes('[2 drinks]'))!;
  expect(mapped.jobIds).toEqual(['c1']);
  expect(mapped.deps).toHaveLength(1);
  expect(
    data.events.filter(
      (e) => e.taskId === mapped.id && e.type === 'task.started',
    ),
  ).toHaveLength(1);
  expect(checkRun(data)).toEqual([]);
});
