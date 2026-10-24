import { measurePlanning } from './planningProbe.ts';
import { REWARD_WEIGHTS } from './reward.ts';
import { requestCancellation } from './externalExecution.ts';
import { adaptStaffing, admissionBackpressure } from './staffing.ts';
import { taskOrders, batchReadyWork } from './cartWorkflow.ts';
import {
  RollingHorizonEngine,
  planningFingerprint,
} from './rollingHorizonEngine.ts';
import {
  plan,
  validatePolicyConfig,
  DEFAULT_POLICY_CONFIG,
} from '../policies/scheduler.ts';
import type {
  PolicyConfig,
  Snapshot,
  Assignment,
} from '../policies/scheduler.ts';
import {
  materializeRecipe,
  ROLE_CAPACITIES,
  isRecipeId,
  RECIPE_INFO,
} from './recipes.ts';
import type { RecipeId } from './recipes.ts';
import type {
  State,
  Principal,
  Cart,
  CartStatus,
  Order,
  Recipe,
  Task,
  Run,
  Event,
  Job,
} from './model.ts';
import { nextBase, readPolicy } from './model.ts';
import { requireControl, requireOwner, requireService } from './access.ts';
const MAX_ORDERS = 100;
export function assertInteger(
  n: number,
  min: number,
  max: number,
  field: string,
): void {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`INVALID_${field}`);
}
export function emit(
  s: State,
  type: string,
  detail: string,
  refs: Partial<Event> = {},
): void {
  s.events.push({
    ...nextBase(s),
    sequence: ++s.run.eventSequence,
    tick: s.run.tick,
    type,
    detail,
    ...refs,
  });
}
export function emptyState(run: Run): State {
  return {
    run,
    taskItems: [],
    utensils: [],
    planner: [],
    members: [],
    carts: [],
    recipes: [],
    orders: [],
    tasks: [],
    dependencies: [],
    workers: [],
    resources: [],
    requirements: [],
    reservations: [],
    trays: [],
    jobs: [],
    decisions: [],
    events: [],
    telemetry: [],
  };
}
export function createState(
  id: bigint,
  ownerIdentityHex: string,
  name: string,
  seed: number,
  trayCount: number,
  mode: 'deterministic' | 'claude',
  budgetMicrousd?: bigint,
): State {
  assertInteger(seed, 0, 4294967295, 'SEED');
  assertInteger(trayCount, 1, 20, 'TRAYS');
  if (!name.trim() || name.length > 80) throw new Error('INVALID_NAME');
  if (budgetMicrousd !== undefined && budgetMicrousd < 0n)
    throw new Error('INVALID_BUDGET');
  const s = emptyState({
    id,
    ownerIdentityHex,
    name: name.trim(),
    seed,
    tick: 0,
    status: 'paused',
    arrivalsClosed: false,
    mode,
    version: 0n,
    nextId: 1n,
    eventSequence: 0n,
    policyJson: JSON.stringify(DEFAULT_POLICY_CONFIG),
    maxOrders: MAX_ORDERS,
    budgetMicrousd,
    modeledSpentMicrousd: 0n,
    reservedMicrousd: 0n,
  });
  for (const [role, capacity] of Object.entries(ROLE_CAPACITIES)) {
    s.resources.push({
      ...nextBase(s),
      label: `${role} station`,
      role,
      capacity,
      available: true,
    });
    for (let i = 0; i < capacity; i++)
      s.workers.push({
        ...nextBase(s),
        label: `${role} ${i + 1}`,
        role,
        capabilities:
          role === 'cashier'
            ? ['cashier', 'server', 'cup_prep']
            : role === 'server'
              ? ['server', 'cashier', 'cleaner', 'cup_prep']
              : role === 'cleaner'
                ? ['cleaner', 'cup_prep']
                : ['barista', 'cup_prep'],
        enabled: i === 0,
        speedFactor: 1,
        x: Object.keys(ROLE_CAPACITIES).indexOf(role) * 3,
        y: i * 2,
      });
  }
  for (let i = 0; i < 2; i++)
    s.utensils.push({ ...nextBase(s), kind: 'pitcher', state: 'clean' });
  for (let i = 0; i < trayCount; i++)
    s.trays.push({ ...nextBase(s), state: 'clean' });
  emit(
    s,
    'run_created',
    'Four active workers, seven available slots; station capacities 2/2/2/1.',
  );
  return s;
}
export function setMember(
  s: State,
  actor: Principal,
  identityHex: string,
  role: 'viewer' | 'operator' | 'service',
  enabled: boolean,
): void {
  requireOwner(s, actor);
  if (!identityHex || identityHex === s.run.ownerIdentityHex)
    throw new Error('INVALID_MEMBER');
  const existing = s.members.find((m) => m.identityHex === identityHex);
  if (
    (!enabled || role !== 'service') &&
    s.jobs.some(
      (j) =>
        j.claimantIdentityHex === identityHex &&
        ['claimed', 'uncertain'].includes(j.status),
    )
  )
    throw new Error('RECONCILE_CLAIMS_BEFORE_REVOKE');
  if (existing) {
    existing.permission = role;
    existing.enabled = enabled;
  } else
    s.members.push({ ...nextBase(s), identityHex, permission: role, enabled });
  s.run.version++;
}
export function setPolicy(
  s: State,
  actor: Principal,
  patch: Partial<PolicyConfig>,
): void {
  requireControl(s, actor);
  const config = { ...DEFAULT_POLICY_CONFIG, ...readPolicy(s), ...patch };
  validatePolicyConfig(config);
  s.run.policyJson = JSON.stringify(config);
  s.run.version++;
  emit(s, 'policy_changed', config.policy);
}
/**
 * Advisory priorities from an external planner (e.g. an LLM coordinator).
 * Only tasks that have not started take the new value; tasks already
 * assigned or finished are skipped, so a late answer is harmless. Policies
 * read `priority` as one term of their score; admission is unchanged.
 */
