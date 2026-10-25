import { evaluateRun } from '../domain/reward.ts';
import { taskOrders } from '../domain/cartWorkflow.ts';
import { t } from 'spacetimedb/server';
import { db } from '../tables.ts';
import { readableRuns, serviceRuns } from './store.ts';
import type { ViewDb } from './store.ts';
import type { State } from '../domain/model.ts';
import { emptyState } from '../domain/engine.ts';
import {
  blockedReason,
  freeUnits,
  downstreamTail,
  recipeOf,
} from '../domain/engine.ts';
import { TASK_STEPS } from '../domain/recipes.ts';
import { DEFAULT_POLICY_CONFIG } from '../policies/scheduler.ts';
// No table .iter() in views: every read is an indexed find/filter.
const base = { key: t.string(), id: t.u64(), run_id: t.u64() };
const runRow = t.row('UiRunPayload', {
  id: t.u64(),
  name: t.string(),
  seed: t.u32(),
  tick: t.u32(),
  status: t.string(),
  mode: t.string(),
  version: t.u64(),
  policy_json: t.string(),
  can_control: t.bool(),
  arrivals_closed: t.bool(),
});
const orderRow = t.row('UiOrderPayload', {
  ...base,
  // Customer cart this order (menu item) belongs to.
  cart_key: t.string(),
  recipe_key: t.string(),
  status: t.string(),
  arrival_tick: t.u32(),
  deadline_tick: t.u32(),
  value: t.u32(),
  priority: t.u32(),
  delivered_tick: t.option(t.u32()),
  customer_release_tick: t.option(t.u32()),
  cleanup_completed_tick: t.option(t.u32()),
  tray_id: t.option(t.u64()),
  ready_tasks: t.u32(),
  active_tasks: t.u32(),
  delivery_late: t.bool(),
});
const taskRow = t.row('UiTaskPayload', {
  ...base,
  order_id: t.u64(),
  order_ids: t.array(t.u64()),
  kind: t.string(),
  role: t.string(),
  status: t.string(),
  block_reason: t.string(),
  resource_blocked: t.bool(),
  release_tick: t.u32(),
  deadline_tick: t.option(t.u32()),
  duration_ticks: t.u32(),
  estimated_cost_microusd: t.u64(),
  attempt: t.u32(),
  worker_id: t.option(t.u64()),
  started_tick: t.option(t.u32()),
  finished_tick: t.option(t.u32()),
  finish_at_tick: t.option(t.u32()),
  required_capabilities: t.array(t.string()),
  steps: t.array(t.string()),
  error_code: t.option(t.string()),
  estimated_slack_ticks: t.option(t.i64()),
  /** Current priority (an external planner may raise it before the task starts). */
  priority: t.u32(),
});
const edgeRow = t.row('UiDagEdgePayload', {
  ...base,
  order_id: t.u64(),
  from_task_id: t.u64(),
  to_task_id: t.u64(),
});
const workerRow = t.row('UiWorkerPayload', {
  ...base,
  label: t.string(),
  role: t.string(),
  enabled: t.bool(),
  status: t.string(),
  capabilities: t.array(t.string()),
  current_task_id: t.option(t.u64()),
  current_attempt: t.option(t.u32()),
  speed_factor: t.f64(),
  x: t.f64(),
  y: t.f64(),
});
const resourceRow = t.row('UiResourcePayload', {
  ...base,
  label: t.string(),
  role: t.string(),
  capacity: t.u32(),
  reserved_units: t.u32(),
  free_units: t.u32(),
  available: t.bool(),
});
const trayRow = t.row('UiTrayPayload', {
  ...base,
  state: t.string(),
  order_id: t.option(t.u64()),
});
const decisionRow = t.row('UiDecisionPayload', {
  ...base,
  sequence: t.u64(),
  tick: t.u32(),
  policy: t.string(),
  task_id: t.u64(),
  worker_id: t.u64(),
  attempt: t.u32(),
  score: t.f64(),
  reason_codes: t.array(t.string()),
  snapshot_version: t.u64(),
});
const eventRow = t.row('UiEventPayload', {
  ...base,
  sequence: t.u64(),
  tick: t.u32(),
  event_type: t.string(),
  detail: t.string(),
  task_id: t.option(t.u64()),
  order_id: t.option(t.u64()),
  worker_id: t.option(t.u64()),
  attempt: t.option(t.u32()),
});
const metricsRow = t.row('UiMetricsPayload', {
  run_id: t.u64(),
  tick: t.u32(),
  orders_received: t.u32(),
  delivered_orders: t.u32(),
  on_time_orders: t.u32(),
  cleaned_orders: t.u32(),
  unfinished_orders: t.u32(),
  late_open_orders: t.u32(),
  latency_sum_ticks: t.u64(),
  latency_count: t.u32(),
  mean_delivery_ticks: t.option(t.f64()),
  completed_value: t.u64(),
  on_time_value: t.u64(),
  completed_tasks: t.u32(),
  ready_tasks: t.u32(),
  busy_workers: t.u32(),
  total_workers: t.u32(),
  active_workers: t.u32(),
  reward: t.f64(),
  penalty: t.f64(),
  net_reward: t.f64(),
  dirty_or_in_use_trays: t.u32(),
  modeled_spent_microusd: t.u64(),
  reserved_microusd: t.u64(),
  modeled_budget_microusd: t.option(t.u64()),
  reported_anthropic_cost_microusd: t.u64(),
  input_tokens: t.u64(),
  output_tokens: t.u64(),
  reported_coordinator_ms: t.f64(),
  coordinator_sample_count: t.u32(),
  assignment_count: t.u32(),
});
const jobRow = t.row('ServiceJobPayload', {
  ...base,
  task_id: t.u64(),
  worker_id: t.u64(),
  attempt: t.u32(),
  status: t.string(),
  mine: t.bool(),
  expected_action: t.string(),
  observation_json: t.string(),
});
const rowBase = (r: { key: string; id: bigint; runId: bigint }) => ({
  key: r.key,
  id: r.id,
  run_id: r.runId,
});
type ChildName = Exclude<keyof State, 'run'>;
function states(
  store: ViewDb,
  hex: string,
  names: readonly ChildName[],
): State[] {
  return readableRuns(store, hex).map((run) => {
    const state = emptyState(run);
    for (const name of names)
      Object.assign(state, { [name]: [...store[name].runId.filter(run.id)] });
    return state;
  });
}
export const ui_runs = db.view(
  { name: 'ui_runs', public: true },
  t.array(runRow),
  (ctx) => {
    const store = ctx.db as unknown as ViewDb;
    const hex = ctx.sender.toHexString();
    return readableRuns(store, hex).map((r) => ({
      id: r.id,
      name: r.name,
      seed: r.seed,
      tick: r.tick,
      status: r.status,
      mode: r.mode,
      arrivals_closed: r.arrivalsClosed,
      version: r.version,
      policy_json: r.policyJson,
      can_control:
        r.ownerIdentityHex === hex ||
        [...store.members.runId.filter(r.id)].some(
          (m) =>
            m.enabled && m.identityHex === hex && m.permission === 'operator',
        ),
    }));
  },
);
export const ui_orders = db.view(
  { name: 'ui_orders', public: true },
  t.array(orderRow),
  (ctx) =>
    states(ctx.db as unknown as ViewDb, ctx.sender.toHexString(), [
      'taskItems',
      'carts',
      'recipes',
      'orders',
      'tasks',
    ]).flatMap((s) => {
      const counts = new Map<bigint, { ready: number; active: number }>();
      for (const task of s.tasks) {
        if (
          !['ready', 'assigned', 'running', 'uncertain'].includes(task.status)
        )
          continue;
        for (const order of taskOrders(s, task)) {
          const count = counts.get(order.id) ?? { ready: 0, active: 0 };
          if (task.status === 'ready') count.ready++;
          else count.active++;
          counts.set(order.id, count);
        }
      }
      const carts = new Map(s.carts.map((c) => [c.id, c]));
      return s.orders.map((o) => {
        return {
          ...rowBase(o),
          cart_key: carts.get(o.cartId)!.externalKey,
          recipe_key: recipeOf(s, o).recipe,
          status: o.status,
          arrival_tick: o.arrivalTick,
          deadline_tick: o.deadlineTick,
          value: o.value,
          priority: o.priority,
          delivered_tick: o.deliveredTick,
          customer_release_tick: o.customerReleaseTick,
          cleanup_completed_tick: o.cleanupCompletedTick,
          tray_id: o.trayId,
          ready_tasks: counts.get(o.id)?.ready ?? 0,
          active_tasks: counts.get(o.id)?.active ?? 0,
          delivery_late: (o.deliveredTick ?? s.run.tick) > o.deadlineTick,
        };
      });
    }),
);
export const ui_tasks = db.view(
  { name: 'ui_tasks', public: true },
  t.array(taskRow),
  (ctx) =>
    states(ctx.db as unknown as ViewDb, ctx.sender.toHexString(), [
      'orders',
      'tasks',
      'dependencies',
      'taskItems',
      'utensils',
      'workers',
      'requirements',
      'resources',
      'reservations',
      'trays',
    ]).flatMap((s) => {
      const tails = new Map<bigint, number>();
      return s.tasks.map((task) => {
        const order = s.orders.find((o) => o.id === task.orderId)!;
        let reason = blockedReason(s, task);
        if (reason === 'eligible') {
          if (
            !s.workers.some(
              (w) =>
                w.enabled &&
                w.currentTaskId === undefined &&
                task.requiredCapabilities.every((k) =>
                  w.capabilities.includes(k),
                ),
            )
          )
            reason = 'no_compatible_idle_worker';
          if (
            s.run.budgetMicrousd !== undefined &&
            s.run.modeledSpentMicrousd +
              s.run.reservedMicrousd +
              task.estimatedCostMicrousd >
              s.run.budgetMicrousd
          )
            reason = 'modeled_budget';
        }
        const resourceBlocked =
          s.requirements
            .filter((r) => r.taskId === task.id)
            .some((r) => freeUnits(s, r.resourceId) < r.units) ||
          (task.trayMode === 'acquire' &&
            order.trayId === undefined &&
            !s.trays.some(
              (t) => t.state === 'clean' && t.orderId === undefined,
            ));
        return {
          ...rowBase(task),
          order_id: task.orderId,
          order_ids: taskOrders(s, task).map((o) => o.id),
          kind: task.kind,
          role: task.role,
          status: task.status,
          block_reason:
            task.status === 'ready' && resourceBlocked
              ? 'resource_or_tray'
              : reason,
          resource_blocked: task.status === 'ready' && resourceBlocked,
          release_tick: task.releaseTick,
          deadline_tick: task.deadlineTick,
          duration_ticks: task.durationTicks,
          estimated_cost_microusd: task.estimatedCostMicrousd,
          attempt: task.attempt,
          worker_id: task.workerId,
          started_tick: task.startedTick,
          finished_tick: task.finishedTick,
          finish_at_tick: task.finishAtTick,
          required_capabilities: task.requiredCapabilities,
          steps: TASK_STEPS[task.kind],
          error_code: task.errorCode,
          estimated_slack_ticks:
            task.deadlineTick === undefined
              ? undefined
              : BigInt(
                  task.deadlineTick -
                    s.run.tick -
                    task.durationTicks -
                    downstreamTail(s, task, undefined, tails),
                ),
          priority: task.priority,
        };
      });
    }),
);
export const ui_dag_edges = db.view(
  { name: 'ui_dag_edges', public: true },
  t.array(edgeRow),
  (ctx) =>
    states(ctx.db as unknown as ViewDb, ctx.sender.toHexString(), [
      'dependencies',
    ]).flatMap((s) =>
      s.dependencies.map((d) => ({
        ...rowBase(d),
        order_id: d.orderId,
        from_task_id: d.predecessorId,
        to_task_id: d.successorId,
      })),
    ),
);
export const ui_workers = db.view(
  { name: 'ui_workers', public: true },
  t.array(workerRow),
  (ctx) =>
    states(ctx.db as unknown as ViewDb, ctx.sender.toHexString(), [
      'workers',
    ]).flatMap((s) =>
      s.workers.map((w) => ({
        ...rowBase(w),
        label: w.label,
        role: w.role,
        enabled: w.enabled,
        status:
          w.currentTaskId !== undefined
            ? 'busy'
            : w.enabled
              ? 'idle'
              : 'disabled',
        capabilities: w.capabilities,
        current_task_id: w.currentTaskId,
        current_attempt: w.currentAttempt,
        speed_factor: w.speedFactor,
        x: w.x,
        y: w.y,
      })),
    ),
);
export const ui_resources = db.view(
  { name: 'ui_resources', public: true },
  t.array(resourceRow),
  (ctx) =>
    states(ctx.db as unknown as ViewDb, ctx.sender.toHexString(), [
      'resources',
      'reservations',
    ]).flatMap((s) =>
      s.resources.map((r) => ({
        ...rowBase(r),
        label: r.label,
        role: r.role,
        capacity: r.capacity,
        reserved_units: s.reservations
          .filter((x) => x.resourceId === r.id)
          .reduce((n, x) => n + x.units, 0),
        free_units: freeUnits(s, r.id),
        available: r.available,
      })),
    ),
);
export const ui_trays = db.view(
  { name: 'ui_trays', public: true },
  t.array(trayRow),
  (ctx) =>
    states(ctx.db as unknown as ViewDb, ctx.sender.toHexString(), [
      'trays',
    ]).flatMap((s) =>
      s.trays.map((tr) => ({
        ...rowBase(tr),
        state: tr.state,
        order_id: tr.orderId,
      })),
    ),
);
export const ui_decisions = db.view(
  { name: 'ui_decisions', public: true },
  t.array(decisionRow),
  (ctx) =>
    states(ctx.db as unknown as ViewDb, ctx.sender.toHexString(), [
      'decisions',
    ]).flatMap((s) =>
      s.decisions
        .slice()
        .sort((a, b) => (a.sequence > b.sequence ? -1 : 1))
        .slice(0, 200)
        .map((d) => ({
          ...rowBase(d),
          sequence: d.sequence,
          tick: d.tick,
          policy: d.policy,
          task_id: d.taskId,
          worker_id: d.workerId,
          attempt: d.attempt,
          score: d.score,
          reason_codes: d.reasonCodes,
          snapshot_version: d.snapshotVersion,
        })),
    ),
);
export const ui_events = db.view(
  { name: 'ui_events', public: true },
  t.array(eventRow),
  (ctx) =>
    states(ctx.db as unknown as ViewDb, ctx.sender.toHexString(), [
      'events',
    ]).flatMap((s) =>
      s.events
        .slice()
        .sort((a, b) => (a.sequence > b.sequence ? -1 : 1))
        .slice(0, 400)
        .map((e) => ({
          ...rowBase(e),
          sequence: e.sequence,
          tick: e.tick,
          event_type: e.type,
          detail: e.detail,
          task_id: e.taskId,
          order_id: e.orderId,
          worker_id: e.workerId,
          attempt: e.attempt,
        })),
    ),
);
export const ui_metrics = db.view(
  { name: 'ui_metrics', public: true },
  t.array(metricsRow),
  (ctx) =>
    states(ctx.db as unknown as ViewDb, ctx.sender.toHexString(), [
      'orders',
      'tasks',
      'workers',
      'trays',
      'telemetry',
      'carts',
      'jobs',
      'events',
      'decisions',
    ]).map((s) => {
      const delivered = s.orders.filter((o) => o.deliveredTick !== undefined);
      const ontime = delivered.filter(
        (o) => o.deliveredTick! <= o.deadlineTick,
      );
      const latency = delivered.reduce(
        (n, o) => n + BigInt(o.deliveredTick! - o.arrivalTick),
        0n,
      );
      const llm = s.telemetry.filter((t) => t.source === 'anthropic');
      const coordination = s.telemetry.filter(
        (t) => t.source === 'coordinator',
      );
      // The score counts reported coordination (planning) time as delta * C_coord.
      const score = evaluateRun(
        s,
        s.run.tick,
        undefined,
        coordination.reduce((n, t) => n + t.wallMilliseconds, 0),
      );
      return {
        run_id: s.run.id,
        tick: s.run.tick,
        orders_received: s.orders.length,
        delivered_orders: delivered.length,
        on_time_orders: ontime.length,
        cleaned_orders: s.orders.filter((o) => o.status === 'cleaned').length,
        unfinished_orders: s.orders.length - delivered.length,
        late_open_orders: s.orders.filter(
          (o) => o.deliveredTick === undefined && s.run.tick > o.deadlineTick,
        ).length,
        latency_sum_ticks: latency,
        latency_count: delivered.length,
        mean_delivery_ticks: delivered.length
          ? Number(latency) / delivered.length
          : undefined,
        completed_value: delivered.reduce((n, o) => n + BigInt(o.value), 0n),
        on_time_value: ontime.reduce((n, o) => n + BigInt(o.value), 0n),
        completed_tasks: s.tasks.filter((t) => t.status === 'succeeded').length,
        ready_tasks: s.tasks.filter((t) => t.status === 'ready').length,
        busy_workers: s.workers.filter((w) => w.currentTaskId !== undefined)
          .length,
        total_workers: s.workers.length,
        active_workers: s.workers.filter((w) => w.enabled).length,
        reward: score.reward,
        penalty: score.penalty,
        net_reward: score.netReward,
        dirty_or_in_use_trays: s.trays.filter((t) => t.state !== 'clean')
          .length,
        modeled_spent_microusd: s.run.modeledSpentMicrousd,
        reserved_microusd: s.run.reservedMicrousd,
        modeled_budget_microusd: s.run.budgetMicrousd,
        reported_anthropic_cost_microusd: llm.reduce(
          (n, t) => n + t.reportedCostMicrousd,
          0n,
        ),
        input_tokens: llm.reduce((n, t) => n + t.inputTokens, 0n),
        output_tokens: llm.reduce((n, t) => n + t.outputTokens, 0n),
        reported_coordinator_ms: coordination.reduce(
          (n, t) => n + t.wallMilliseconds,
          0,
        ),
        coordinator_sample_count: coordination.length,
        assignment_count: s.decisions.length,
      };
    }),
);
export const service_jobs = db.view(
  { name: 'service_jobs', public: true },
  t.array(jobRow),
  (ctx) => {
    const store = ctx.db as unknown as ViewDb;
    const hex = ctx.sender.toHexString();
    return serviceRuns(store, hex).flatMap((r) =>
      [...store.jobs.runId.filter(r.id)]
        .filter((j) => j.status === 'pending' || j.claimantIdentityHex === hex)
        .map((j) => ({
          ...rowBase(j),
          task_id: j.taskId,
          worker_id: j.workerId,
          attempt: j.attempt,
          status: j.status,
          mine: j.claimantIdentityHex === hex,
          expected_action: j.expectedAction,
          observation_json: j.observationJson,
        })),
    );
  },
);
const policyRow = t.row('UiPolicyPayload', {
  name: t.string(),
  label: t.string(),
  description: t.string(),
  baseline: t.bool(),
  lookahead: t.bool(),
  default_config_json: t.string(),
});
// Static metadata is caller-independent and safe to share anonymously.
export const ui_policy_catalog = db.anonymousView(
  { name: 'ui_policy_catalog', public: true },
  t.array(policyRow),
  () =>
    [
      {
        name: 'primal_dual',
        label: 'SYNC primal-dual',
        description:
          'Event-triggered rolling frontier with dynamic capacity prices and exact admission.',
        baseline: false,
      },
      {
        name: 'fcfs',
        label: 'FCFS',
        description: 'Oldest feasible ready task first.',
        baseline: true,
      },
      {
        name: 'earliest_finish',
        label: 'Earliest finish',
        description:
          'Lowest estimated duration among immediately feasible task-worker pairs.',
        baseline: true,
      },
      {
        name: 'minimum_slack',
        label: 'Minimum slack',
        description:
          'Smallest delivery slack, including known downstream tail.',
        baseline: true,
      },
      {
        name: 'critical_path',
        label: 'Critical path',
        description: 'Largest estimated remaining dependency path first.',
        baseline: true,
      },
      {
        name: 'sync_greedy',
        label: 'SYNC greedy',
        description:
          'Weighted urgency, criticality, age, priority, value, duration and modeled cost.',
        baseline: false,
      },
      {
        name: 'bounded_joint',
        label: 'SYNC joint',
        description:
          'Bounded search over feasible immediate assignment sets, with greedy incumbent.',
        baseline: false,
      },
    ].map((p) => ({
      ...p,
      lookahead: p.name === 'primal_dual',
      default_config_json: JSON.stringify({
        ...DEFAULT_POLICY_CONFIG,
        policy: p.name,
      }),
    })),
);

