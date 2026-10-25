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
    // Seven engine workers, one person per role on the floor.
    expect(data.layout.agents.map((a) => a.id)).toEqual([
      'cashier',
      'barista',
      'server',
      'cleaner',
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
      agentId: 'cashier',
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

describe('one person per role and per slot', () => {
  const ids = (d: ReturnType<typeof normalizeRun>, t: number) =>
    sceneAt(d, t).agents.map((a) => a.id);

  it('draws one person per role even when two engine workers work at once', () => {
    // Cashier 1 and cashier 2 both take an order at tick 11.
    const data = normalizeRun(mapRun(rows, 'sync'));
    expect(ids(data, 12)).toEqual(['cashier', 'barista', 'server', 'cleaner']);
    const scene = sceneAt(data, 12);
    // No work without a person: both orders are taken at the cashier's register.
    expect(scene.slots.filter((s) => s.state === 'busy').map((s) => s.id)).toEqual(['reg1']);
    const cashier = scene.agents.find((a) => a.id === 'cashier')!;
    expect(cashier).toMatchObject({ state: 'working', x: 2.5, y: 3.5 });
  });

  it('keeps a person at their slot until every task they hold is done', () => {
    // Cashier 2's payment runs to tick 16, past cashier 1's (15): one person, one slot.
    const data = normalizeRun(mapRun(rows, 'sync'));
    for (const t of [13, 14, 15]) {
      const scene = sceneAt(data, t);
      expect(scene.agents.find((a) => a.id === 'cashier')).toMatchObject({ state: 'working', x: 2.5 });
      expect(scene.slots.find((s) => s.id === 'reg2')?.state).toBe('idle');
    }
    expect(sceneAt(data, 16.5).agents.find((a) => a.id === 'cashier')?.state).toBe('idle');
  });

  it('lets the engine\'s helper do the work at a free slot of its type (SYNC)', () => {
    // The engine's server 1 collects a tray while free: the Server walks to
    // the sink and works there (helping); the idle Cleaner makes room.
    const data = normalizeRun(
      mapRun(
        { ...rows, tasks: [...rows.tasks, task(11n, 'collect_tray', 'cleaner', 21n, 35, 37)] },
        'sync',
      ),
    );
    expect(checkRun(data)).toEqual([]);
    const sink = data.layout.resources.find((r) => r.type === 'clean')!;
    const at = sceneAt(data, 36).agents;
    expect(at.find((a) => a.id === 'server')).toMatchObject({
      state: 'working',
      helping: true,
      x: sink.standX ?? sink.x,
      y: sink.standY ?? sink.y,
    });
    expect(at.find((a) => a.id === 'cleaner')?.state).toBe('idle');
    // Done: the Server is back at Pickup 1.
    expect(sceneAt(data, 38).agents.find((a) => a.id === 'server')).toMatchObject({ x: 11.5, y: 3.5 });
  });

  it('hands drinks over at a pickup counter even when a Baseline cashier does it', () => {
    // The engine's cashier 1 delivers order 12: still at a pickup, never a register.
    const data = normalizeRun(
      mapRun(
        {
          ...rows,
          tasks: rows.tasks.map((t) =>
            t.kind === 'deliver_order' && t.orderId === 12n ? { ...t, workerId: 1n } : t,
          ),
        },
        'baseline',
      ),
    );
    const handoffs = data.events.filter((e) => {
      const k = data.tasks.find((x) => x.id === e.taskId);
      return e.type === 'task.started' && k?.type === 'pickup' && k.customerHandoff !== false;
    });
    expect(handoffs.length).toBeGreaterThan(0);
    for (const e of handoffs)
      expect(data.layout.resources.find((r) => r.id === e.resourceId)?.type).toBe('pickup');
    expect(checkRun(data)).toEqual([]);
  });

  it('never moves Baseline staff; cross-role work is done at their own slot', () => {
    const helped = normalizeRun(
      mapRun(
        { ...rows, tasks: [...rows.tasks, task(11n, 'collect_tray', 'cleaner', 21n, 35, 37)] },
        'baseline',
      ),
    );
    expect(checkRun(helped)).toEqual([]);
    const scene = sceneAt(helped, 36);
    const server = scene.agents.find((a) => a.id === 'server')!;
    expect(server).toMatchObject({ state: 'working', helping: true, x: 11.5, y: 3.5 });
    // The tray is collected at the server's own pickup, never at an empty sink.
    expect(scene.slots.find((s) => s.id === 'pick1')?.state).toBe('busy');
    expect(scene.slots.find((s) => s.id === 'clean1')?.state).toBe('idle');
    const cleaner = scene.agents.find((a) => a.id === 'cleaner')!;
    expect(cleaner).toMatchObject({ x: 14.5, y: 2.5 });
    // No staff position ever changes in Baseline.
    for (let t = 0; t <= 40; t++)
      for (const a of sceneAt(helped, t).agents) {
        const home = helped.layout.agents.find((h) => h.id === a.id)!;
        expect([a.x, a.y]).toEqual([home.startX, home.startY]);
      }
  });
});