export function setTaskPriorities(
  s: State,
  actor: Principal,
  taskIds: bigint[],
  priorities: number[],
): void {
  requireControl(s, actor);
  if (taskIds.length !== priorities.length || taskIds.length > 500)
    throw new Error('INVALID_PRIORITIES');
  let changed = 0;
  for (const [i, id] of taskIds.entries()) {
    assertInteger(priorities[i]!, 0, 100, 'PRIORITY');
    const t = s.tasks.find((t) => t.id === id);
    if (!t) throw new Error('UNKNOWN_TASK');
    if (t.status !== 'blocked' && t.status !== 'ready') continue;
    if (t.priority === priorities[i]) continue;
    t.priority = priorities[i]!;
    changed++;
  }
  if (!changed) return;
  s.run.version++;
  emit(s, 'priorities_set', `${changed} tasks`);
}
export function addOrder(
  s: State,
  actor: Principal,
  args: {
    externalKey: string;
    // Orders sharing a cartKey belong to one customer cart; omitted = one-item cart.
    cartKey?: string;
    recipe: RecipeId;
    deadlineInTicks: number;
    value: number;
    priority: number;
    customerUseTicks: number;
  },
): Order {
  requireControl(s, actor);
  if (!args.externalKey || args.externalKey.length > 100)
    throw new Error('INVALID_EXTERNAL_KEY');
  const cartKey = args.cartKey ?? args.externalKey;
  if (!cartKey || cartKey.length > 100) throw new Error('INVALID_CART_KEY');
  const old = s.orders.find((o) => o.externalKey === args.externalKey);
  if (old) {
    if (
      recipeOf(s, old).recipe !== args.recipe ||
      s.carts.find((c) => c.id === old.cartId)?.externalKey !== cartKey ||
      old.deadlineTick - old.arrivalTick !== args.deadlineInTicks ||
      old.value !== args.value ||
      old.priority !== args.priority ||
      old.customerUseTicks !== args.customerUseTicks
    )
      throw new Error('IDEMPOTENCY_KEY_CONFLICT');
    return old;
  }
  if (s.orders.length >= s.run.maxOrders || !isRecipeId(args.recipe))
    throw new Error('INVALID_ORDER_OR_LIMIT');
  assertInteger(args.deadlineInTicks, 1, 10000, 'DEADLINE');
  assertInteger(
    s.run.tick + args.deadlineInTicks,
    0,
    4294967295,
    'ABSOLUTE_DEADLINE',
  );
  assertInteger(args.customerUseTicks, 0, 10000, 'CUSTOMER_WAIT');
  assertInteger(args.value, 1, 10000, 'VALUE');
  assertInteger(args.priority, 0, 100, 'PRIORITY');
  if (s.run.status === 'completed')
    throw new Error('RUN_COMPLETED_CREATE_NEW_RUN');
  if (s.run.arrivalsClosed) throw new Error('ARRIVALS_CLOSED');
  // Reuse the open cart for this key, or start a new one at this tick.
  let cart = s.carts.find((c) => c.externalKey === cartKey);
  if (
    cart &&
    s.events.some((e) => e.type === 'cart_submitted' && e.cartId === cart?.id)
  )
    throw new Error('CART_SEALED');
  if (cart && cart.status !== 'open') throw new Error('CART_CLOSED');
  if (!cart) {
    cart = {
      ...nextBase(s),
      externalKey: cartKey,
      arrivalTick: s.run.tick,
      status: 'open',
    } satisfies Cart;
    s.carts.push(cart);
  }
  const recipe: Recipe = s.recipes.find((r) => r.recipe === args.recipe) ?? {
    ...nextBase(s),
    recipe: args.recipe,
    ...RECIPE_INFO[args.recipe],
  };
  if (!s.recipes.includes(recipe)) s.recipes.push(recipe);
  const o: Order = {
    ...nextBase(s),
    cartId: cart.id,
    externalKey: args.externalKey,
    recipeId: recipe.id,
    arrivalTick: s.run.tick,
    deadlineTick: s.run.tick + args.deadlineInTicks,
    value: args.value,
    priority: args.priority,
    customerUseTicks: args.customerUseTicks,
    status: 'open',
  };
  s.orders.push(o);
  const defs = materializeRecipe(args.recipe);
  const ids = new Map<string, bigint>();
  for (const d of defs) {
    const task: Task = {
      ...nextBase(s),
      cartId: o.cartId,
      orderId: o.id,
      kind: d.kind,
      role: d.role,
      status: 'blocked',
      releaseTick: s.run.tick,
      deadlineTick: d.role === 'cleaner' ? undefined : o.deadlineTick,
      durationTicks: d.durationTicks,
      priority: o.priority,
      value: d.rewardDelivery ? o.value : 0,
      requiredCapabilities: [...d.capabilities],
      estimatedCostMicrousd: d.estimatedCostMicrousd,
      attempt: 0,
      customerReleaseGuard: d.customerReleaseGuard,
      trayMode: d.trayMode,
    };
    s.tasks.push(task);
    ids.set(d.kind, task.id);
    const resource = s.resources.find((r) => r.role === d.role)!;
    s.requirements.push({
      ...nextBase(s),
      taskId: task.id,
      resourceId: resource.id,
      units: 1,
    });
  }
  for (const d of defs)
    for (const pred of d.dependencies)
      s.dependencies.push({
        ...nextBase(s),
        orderId: o.id,
        predecessorId: ids.get(pred)!,
        successorId: ids.get(d.kind)!,
      });
  refreshReady(s);
  s.run.version++;
  emit(s, 'order_arrived', args.recipe, { cartId: o.cartId, orderId: o.id });
  return o;
}
export function recipeOf(s: State, o: Order): Recipe {
  const r = s.recipes.find((r) => r.id === o.recipeId);
  if (!r) throw new Error('RECIPE_NOT_FOUND');
  return r;
}
// Cart status is the least-advanced status among its orders.
function refreshCartStatus(s: State, cartId: bigint): void {
  const cart = s.carts.find((c) => c.id === cartId);
  if (!cart) throw new Error('CART_NOT_FOUND');
  const statuses = s.orders
    .filter((o) => o.cartId === cartId)
    .map((o) => o.status);
  const next: CartStatus = statuses.includes('open')
    ? 'open'
    : statuses.includes('delivered')
      ? 'delivered'
      : 'cleaned';
  if (cart.status !== next) {
    cart.status = next;
    emit(s, `cart_${next}`, cart.externalKey, { cartId });
  }
}
export function blockedReason(s: State, t: Task): string {
  if (!['blocked', 'ready'].includes(t.status)) return t.status;
  if (t.releaseTick > s.run.tick) return 'release_time';
  if (
    s.dependencies
      .filter((d) => d.successorId === t.id)
      .some(
        (d) =>
          s.tasks.find((p) => p.id === d.predecessorId)?.status !== 'succeeded',
      )
  )
    return 'dependencies';
  if (
    t.customerReleaseGuard &&
    taskOrders(s, t).some(
      (o) =>
        o.customerReleaseTick === undefined ||
        s.run.tick < o.customerReleaseTick,
    )
  )
    return 'customer_using_tray';
  if (
    t.kind === 'prepare_milk' &&
    s.taskItems.some((x) => x.taskId === t.id) &&
    !s.utensils.some((u) => u.state === 'clean')
  )
    return 'clean_pitcher';
  return 'eligible';
}
export function refreshReady(s: State): void {
  for (const t of s.tasks)
    if (t.status === 'blocked' || t.status === 'ready')
      t.status = blockedReason(s, t) === 'eligible' ? 'ready' : 'blocked';
}
export function freeUnits(s: State, resourceId: bigint): number {
  const r = s.resources.find((x) => x.id === resourceId);
  if (!r || !r.available) return 0;
  return (
    r.capacity -
    s.reservations
      .filter((x) => x.resourceId === resourceId)
      .reduce((sum, x) => sum + x.units, 0)
  );
}
function duration(s: State, t: Task, workerId: bigint): number {
  const worker = s.workers.find((w) => w.id === workerId)!;
  return Math.max(1, Math.ceil(t.durationTicks / worker.speedFactor));
}
export function downstreamTail(
  s: State,
  t: Task,
  visited = new Set<bigint>(),
): number {
  if (visited.has(t.id)) throw new Error('DEPENDENCY_CYCLE');
  // Delivery is the latency/value terminal. Cleanup has its own chain and no delivery deadline.
  if (t.kind === 'deliver_order' || t.kind === 'return_tray') return 0;
  const path = new Set(visited);
  path.add(t.id);
  const succ = s.dependencies
    .filter((d) => d.predecessorId === t.id)
    .map((d) => s.tasks.find((x) => x.id === d.successorId)!);
  return Math.max(
    0,
    ...succ.map((n) => n.durationTicks + downstreamTail(s, n, path)),
  );
}
export function snapshot(s: State): Snapshot {
  refreshReady(s);
  const tasks = s.tasks.filter(
    (t) =>
      t.status === 'ready' &&
      (readPolicy(s).policy !== 'primal_dual' ||
        !admissionBackpressure(s, t.id)),
  );
  return {
    tick: s.run.tick,
    budgetRemainingMicrousd:
      s.run.budgetMicrousd === undefined
        ? undefined
        : s.run.budgetMicrousd -
          s.run.modeledSpentMicrousd -
          s.run.reservedMicrousd,
    tasks: tasks.map((t) => ({
      id: t.id,
      orderId: t.orderId,
      releaseTick: t.releaseTick,
      deadlineTick: t.deadlineTick,
      priority: t.priority,
      value: t.value,
      remainingPathTicks: downstreamTail(s, t),
      requiredCapabilities: t.requiredCapabilities,
      requirements: s.requirements
        .filter((r) => r.taskId === t.id)
        .map((r) => ({ resourceId: r.resourceId, units: r.units })),
      trayMode:
        t.trayMode === 'acquire' &&
        s.orders.find((o) => o.id === t.orderId)?.trayId !== undefined
          ? 'none'
          : t.trayMode,
    })),
    workers: s.workers
      .filter((w) => w.enabled && w.currentTaskId === undefined)
      .map((w) => ({
        id: w.id,
        capabilities: w.capabilities,
        estimates: tasks.map((t) => ({
          taskId: t.id,
          durationTicks: duration(s, t, w.id),
          costMicrousd: t.estimatedCostMicrousd,
        })),
      })),
    resources: s.resources.map((r) => ({
      id: r.id,
      freeUnits: freeUnits(s, r.id),
    })),
    freeTrayIds: s.trays
      .filter((t) => t.state === 'clean' && t.orderId === undefined)
      .map((t) => t.id),
  };
}
function admit(s: State, a: Assignment, policy: string): void {
  const t = s.tasks.find((t) => t.id === a.taskId);
  const w = s.workers.find((w) => w.id === a.workerId);
  if (
    !t ||
    !w ||
    t.status !== 'ready' ||
    !w.enabled ||
    w.currentTaskId !== undefined ||
    !t.requiredCapabilities.every((k) => w.capabilities.includes(k))
  )
    throw new Error('INVALID_ASSIGNMENT');
  if (blockedReason(s, t) !== 'eligible') return;
  if (policy === 'primal_dual' && admissionBackpressure(s, t.id)) return;
  const reqs = s.requirements.filter((r) => r.taskId === t.id);
  const totals = new Map<bigint, number>();
  for (const r of reqs)
    totals.set(r.resourceId, (totals.get(r.resourceId) ?? 0) + r.units);
  if ([...totals].some(([id, units]) => freeUnits(s, id) < units))
    throw new Error('RESOURCE_CONFLICT');
  if (
    s.run.budgetMicrousd !== undefined &&
    s.run.modeledSpentMicrousd +
      s.run.reservedMicrousd +
      t.estimatedCostMicrousd >
      s.run.budgetMicrousd
  )
    return;
  const order = s.orders.find((o) => o.id === t.orderId)!;
  if (t.trayMode === 'acquire' && order.trayId === undefined) {
    const tray = s.trays.find(
      (x) =>
        x.id === a.trayId && x.state === 'clean' && x.orderId === undefined,
    );
    if (!tray) throw new Error('TRAY_CONFLICT');
    tray.orderId = order.id;
    tray.state = 'in_use';
    for (const member of taskOrders(s, t)) member.trayId = tray.id;
  }
  if (
    (t.trayMode === 'release' ||
      (t.role === 'cleaner' && t.kind !== 'wash_pitcher') ||
      t.kind === 'deliver_order') &&
    order.trayId === undefined
  )
    throw new Error('ORDER_HAS_NO_TRAY');
  if (t.kind === 'prepare_milk' && s.taskItems.some((x) => x.taskId === t.id)) {
    const pitcher = s.utensils.find((u) => u.state === 'clean');
    if (!pitcher) throw new Error('NO_CLEAN_PITCHER');
    pitcher.state = 'held';
    pitcher.taskId = t.id;
  }
  if (t.kind === 'wash_pitcher') {
    const pred = s.dependencies.find((d) => d.successorId === t.id)!;
    const pitcher = s.utensils.find(
      (u) => u.taskId === pred.predecessorId && u.state === 'dirty',
    );
    if (!pitcher) throw new Error('PITCHER_NOT_DIRTY');
    pitcher.state = 'washing';
  }
  t.attempt++;
  t.workerId = w.id;
  t.status = 'assigned';
  t.finishedTick = undefined;
  t.errorCode = undefined;
  w.currentTaskId = t.id;
  w.currentAttempt = t.attempt;
  for (const r of reqs)
    s.reservations.push({
      ...nextBase(s),
      taskId: t.id,
      workerId: w.id,
      attempt: t.attempt,
      resourceId: r.resourceId,
      units: r.units,
    });
  s.run.reservedMicrousd += t.estimatedCostMicrousd;
  const job: Job = {
    ...nextBase(s),
    taskId: t.id,
    workerId: w.id,
    attempt: t.attempt,
    status: 'pending',
    expectedAction: t.kind,
    reservedCostMicrousd: t.estimatedCostMicrousd,
    observationJson: JSON.stringify({
      runId: s.run.id.toString(),
      taskId: t.id.toString(),
      orderId: order.id.toString(),
      orderIds: taskOrders(s, t).map((o) => o.id.toString()),
      cartKeys: [
        ...new Set(
          taskOrders(s, t).map(
            (o) => s.carts.find((c) => c.id === o.cartId)!.externalKey,
          ),
        ),
      ],
      durationTicks: duration(s, t, w.id),
      attempt: t.attempt,
      recipe: recipeOf(s, order).recipe,
      action: t.kind,
      tick: s.run.tick,
    }),
  };
  s.jobs.push(job);
  s.decisions.push({
    ...nextBase(s),
    sequence: ++s.run.eventSequence,
    tick: s.run.tick,
    policy,
    taskId: t.id,
    workerId: w.id,
    attempt: t.attempt,
    score: a.score,
    reasonCodes: a.reasonCodes,
    snapshotVersion: s.run.version,
  });
  emit(s, 'task_assigned', policy, {
    taskId: t.id,
    workerId: w.id,
    attempt: t.attempt,
  });
  if (s.run.mode === 'deterministic') startJob(s, job);
}
export function schedule(s: State): void {
  if (s.run.status !== 'running') return;
  const config = readPolicy(s);
  refreshReady(s);
  if (config.policy === 'primal_dual') {
    batchReadyWork(s);
    adaptStaffing(s);
    if (
      s.run.mode === 'claude' &&
      !s.utensils.some((u) => u.state === 'clean') &&
      s.tasks.some((t) => t.kind === 'wash_pitcher' && t.status === 'ready')
    ) {
      for (const job of s.jobs.filter(
        (j) =>
          j.status === 'accepted' &&
          s.tasks.some((t) => t.id === j.taskId && t.kind === 'clean_tray'),
      )) {
        const cleaning = s.tasks.find((t) => t.id === job.taskId)!;
        const waiting = s.tasks.filter(
          (t) =>
            t.kind === 'prepare_milk' &&
            ['blocked', 'ready'].includes(t.status),
        );
        const remaining = Math.max(
          0,
          (cleaning.finishAtTick ?? s.run.tick + 1) - s.run.tick,
        );
        const potential =
          (waiting.reduce(
            (n, t) => n + taskOrders(s, t).reduce((v, o) => v + o.value, 0),
            0,
          ) *
            remaining) /
          (1 + remaining);
        const penalty =
          REWARD_WEIGHTS.cancelledAttempt +
          Number(job.reservedCostMicrousd) / 1000000;
        if (potential > penalty) {
          emit(
            s,
            'preemption_evaluated',
            `potential=${potential};penalty=${penalty}`,
            { taskId: job.taskId, attempt: job.attempt },
          );
          requestCancellation(
            s,
            { identityHex: s.run.ownerIdentityHex },
            job.id,
          );
        }
      }
    }
  }
  const frontier = snapshot(s);
  if (config.policy === 'primal_dual') {
    const forecast = measurePlanning(() => new RollingHorizonEngine().plan(s));
    if (!forecast) return;
    for (const a of forecast.filter((a) => a.startTick === s.run.tick))
      admit(s, a, 'primal_dual');
    s.planner[0]!.fingerprint = planningFingerprint(s);
    s.run.version++;
    assertInvariants(s);
    return;
  }
  // Switching away invalidates warm state and forecasts for the prior policy.
  s.planner = [];
  const proposal = measurePlanning(() => plan(frontier, config));
  for (const a of proposal) admit(s, a, config.policy ?? 'sync_greedy');
  s.run.version++;
  assertInvariants(s);
}
function startJob(s: State, j: Job): void {
  const t = s.tasks.find((t) => t.id === j.taskId)!;
  if (t.attempt !== j.attempt || t.status !== 'assigned')
    throw new Error('STALE_ATTEMPT');
  j.status = 'accepted';
  j.submittedTick = s.run.tick;
  t.status = 'running';
  t.startedTick = s.run.tick;
  t.finishAtTick = s.run.tick + duration(s, t, j.workerId);
  if (t.kind === 'clean_tray') {
    const o = s.orders.find((o) => o.id === t.orderId)!;
    s.trays.find((tr) => tr.id === o.trayId)!.state = 'cleaning';
  }
  emit(s, 'task_started', t.kind, {
    taskId: t.id,
    workerId: j.workerId,
    attempt: t.attempt,
  });
}
export function claimJob(s: State, actor: Principal, jobId: bigint): void {
  requireService(s, actor);
  if (s.run.mode !== 'claude' || s.run.status !== 'running')
    throw new Error('NOT_LIVE_RUN');
  const j = s.jobs.find((j) => j.id === jobId);
  if (!j) throw new Error('JOB_NOT_FOUND');
  if (j.status === 'claimed' && j.claimantIdentityHex === actor.identityHex)
    return;
  if (j.status !== 'pending') throw new Error('ALREADY_CLAIMED');
  j.status = 'claimed';
  j.claimantIdentityHex = actor.identityHex;
  j.claimedTick = s.run.tick;
  s.run.version++;
}
export function submitAction(
  s: State,
  actor: Principal,
  jobId: bigint,
  attempt: number,
  action: string,
): void {
  requireService(s, actor);
  const j = s.jobs.find((j) => j.id === jobId);
  if (
    !j ||
    j.claimantIdentityHex !== actor.identityHex ||
    j.attempt !== attempt
  )
    throw new Error('INVALID_JOB_OWNER_OR_ATTEMPT');
  const t = s.tasks.find((t) => t.id === j.taskId)!;
  if (t.attempt !== attempt) throw new Error('STALE_ATTEMPT');
  if (j.expectedAction !== action) throw new Error('INVALID_ACTION');
  if (j.status === 'accepted') return;
  if (s.run.status !== 'running' || j.status !== 'claimed')
    throw new Error('JOB_NOT_CLAIMED_OR_RUN_PAUSED');
  startJob(s, j);
  s.run.version++;
  assertInvariants(s);
}
export function finishTask(s: State, taskId: bigint, attempt: number): void {
  const t = s.tasks.find((t) => t.id === taskId);
  if (!t || t.attempt !== attempt) throw new Error('STALE_ATTEMPT');
  if (t.status === 'succeeded') return;
  if (
    t.status !== 'running' ||
    t.finishAtTick === undefined ||
    t.finishAtTick > s.run.tick
  )
    throw new Error('NOT_FINISHED');
  const w = s.workers.find((w) => w.id === t.workerId);
  if (!w || w.currentTaskId !== t.id || w.currentAttempt !== attempt)
    throw new Error('STALE_WORKER');
  t.status = 'succeeded';
  t.finishedTick = s.run.tick;
  w.currentTaskId = undefined;
  w.currentAttempt = undefined;
  s.reservations = s.reservations.filter(
    (r) => !(r.taskId === t.id && r.attempt === attempt),
  );
  const job = s.jobs.find((j) => j.taskId === t.id && j.attempt === attempt)!;
  job.status = 'succeeded';
  s.run.reservedMicrousd -= job.reservedCostMicrousd;
  s.run.modeledSpentMicrousd += job.reservedCostMicrousd;
  const o = s.orders.find((o) => o.id === t.orderId)!;
  if (t.kind === 'prepare_milk') {
    const pitcher = s.utensils.find((u) => u.taskId === t.id);
    if (pitcher) pitcher.state = 'dirty';
  }
  if (t.kind === 'wash_pitcher') {
    const pred = s.dependencies.find((d) => d.successorId === t.id)!;
    const pitcher = s.utensils.find((u) => u.taskId === pred.predecessorId);
    if (!pitcher || pitcher.state !== 'washing')
      throw new Error('PITCHER_OWNERSHIP');
    pitcher.state = 'clean';
    pitcher.taskId = undefined;
  }
  if (t.kind === 'deliver_order') {
    for (const member of taskOrders(s, t)) {
      member.status = 'delivered';
      member.deliveredTick = s.run.tick;
      member.customerReleaseTick = s.run.tick + member.customerUseTicks;
    }
  }
  if (t.kind === 'collect_tray')
    s.trays.find((tr) => tr.id === o.trayId)!.state = 'dirty';
  if (t.trayMode === 'release') {
    const tray = s.trays.find((tr) => tr.id === o.trayId);
    if (!tray || tray.orderId !== o.id) throw new Error('TRAY_OWNER_MISMATCH');
    tray.state = 'clean';
    tray.orderId = undefined;
    for (const member of taskOrders(s, t)) {
      member.trayId = undefined;
      member.status = 'cleaned';
      member.cleanupCompletedTick = s.run.tick;
    }
  }
  emit(s, 'task_succeeded', t.kind, {
    taskId: t.id,
    cartId: o.cartId,
    orderId: o.id,
    workerId: w.id,
    attempt,
  });
  refreshCartStatus(s, o.cartId);
  refreshReady(s);
}
export function advance(s: State): void {
  if (s.run.status !== 'running') return;
  assertInteger(s.run.tick + 1, 0, 4294967295, 'TICK');
  s.run.tick++;
  for (const t of s.tasks
    .filter(
      (t) =>
        s.run.mode === 'deterministic' &&
        t.status === 'running' &&
        t.finishAtTick !== undefined &&
        t.finishAtTick <= s.run.tick,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1)))
    finishTask(s, t.id, t.attempt);
  refreshReady(s);
  schedule(s);
  if (
    s.run.arrivalsClosed &&
    s.orders.every((o) => o.status === 'cleaned') &&
    s.tasks.every((t) => t.status === 'succeeded')
  ) {
    s.run.status = 'completed';
    emit(s, 'run_completed', 'All orders delivered and cleaned.');
  }
  assertInvariants(s);
}
export function setRunning(s: State, actor: Principal, running: boolean): void {
  requireControl(s, actor);
  if (s.run.status === 'completed') throw new Error('RUN_COMPLETED');
  s.run.status = running ? 'running' : 'paused';
  s.run.version++;
  emit(s, running ? 'run_started' : 'run_paused', '');
  if (running) schedule(s);
}
export function setAvailability(
  s: State,
  actor: Principal,
  resourceId: bigint,
  available: boolean,
): void {
  requireControl(s, actor);
  const r = s.resources.find((r) => r.id === resourceId);
  if (!r) throw new Error('RESOURCE_NOT_FOUND');
  // A disruption blocks new admissions; admitted non-preemptive operations drain normally.
  r.available = available;
  s.run.version++;
  emit(s, 'resource_availability_changed', `${r.label}:${available}`);
  schedule(s);
}
export function markUncertain(s: State, actor: Principal, jobId: bigint): void {
  requireControl(s, actor);
  const j = s.jobs.find((j) => j.id === jobId);
  if (!j || !['claimed', 'accepted', 'cancel_requested'].includes(j.status))
    throw new Error('JOB_NOT_CLAIMED');
  j.status = 'uncertain';
  s.tasks.find((t) => t.id === j.taskId)!.status = 'uncertain';
  s.run.version++;
  emit(s, 'job_uncertain', 'Reservations retained; reconcile before retry.', {
    taskId: j.taskId,
    attempt: j.attempt,
  });
}
export function reconcile(
  s: State,
  actor: Principal,
  jobId: bigint,
  resolution: 'resume' | 'retry_safe',
): void {
  requireOwner(s, actor);
  const j = s.jobs.find((j) => j.id === jobId);
  if (!j || j.status !== 'uncertain') throw new Error('JOB_NOT_UNCERTAIN');
  const t = s.tasks.find((t) => t.id === j.taskId)!;
  if (t.attempt !== j.attempt) throw new Error('STALE_ATTEMPT');
  if (resolution === 'resume') {
    if (s.run.status !== 'running') throw new Error('RUN_PAUSED');
    t.status = 'assigned';
    startJob(s, j);
  } else {
    // Operator attests that the external action did not occur. Retain order tray.
    j.status = 'failed';
    const pitcher = s.utensils.find((u) => u.taskId === t.id);
    if (t.kind === 'prepare_milk' && pitcher) {
      pitcher.state = 'clean';
      pitcher.taskId = undefined;
    }
    if (t.kind === 'wash_pitcher') {
      const pred = s.dependencies.find((d) => d.successorId === t.id);
      const held = s.utensils.find((u) => u.taskId === pred?.predecessorId);
      if (held) held.state = 'dirty';
    }
    s.reservations = s.reservations.filter(
      (r) => !(r.taskId === t.id && r.attempt === j.attempt),
    );
    const w = s.workers.find((w) => w.id === j.workerId)!;
    w.currentTaskId = undefined;
    w.currentAttempt = undefined;
    s.run.reservedMicrousd -= j.reservedCostMicrousd;
    t.status = 'blocked';
    t.workerId = undefined;
    refreshReady(s);
    schedule(s);
  }
  s.run.version++;
  emit(s, 'job_reconciled', resolution, { taskId: t.id, attempt: j.attempt });
  assertInvariants(s);
}
export function assertInvariants(s: State): void {
  const tasks = new Map(s.tasks.map((t) => [t.id, t]));
  const orders = new Map(s.orders.map((o) => [o.id, o]));
  for (const group of [
    s.members,
    s.carts,
    s.recipes,
    s.orders,
    s.tasks,
    s.dependencies,
    s.workers,
    s.resources,
    s.requirements,
    s.reservations,
    s.trays,
    s.jobs,
    s.decisions,
    s.events,
    s.telemetry,
    s.taskItems,
    s.utensils,
  ])
    for (const row of group)
      if (row.runId !== s.run.id || row.key !== `${row.runId}:${row.id}`)
        throw new Error('CROSS_RUN_ROW');
  const membership = new Set<string>();
  for (const item of s.taskItems) {
    const pair = `${item.taskId}:${item.orderId}`;
    if (
      !tasks.has(item.taskId) ||
      !orders.has(item.orderId) ||
      membership.has(pair)
    )
      throw new Error('INVALID_TASK_MEMBERSHIP');
    membership.add(pair);
  }
  for (const utensil of s.utensils) {
    if (
      !['clean', 'held', 'dirty', 'washing'].includes(utensil.state) ||
      (utensil.state === 'clean') !== (utensil.taskId === undefined) ||
      (utensil.taskId !== undefined && !tasks.has(utensil.taskId))
    )
      throw new Error('UTENSIL_OWNERSHIP');
  }
  // Every order references a reusable recipe definition and exactly one cart.
  const recipeOwners = new Set<bigint>();
  for (const o of s.orders) {
    if (!s.carts.some((c) => c.id === o.cartId)) throw new Error('ORDER_CART');
    if (!s.recipes.some((r) => r.id === o.recipeId))
      throw new Error('ORDER_RECIPE');
    recipeOwners.add(o.recipeId);
  }
  if (recipeOwners.size !== s.recipes.length) throw new Error('ORPHAN_RECIPE');
  for (const t of s.tasks) {
    const o = orders.get(t.orderId);
    if (o && o.cartId !== t.cartId) throw new Error('TASK_ORDER_LINK');
  }
  for (const d of s.dependencies) {
    if (
      !tasks.has(d.predecessorId) ||
      !tasks.has(d.successorId) ||
      !taskOrders(s, tasks.get(d.predecessorId)!).some(
        (o) => o.id === d.orderId,
      ) ||
      !taskOrders(s, tasks.get(d.successorId)!).some((o) => o.id === d.orderId)
    )
      throw new Error('INVALID_EDGE');
  }
  const active = s.tasks.filter((t) =>
    ['assigned', 'running', 'uncertain'].includes(t.status),
  );
  for (const w of s.workers) {
    const owned = active.filter((t) => t.workerId === w.id);
    if (
      owned.length > 1 ||
      (w.currentTaskId === undefined) !== (owned.length === 0) ||
      owned.some(
        (t) => t.id !== w.currentTaskId || t.attempt !== w.currentAttempt,
      )
    )
      throw new Error('WORKER_CAPACITY');
  }
  for (const t of active) {
    if (
      !orders.has(t.orderId) ||
      !s.workers.some((w) => w.id === t.workerId) ||
      s.dependencies
        .filter((d) => d.successorId === t.id)
        .some((d) => tasks.get(d.predecessorId)?.status !== 'succeeded')
    )
      throw new Error('ACTIVE_DEPENDENCY');
  }
  for (const r of s.resources) {
    const used = s.reservations
      .filter((x) => x.resourceId === r.id)
      .reduce((n, x) => n + x.units, 0);
    if (used < 0 || used > r.capacity) throw new Error('RESOURCE_CAPACITY');
  }
  for (const r of s.reservations) {
    const t = tasks.get(r.taskId);
    if (
      !t ||
      !active.includes(t) ||
      t.attempt !== r.attempt ||
      t.workerId !== r.workerId ||
      !s.resources.some((x) => x.id === r.resourceId)
    )
      throw new Error('STALE_RESERVATION');
  }
  for (const t of active)
    for (const req of s.requirements.filter((r) => r.taskId === t.id)) {
      const sum = s.reservations
        .filter(
          (r) =>
            r.taskId === t.id &&
            r.attempt === t.attempt &&
            r.resourceId === req.resourceId,
        )
        .reduce((n, r) => n + r.units, 0);
      if (sum !== req.units) throw new Error('MISSING_RESERVATION');
    }
  for (const tray of s.trays) {
    if (tray.state === 'clean' && tray.orderId !== undefined)
      throw new Error('DIRTY_CLEAN_TRAY');
    if (
      tray.state !== 'clean' &&
      (tray.orderId === undefined ||
        orders.get(tray.orderId)?.trayId !== tray.id)
    )
      throw new Error('TRAY_OWNERSHIP');
  }
  for (const o of s.orders)
    if (
      o.trayId !== undefined &&
      !s.trays.some(
        (tr) =>
          tr.id === o.trayId && orders.get(tr.orderId!)?.cartId === o.cartId,
      )
    )
      throw new Error('ORDER_TRAY_MISMATCH');
  if (
    s.run.budgetMicrousd !== undefined &&
    s.run.modeledSpentMicrousd + s.run.reservedMicrousd > s.run.budgetMicrousd
  )
    throw new Error('BUDGET_CAP');
  const outstanding = s.jobs
    .filter((j) =>
      active.some((t) => t.id === j.taskId && t.attempt === j.attempt),
    )
    .reduce((n, j) => n + j.reservedCostMicrousd, 0n);
  if (s.run.reservedMicrousd !== outstanding || s.run.reservedMicrousd < 0n)
    throw new Error('BUDGET_LEDGER');
}
export function closeArrivals(s: State, actor: Principal): void {
  requireControl(s, actor);
  s.run.arrivalsClosed = true;
  s.run.version++;
  emit(s, 'arrivals_closed', 'No more orders will be admitted.');
  if (
    s.run.status === 'running' &&
    s.orders.every((o) => o.status === 'cleaned') &&
    s.tasks.every((t) => t.status === 'succeeded')
  ) {
    s.run.status = 'completed';
    emit(s, 'run_completed', 'All admitted orders delivered and cleaned.');
  }
}