const plannerRow = t.row('UiPlannerPayload', {
  ...base,
  last_plan_tick: t.u32(),
  next_wake_tick: t.u32(),
  replan_count: t.u64(),
  snapshot_version: t.u64(),
  trigger: t.string(),
  objective: t.f64(),
  candidate_count: t.u32(),
  candidate_limit_reached: t.bool(),
  prices_json: t.string(),
  plan_json: t.string(),
});
export const ui_planner = db.view(
  { name: 'ui_planner', public: true },
  t.array(plannerRow),
  (ctx) => {
    const store = ctx.db as unknown as ViewDb;
    return readableRuns(store, ctx.sender.toHexString()).flatMap((run) =>
      [...store.planner.runId.filter(run.id)].map((p) => ({
        ...rowBase(p),
        last_plan_tick: p.lastPlanTick,
        next_wake_tick: p.nextWakeTick,
        replan_count: p.replanCount,
        snapshot_version: p.snapshotVersion,
        trigger: p.trigger,
        objective: p.objective,
        candidate_count: p.candidateCount,
        candidate_limit_reached: p.candidateLimitReached,
        prices_json: p.pricesJson,
        plan_json: p.planJson,
      })),
    );
  },
);
const serviceWorkerRow = t.row('ServiceWorkerPayload', {
  ...base,
  label: t.string(),
  role: t.string(),
  enabled: t.bool(),
  run_status: t.string(),
  mode: t.string(),
  current_task_id: t.option(t.u64()),
});
export const service_workers = db.view(
  { name: 'service_workers', public: true },
  t.array(serviceWorkerRow),
  (ctx) => {
    const store = ctx.db as unknown as ViewDb;
    return serviceRuns(store, ctx.sender.toHexString()).flatMap((run) =>
      [...store.workers.runId.filter(run.id)].map((w) => ({
        ...rowBase(w),
        label: w.label,
        role: w.role,
        enabled: w.enabled,
        run_status: run.status,
        mode: run.mode,
        current_task_id: w.currentTaskId,
      })),
    );
  },
);
