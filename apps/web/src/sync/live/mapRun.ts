import type {
  Agent,
  Decision,
  Job,
  Layout,
  Policy,
  ResourceType,
  Role,
  RunData,
  Score,
  SyncEvent,
  Task,
  TimedScore,
} from '../contract';
import { parseCartKey } from '../menu';
import { buildLayout, ROLE_NAME, ROLE_TYPE, SCENARIO_T } from '../shopLayout';

/**
 * Pure mapping from SpacetimeDB `ui_*` view rows to the dashboard contract
 * (LIVE_SPACETIMEDB_DESIGN.md §4). No connection here, so it is unit-tested
 * with plain objects; SpacetimeSyncSource feeds it the subscribed rows.
 *
 * Engine terms → contract terms:
 *   cart (cartKey "c7:latte+mocha") → Job (customer c7)
 *   order (one drink)              → Job.items entry
 *   task (capture_order, …)        → Task, type from the worker role
 *   workers of one role            → one Agent per role ("cashier"): the
 *   ("cashier 1", "cashier 2")       floor shows one person per role
 *   decision                       → Decision (assign; no candidates)
 * The engine has no move or lease rows, so no agent.move or lease events are
 * produced. One person per slot and per role (Figma "Staff rules v2"): a task
 * its person cannot be drawn at (already working elsewhere) shows on its slot
 * only. Baseline staff never leave their own slot.
 */

/** Subset of `ui_runs` the mapping reads. Field names match @sync/bindings. */
export interface RunRow {
  id: bigint;
  name: string;
  seed: number;
  tick: number;
  status: string;
  mode?: string;
}
export interface OrderRow {
  id: bigint;
  runId: bigint;
  cartKey: string;
  recipeKey?: string;
  recipe?: string;
  arrivalTick: number;
  deadlineTick: number;
  deliveredTick?: number;
}
export interface TaskRow {
  id: bigint;
  runId: bigint;
  orderId: bigint;
  orderIds?: bigint[];
  kind: string;
  role: string;
  workerId?: bigint;
  startedTick?: number;
  finishedTick?: number;
  finishAtTick?: number;
  durationTicks: number;
  attempt?: number;
  estimatedCostMicrousd?: bigint;
}
export interface WorkerRow {
  id: bigint;
  runId: bigint;
  label: string;
  role: string;
  enabled?: boolean;
}
export interface DecisionRow {
  runId: bigint;
  sequence: bigint;
  tick: number;
  taskId: bigint;
  workerId: bigint;
  score: number;
  reasonCodes: string[];
  snapshotVersion: bigint;
}
export interface MetricsRow {
  runId: bigint;
  reportedCoordinatorMs: number;
  coordinatorSampleCount: number;
  modeledSpentMicrousd?: bigint;
  netReward?: number;
}

/** Every row of one run. */
export interface RunRows {
  run: RunRow;
  orders: OrderRow[];
  tasks: TaskRow[];
  workers: WorkerRow[];
  decisions: DecisionRow[];
  metrics?: MetricsRow;
  edges?: { fromTaskId: bigint; toTaskId: bigint }[];
  /**
   * The engine's objective (net reward) seen at each tick so far. ui_metrics
   * only holds the current value, so the source remembers earlier ones.
   */
  objectiveByTick?: Map<number, number>;
}

/** Horizon T of objective (20) in ticks (1 tick = 1 scenario second). */
export const LIVE_T = SCENARIO_T;

/** Engine task kinds → short labels shown in decision rows and details. */
const TASK_LABEL: Record<string, string> = {
  capture_order: 'Take order',
  take_payment: 'Payment',
  prepare_coffee: 'Brew coffee',
  prepare_milk: 'Steam milk',
  assemble_drink: 'Make drink',
  pick_up_drink: 'Pick up',
  deliver_order: 'Hand to customer',
  collect_tray: 'Collect tray',
  clean_tray: 'Clean tray',
  return_tray: 'Return tray',
  prepare_cups: 'Prepare cups',
  wash_pitcher: 'Wash pitcher',
};