export function setCapacity(
  s: State,
  actor: Principal,
  resourceId: bigint,
  capacity: number,
): void {
  requireControl(s, actor);
  assertInteger(capacity, 0, 1000000, 'CAPACITY');
  const resource = s.resources.find((r) => r.id === resourceId);
  if (!resource) throw new Error('RESOURCE_NOT_FOUND');
  const held = s.reservations
    .filter((r) => r.resourceId === resourceId)
    .reduce((sum, r) => sum + r.units, 0);
  if (capacity < held) throw new Error('CAPACITY_BELOW_RESERVATIONS');
  resource.capacity = capacity;
  s.run.version++;
  emit(s, 'capacity_changed', resourceId.toString());
  schedule(s);
}
export function setBudget(
  s: State,
  actor: Principal,
  budgetMicrousd: bigint | undefined,
): void {
  requireControl(s, actor);
  if (
    budgetMicrousd !== undefined &&
    (budgetMicrousd < s.run.modeledSpentMicrousd + s.run.reservedMicrousd ||
      budgetMicrousd > 18446744073709551615n)
  )
    throw new Error('INVALID_BUDGET');
  s.run.budgetMicrousd = budgetMicrousd;
  s.run.version++;
  emit(s, 'budget_changed', budgetMicrousd?.toString() ?? 'unlimited');
  schedule(s);
}
