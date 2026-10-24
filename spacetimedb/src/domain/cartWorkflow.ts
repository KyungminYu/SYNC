import { requireControl } from './access.ts';
import type { Order, Principal, State, Task } from './model.ts';
import { nextBase } from './model.ts';
import { addOrder, emit, refreshReady } from './engine.ts';
import { isRecipeId, type RecipeId } from './recipes.ts';

export function taskOrders(s: State, task: Task): Order[] {
  const ids = s.taskItems
    .filter((x) => x.taskId === task.id)
    .map((x) => x.orderId);
  return ids.length
    ? s.orders.filter((o) => ids.includes(o.id))
    : s.orders.filter((o) => o.id === task.orderId);
}
/** Only untouched tasks can be rewritten; accepted attempts are never merged. */
function merge(s: State, tasks: Task[], batched = false): Task {
  tasks = [...tasks].sort((a, b) => (a.id < b.id ? -1 : 1));
  const lead = tasks[0];
  if (
    tasks.some(
      (t) => t.attempt !== 0 || !['blocked', 'ready'].includes(t.status),
    )
  )
    throw new Error('CANNOT_REWRITE_STARTED_TASK');
  const ids = new Set(tasks.map((t) => t.id));
  const washes =
    lead.kind === 'prepare_milk'
      ? s.tasks.filter(
          (t) =>
            t.kind === 'wash_pitcher' &&
            s.dependencies.some(
              (d) => d.successorId === t.id && ids.has(d.predecessorId),
            ),
        )
      : [];
  const orders = [
    ...new Set(tasks.flatMap((t) => taskOrders(s, t).map((o) => o.id))),
  ];
  s.taskItems = s.taskItems.filter((x) => !ids.has(x.taskId));
  for (const orderId of orders)
    s.taskItems.push({ ...nextBase(s), taskId: lead.id, orderId });
  if (batched) {
    lead.durationTicks = Math.ceil(
      lead.durationTicks * (1 + 0.4 * (orders.length - 1)),
    );
    lead.estimatedCostMicrousd = BigInt(lead.durationTicks) * 1000n;
  }
  lead.value =
    lead.kind === 'deliver_order'
      ? orders.reduce(
          (v, id) => v + s.orders.find((o) => o.id === id)!.value,
          0,
        )
      : 0;
  lead.deadlineTick = Math.min(
    ...orders.map((id) => s.orders.find((o) => o.id === id)!.deadlineTick),
  );
  s.tasks = s.tasks.filter((t) => !ids.has(t.id) || t === lead);
  s.requirements = s.requirements.filter(
    (r) => !ids.has(r.taskId) || r.taskId === lead.id,
  );
  for (const edge of s.dependencies) {
    if (ids.has(edge.predecessorId)) edge.predecessorId = lead.id;
    if (ids.has(edge.successorId)) edge.successorId = lead.id;
  }
  const seen = new Set<string>();
  s.dependencies = s.dependencies.filter((e) => {
    const key = `${e.predecessorId}:${e.successorId}`;
    if (e.predecessorId === e.successorId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (washes.length > 1) merge(s, washes);
  return lead;
}
export interface CartInput {
  cartKey: string;
  items: { recipe: RecipeId; quantity: number }[];
  deadlineInTicks: number;
  value: number;
  priority: number;
  customerUseTicks: number;
}
/** Atomic checkout: duplicate drinks are distinct order instances, not duplicate keys. */
export function addCart(s: State, actor: Principal, input: CartInput): bigint {
  requireControl(s, actor);
  if (
    !input.cartKey ||
    input.cartKey.length > 75 ||
    !input.items.length ||
    input.items.some(
      (i) =>
        !isRecipeId(i.recipe) ||
        !Number.isSafeInteger(i.quantity) ||
        i.quantity < 1 ||
        i.quantity > 100,
    )
  )
    throw new Error('INVALID_CART');
  const spec = JSON.stringify([
    input.cartKey,
    input.items,
    input.deadlineInTicks,
    input.value,
    input.priority,
    input.customerUseTicks,
  ]);
  const old = s.carts.find((c) => c.externalKey === input.cartKey);
  if (old) {
    const submitted = s.events.find(
      (e) => e.type === 'cart_submitted' && e.cartId === old.id,
    );
    if (submitted?.detail !== spec) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
    return old.id;
  }
  const count = input.items.reduce((n, i) => n + i.quantity, 0);
  if (count + s.orders.length > s.run.maxOrders)
    throw new Error('CART_ORDER_LIMIT');
  const orders: Order[] = [];
  for (const item of input.items)
    for (let k = 0; k < item.quantity; k++)
      orders.push(
        addOrder(s, actor, {
          ...input,
          recipe: item.recipe,
          externalKey: `${input.cartKey}:${orders.length + 1}`,
        }),
      );
  const cartId = orders[0].cartId;
  const ids = new Set(orders.map((o) => o.id));
  const tasks = s.tasks.filter((t) => ids.has(t.orderId));
  for (const task of tasks)
    s.taskItems.push({
      ...nextBase(s),
      taskId: task.id,
      orderId: task.orderId,
    });
  for (const order of orders) {
    const assembly = tasks.find(
      (t) => t.orderId === order.id && t.kind === 'assemble_drink',
    )!;
    const payment = tasks.find(
      (t) => t.orderId === order.id && t.kind === 'take_payment',
    )!;
    const cups: Task = {
      ...assembly,
      ...nextBase(s),
      kind: 'prepare_cups',
      role: 'server',
      requiredCapabilities: ['cup_prep'],
      durationTicks: 1,
      estimatedCostMicrousd: 1000n,
      value: 0,
    };
    s.tasks.push(cups);
    s.taskItems.push({ ...nextBase(s), taskId: cups.id, orderId: order.id });
    s.dependencies.push(
      {
        ...nextBase(s),
        orderId: order.id,
        predecessorId: payment.id,
        successorId: cups.id,
      },
      {
        ...nextBase(s),
        orderId: order.id,
        predecessorId: cups.id,
        successorId: assembly.id,
      },
    );
    s.requirements.push({
      ...nextBase(s),
      taskId: cups.id,
      resourceId: s.resources.find((r) => r.role === 'server')!.id,
      units: 1,
    });
  }
  // One checkout/payment and one joined handoff/cleanup per customer cart.
  for (const kind of [
    'capture_order',
    'take_payment',
    'pick_up_drink',
    'deliver_order',
    'collect_tray',
    'clean_tray',
    'return_tray',
  ])
    merge(
      s,
      tasks.filter((t) => t.kind === kind),
    );
  for (const milk of tasks.filter((t) => t.kind === 'prepare_milk')) {
    const wash: Task = {
      ...milk,
      ...nextBase(s),
      kind: 'wash_pitcher',
      role: 'cleaner',
      requiredCapabilities: ['cleaner'],
      durationTicks: 1,
      estimatedCostMicrousd: 1000n,
      value: 0,
      deadlineTick: undefined,
    };
    s.tasks.push(wash);
    s.taskItems.push({
      ...nextBase(s),
      taskId: wash.id,
      orderId: milk.orderId,
    });
    s.dependencies.push({
      ...nextBase(s),
      orderId: milk.orderId,
      predecessorId: milk.id,
      successorId: wash.id,
    });
    s.requirements.push({
      ...nextBase(s),
      taskId: wash.id,
      resourceId: s.resources.find((r) => r.role === 'cleaner')!.id,
      units: 1,
    });
  }
  emit(s, 'cart_submitted', spec, { cartId });
  refreshReady(s);
  return cartId;
}
/** Batch only compatible, currently ready preparation; no speculative or active merge. */
export function batchReadyWork(s: State): void {
  for (const kind of ['prepare_coffee', 'prepare_milk', 'assemble_drink']) {
    const ready = s.tasks.filter(
      (t) =>
        t.kind === kind &&
        t.status === 'ready' &&
        t.attempt === 0 &&
        s.taskItems.some((i) => i.taskId === t.id) &&
        taskOrders(s, t).length === 1,
    );
    const groups = new Map<string, Task[]>();
    for (const t of ready) {
      const recipe = s.recipes.find(
        (r) => r.id === s.orders.find((o) => o.id === t.orderId)!.recipeId,
      )!.recipe;
      const group = groups.get(recipe) ?? [];
      group.push(t);
      groups.set(recipe, group);
    }
    for (const group of groups.values())
      for (let i = 0; i + 1 < group.length; i += 2) {
        const task = merge(s, group.slice(i, i + 2), true);
        emit(
          s,
          'tasks_batched',
          `${taskOrders(s, task).length} drinks share ${kind}`,
          { taskId: task.id },
        );
      }
  }
}