const isRole = (r: string): r is Role => r in ROLE_TYPE;

/** Engine tasks made once per drink; the others are once per order. */
const DRINK_TASKS = new Set([
  'prepare_coffee',
  'prepare_milk',
  'assemble_drink',
]);

/** "Latte ×2 + Black coffee" from the drink names. */
function orderLabel(names: string[]) {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(' + ');
}

/**
 * Staff from `ui_workers`: every worker of a role ("cashier 1", "cashier 2")
 * is the same person on the floor, agent "cashier", whose home is the role's
 * first slot. The engine's extra workers (switched on and off with the load)
 * never add a second person. `slotOf` keeps each worker's own slot, which
 * is still preferred for its tasks. Baseline staff are fixed to their home.
 */
function liveLayout(workers: WorkerRow[], fixed: boolean) {
  const base = buildLayout();
  const slotOf = new Map<string, { agentId: string; resourceId: string }>();
  const agents: Agent[] = [];
  for (const w of [...workers].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const role = w.role;
    if (!isRole(role)) continue;
    const index = Number(w.label.match(/(\d+)\s*$/)?.[1] ?? 1) - 1;
    const slots = base.resources.filter((r) => r.type === ROLE_TYPE[role]);
    const slot = slots[Math.min(index, slots.length - 1)];
    if (!agents.some((a) => a.id === role)) {
      const home = slots[0];
      agents.push({
        id: role,
        name: ROLE_NAME[role],
        role,
        primaryTypes: [ROLE_TYPE[role]],
        startX: home.standX ?? home.x,
        startY: home.standY ?? home.y,
        ...(fixed ? { fixed: true } : {}),
      });
    }
    slotOf.set(String(w.id), { agentId: role, resourceId: slot.id });
  }
  // Same order as the shop layout (cashier, barista, server, cleaner).
  const order = base.agents.map((a) => a.role);
  agents.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  const layout: Layout = { ...base, agents };
  return { layout, slotOf };
}

/** Objective (20) terms at time t, per customer (all drinks received = done). */
function scoreAt(
  data: Pick<RunData, 'jobs' | 'events' | 'run'>,
  t: number,
  planningMs: number | null,
): Score {
  const T = data.run.objective.T;
  const done = new Map<string, number>();
  for (const e of data.events)
    if (e.type === 'job.completed' && e.t <= t) done.set(e.jobId!, e.t);
  let completedInT = 0,
    lateCount = 0;
  for (const job of data.jobs) {
    if (job.arrival > t) continue;
    const f = done.get(job.id);
    if (f !== undefined && f <= T) completedInT += job.value;
    // Late: served after the deadline, or still waiting with it already past.
    if (
      (f !== undefined && f > job.deadline) ||
      (f === undefined && job.deadline < Math.min(t, T))
    )
      lateCount++;
  }
  return {
    runId: data.run.runId,
    T,
    completedInT,
    totalJobs: data.jobs.filter((j) => j.arrival <= t).length,
    lateCount,
    planningMs,
    execCost: null,
  };
}

/** Builds the contract view of one engine run. */
export function mapRun(
  rows: RunRows,
  policy: Policy,
  T = LIVE_T,
  /** Scenario id shown as the run's scenario, e.g. "Mid-2". */
  scenario = 'Live run',
): RunData {
  const { layout, slotOf } = liveLayout(rows.workers, policy === 'baseline');
  const agentName = new Map(layout.agents.map((a) => [a.id, a.name]));

  // Customers: orders grouped by cart, drinks in enqueue (id) order.
  const carts = new Map<string, OrderRow[]>();
  for (const o of [...rows.orders].sort((a, b) => (a.id < b.id ? -1 : 1)))
    carts.set(o.cartKey, [...(carts.get(o.cartKey) ?? []), o]);
  const jobs: Job[] = [];
  /** order id → [customer id, drink index, drink count]. */
  const orderInfo = new Map<string, [string, number, number]>();
  for (const [key, orders] of carts) {
    const parsed = parseCartKey(key);
    const customerId =
      [...carts.keys()].filter(
        (k) => parseCartKey(k).customerId === parsed.customerId,
      ).length > 1
        ? key
        : parsed.customerId;
    const items = parsed.items;
    orders.forEach((o, k) =>
      orderInfo.set(String(o.id), [customerId, k, orders.length]),
    );
    // The customer walks in from the door when their orders first exist in
    // the database. (Dating the arrival earlier would make a live customer
    // show up already in line, the walk-in having happened before the rows.)
    const arrival = Math.min(...orders.map((o) => o.arrivalTick));
    jobs.push({
      id: customerId,
      // Drinks come from the cart key (any number per engine order); without
      // one, fall back to one recipe per order.
      label: orderLabel(
        items.length >= orders.length
          ? items.map((i) => i.name)
          : orders.map((o) => o.recipeKey ?? o.recipe ?? 'Unknown'),
      ),
      arrival,
      deadline: Math.min(...orders.map((o) => o.deadlineTick)),
      value: 1,
      items:
        items.length >= orders.length
          ? items
          : orders.map((o) => ({
              name: o.recipeKey ?? o.recipe ?? 'Unknown',
              complexity: 'medium',
            })),
      serviceTaskId: '',
      taskIds: [],
    });
  }
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  // Tasks: ids "c7.capture_order.2" keep the customer first (scene reads it).
  // An engine order holds one drink (older runs) or several: drink tasks
  // (coffee, milk, assembly) are numbered by drink within the customer, the
  // rest by order, so ids never collide in either shape.
  const tasks: Task[] = [];
  const taskId = new Map<string, string>();
  const taskRows = [...rows.tasks].sort((a, b) => (a.id < b.id ? -1 : 1));
  /** Drinks per engine order = its coffee tasks (one per drink). */
  const drinksOf = new Map<string, number>();
  for (const r of taskRows)
    if (r.kind === 'prepare_coffee')
      drinksOf.set(
        String(r.orderId),
        (drinksOf.get(String(r.orderId)) ?? 0) + 1,
      );
  /** Drinks in the customer's earlier orders, and drinks per customer. */
  const drinksBefore = new Map<string, number>();
  const drinksTotal = new Map<string, number>();
  for (const [, orders] of carts)
    for (const o of orders) {
      const customerId = orderInfo.get(String(o.id))![0];
      const sofar = drinksTotal.get(customerId) ?? 0;
      drinksBefore.set(String(o.id), sofar);
      drinksTotal.set(
        customerId,
        sofar + Math.max(1, drinksOf.get(String(o.id)) ?? 1),
      );
    }
  /** Current drink while walking an order's tasks in creation order. */
  const drinkAt = new Map<string, number>();
  for (const r of taskRows) {
    const info = orderInfo.get(String(r.orderId));
    if (!info || !isRole(r.role)) continue;
    const [customerId, k, count] = info;
    const key = String(r.orderId);
    if (r.kind === 'prepare_coffee')
      drinkAt.set(key, (drinkAt.get(key) ?? -1) + 1);
    const perDrink = DRINK_TASKS.has(r.kind);
    const drink =
      (drinksBefore.get(key) ?? 0) + Math.max(0, drinkAt.get(key) ?? 0);
    const total = drinksTotal.get(customerId) ?? count;
    const single = (drinksOf.get(key) ?? 1) <= 1;
    const id = perDrink
      ? `${customerId}.${r.kind}.${drink + 1}`
      : `${customerId}.${r.kind}.${k + 1}`;
    // Drink tasks name their drink; order tasks only when the order is one drink.
    const n = perDrink
      ? drink
      : single
        ? (drinksBefore.get(key) ?? 0)
        : undefined;
    const label =
      (TASK_LABEL[r.kind] ?? r.kind) +
      (n !== undefined && total > 1 ? ` (${n + 1}/${total})` : '');
    tasks.push({
      id,
      jobId: customerId,
      jobIds: [
        ...new Set(
          (r.orderIds ?? [r.orderId])
            .map((id) => orderInfo.get(String(id))?.[0])
            .filter((id): id is string => !!id),
        ),
      ],
      label:
        label +
        ((r.orderIds?.length ?? 0) > 1
          ? ` [${r.orderIds!.length} drinks]`
          : ''),
      type: ROLE_TYPE[r.role],
      customerHandoff: r.kind !== 'prepare_cups',
      deps: [],
      ...(n === undefined ? {} : { itemIndex: n }),
    });
    taskId.set(String(r.id), id);
    const job = jobById.get(customerId)!;
    job.taskIds.push(id);
    for (const memberId of r.orderIds ?? []) {
      const customer = orderInfo.get(String(memberId))?.[0];
      const member = customer ? jobById.get(customer) : undefined;
      if (member && !member.taskIds.includes(id)) member.taskIds.push(id);
    }
    if (r.kind === 'deliver_order') job.serviceTaskId = id;
  }

  for (const edge of rows.edges ?? []) {
    const successor = tasks.find(
      (t) => t.id === taskId.get(String(edge.toTaskId)),
    );
    const predecessor = taskId.get(String(edge.fromTaskId));
    if (successor && predecessor && !successor.deps.includes(predecessor))
      successor.deps.push(predecessor);
  }
  /**
   * Where each task is shown and who works it (Figma "Staff rules v4"):
   * one person per role, no work at a slot with nobody at it, and nobody
   * leaves mid-task. `onFloor` is false only when no person can be drawn
   * doing the task (then it shows on its slot alone).
   */
  const taskPlaces = new Map<
    string,
    { agentId: string; resourceId: string; onFloor: boolean }
  >();
  const busyUntil = new Map<string, number>();
  /** When each person is free again (after every task they hold). */
  const agentFreeAt = new Map<string, number>();
  /** The slot each person is working at while busy. */
  const agentAt = new Map<string, string>();
  const fixed = new Set(layout.agents.filter((a) => a.fixed).map((a) => a.id));
  const typeOf = new Map(layout.resources.map((r) => [r.id, r.type]));
  /** The person whose own role works this slot type ("pickup" → server). */
  const ownerOf = (type: ResourceType) =>
    layout.agents.find((a) => a.primaryTypes.includes(type))?.id;
  /** A person's own slot: where they start. */
  const homeOf = (id: string) => {
    const a = layout.agents.find((x) => x.id === id)!;
    return layout.resources.find(
      (r) => (r.standX ?? r.x) === a.startX && (r.standY ?? r.y) === a.startY,
    )?.id;
  };
  for (const task of [...taskRows].sort(
    (a, b) => (a.startedTick ?? Infinity) - (b.startedTick ?? Infinity),
  )) {
    const home =
      task.workerId === undefined
        ? undefined
        : slotOf.get(String(task.workerId));
    if (!home || task.startedTick === undefined || !isRole(task.role)) continue;
    const s = task.startedTick;
    const end = task.finishedTick ?? Infinity;
    const type = ROLE_TYPE[task.role];
    const choices = layout.resources.filter((r) => r.type === type);
    const isFree = (id: string) => (agentFreeAt.get(id) ?? 0) <= s;
    const freeSlot = (prefer?: string) =>
      choices.find((r) => r.id === prefer && (busyUntil.get(r.id) ?? 0) <= s) ??
      choices.find((r) => (busyUntil.get(r.id) ?? 0) <= s);
    /**
     * The free slot of this type a person works at: their own slot when it
     * is of this type (the cashier stays at Register 1, whichever engine
     * cashier the task names), else the free one nearest their own slot, so
     * nobody is sent to a far slot while a customer waits there.
     */
    const slotFor = (id: string) => {
      const own = homeOf(id);
      const at = layout.resources.find((r) => r.id === own);
      const free = choices.filter((r) => (busyUntil.get(r.id) ?? 0) <= s);
      return (
        free.find((r) => r.id === own) ??
        free.sort(
          (a, b) => Math.abs(a.x - (at?.x ?? 0)) - Math.abs(b.x - (at?.x ?? 0)),
        )[0]
      )?.id;
    };
    let who = home.agentId;
    let station: string | undefined;
    if (fixed.has(who)) {
      // Baseline: everything is done at the person's own slot (no walking).
      station = isFree(who) ? homeOf(who) : agentAt.get(who);
    } else {
      // Keep your post (Figma "Staff rules v5"): the slot type's own person
      // takes it at their own slot, or — when busy — at the slot they are
      // already working (always that type, since they never leave it). So
      // nobody walks over to help and no slot runs while someone walks.
      const owner = ownerOf(type) ?? who;
      who = owner;
      station = isFree(owner)
        ? slotFor(owner)
        : typeOf.get(agentAt.get(owner) ?? '') === type
          ? agentAt.get(owner)
          : undefined;
    }
    let onFloor = station !== undefined;
    if (!station) {
      // Nobody can be drawn on it: show it on a slot of its type alone.
      station = freeSlot(home.resourceId)?.id ?? choices[0]?.id;
      onFloor = false;
    }
    if (!station) continue;
    if (onFloor) {
      if (isFree(who)) agentAt.set(who, station);
      agentFreeAt.set(who, Math.max(agentFreeAt.get(who) ?? 0, end));
    }
    taskPlaces.set(String(task.id), { agentId: who, resourceId: station, onFloor });
    busyUntil.set(station, Math.max(busyUntil.get(station) ?? 0, end));
  }

  // Events from task timestamps. Same-tick order: arrivals, finishes and
  // completions before new work starts, so a slot freed at t can be reused at t.
  const PRIORITY: Record<SyncEvent['type'], number> = {
    'job.arrived': 0,
    'task.finished': 1,
    'lease.released': 1,
    'job.completed': 2,
    'task.assigned': 3,
    'lease.claimed': 3,
    'agent.move': 3,
    'agent.wait': 3,
    'task.started': 4,
  };
  const raw: Omit<SyncEvent, 'seq'>[] = [];
  for (const job of jobs)
    raw.push({ t: job.arrival, type: 'job.arrived', jobId: job.id });
  for (const r of taskRows) {
    const id = taskId.get(String(r.id));
    const where = taskPlaces.get(String(r.id));
    if (!id || r.startedTick === undefined || !where) continue;
    // Without its person on the floor the task shows on its slot only.
    const base = {
      taskId: id,
      ...(where.onFloor ? { agentId: where.agentId } : {}),
      resourceId: where.resourceId,
    };
    if (where.onFloor)
      raw.push({ t: r.startedTick, type: 'task.assigned', ...base });
    raw.push({
      t: r.startedTick,
      type: 'task.started',
      ...base,
      data: {
        duration:
          (r.finishAtTick ?? r.startedTick + r.durationTicks) - r.startedTick,
      },
    });
    if (r.finishedTick !== undefined)
      raw.push({ t: r.finishedTick, type: 'task.finished', ...base });
  }
  // A customer is done when every drink has been delivered (one hand-off per customer).
  for (const orders of carts.values()) {
    if (orders.some((o) => o.deliveredTick === undefined)) continue;
    const customerId = orderInfo.get(String(orders[0].id))![0];
    const job = jobById.get(customerId)!;
    const t = Math.max(...orders.map((o) => o.deliveredTick!));
    raw.push({
      t,
      type: 'job.completed',
      jobId: customerId,
      data: { onTime: t <= job.deadline },
    });
  }
  const events: SyncEvent[] = raw
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        a.e.t - b.e.t || PRIORITY[a.e.type] - PRIORITY[b.e.type] || a.i - b.i,
    )
    .map(({ e }, i) => ({ seq: i + 1, ...e }));

  // Decisions: the engine records assignments only, with a score and reason codes.
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const decisions: Decision[] = [];
  for (const d of rows.decisions) {
    const id = taskId.get(String(d.taskId));
    const where =
      taskPlaces.get(String(d.taskId)) ?? slotOf.get(String(d.workerId));
    const task = id ? taskById.get(id) : undefined;
    if (!task || !where) continue;
    const slotLabel =
      layout.resources.find((r) => r.id === where.resourceId)?.label ??
      where.resourceId;
    // The decision names the worker the engine chose (the floor may draw
    // the slot's own person instead); helping = that worker's role differs
    // from the task's.
    const worker = slotOf.get(String(d.workerId))?.agentId ?? where.agentId;
    const own = layout.agents.find((a) => a.id === worker)?.primaryTypes;
    decisions.push({
      id: `d${d.sequence}`,
      t: d.tick,
      kind: 'assign',
      jobId: task.jobId,
      taskId: task.id,
      taskLabel: task.label,
      agentId: worker,
      resourceId: where.resourceId,
      crossRole: own !== undefined && !own.includes(task.type),
      summary: `${task.jobId} ${task.label} → ${agentName.get(worker)} @ ${slotLabel}`,
      detail: `score ${d.score.toFixed(2)} · reasons: ${d.reasonCodes.join(', ')}`,
      candidates: [],
      admission: {
        status: 'admitted',
        resourceId: where.resourceId,
        snapshotVersion: Number(d.snapshotVersion),
      },
    });
  }

  const now = rows.run.tick;
  const data: RunData = {
    run: {
      runId: `run-${rows.run.id}`,
      scenario,
      seed: rows.run.seed,
      policy,
      objective: { id: 'fixed_horizon', T },
      status: rows.run.status === 'completed' ? 'finished' : 'running',
      simTime: now,
    },
    layout,
    jobs,
    tasks,
    events,
    decisions,
  };
  // Coordinator time is reported by an external service; deterministic runs have none.
  const planningMs =
    rows.metrics && rows.metrics.coordinatorSampleCount > 0
      ? Math.round(rows.metrics.reportedCoordinatorMs * 10) / 10
      : null;
  data.scoreTimeline = [];
  for (let s = 0; s <= now; s++)
    data.scoreTimeline.push({
      t: s,
      ...scoreAt(data, s, planningMs),
    } as TimedScore);
  data.score = scoreAt(data, now, planningMs);
  for (const score of data.scoreTimeline) {
    score.execCost = rows.tasks.some(
      (t) => t.estimatedCostMicrousd !== undefined,
    )
      ? rows.tasks
          .filter(
            (t) => t.finishedTick !== undefined && t.finishedTick <= score.t,
          )
          .reduce(
            (n, t) => n + Number(t.estimatedCostMicrousd ?? 0n) / 1000000,
            0,
          )
      : null;
  }
  data.score.execCost =
    rows.metrics?.modeledSpentMicrousd === undefined
      ? null
      : Number(rows.metrics.modeledSpentMicrousd) / 1000000;
  data.score.objectiveValue = rows.metrics?.netReward;
  // Objective at each playhead second: the latest value seen at or before it.
  let objective: number | undefined;
  for (const score of data.scoreTimeline) {
    objective = rows.objectiveByTick?.get(score.t) ?? objective;
    score.objectiveValue = objective;
  }
  if (data.scoreTimeline.length)
    data.scoreTimeline[data.scoreTimeline.length - 1].objectiveValue =
      data.score.objectiveValue;
  if (data.scoreTimeline.length)
    data.scoreTimeline[data.scoreTimeline.length - 1].execCost =
      data.score.execCost;
  return data;
}
