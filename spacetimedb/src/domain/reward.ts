import type { State } from './model.ts';
export const REWARD_WEIGHTS = Object.freeze({
  latePerTick: 0.02,
  waitPerTick: 0.001,
  executionPerDollar: 1,
  cancelledAttempt: 0.1,
  // Staff time, the same for every worker on shift. Pay scale: a run (180
  // ticks) is one hour of rush, one completed order is a $4.20 drink, and a
  // part-time worker earns $15.00/h (BLS May 2025 median, fast food and
  // counter workers): 15 / 180 / 4.2 ≈ 0.02 per tick.
  activeWorkerTick: 0.02,
  // Manager (the LLM planner), paid only while it talks: reported planning
  // time at $33.36/h (BLS May 2025 median, food service managers), 2.22× a
  // worker, i.e. 0.044 per second (1 tick = 1 s of wall time).
  planningPerMs: 0.000044,
});
/** Terminal cart value only. Intermediate preparation never earns completed reward. */
export function evaluateRun(
  s: State,
  horizon: number,
  activeWorkerTicks?: number,
  planningMs = 0,
) {
  if (activeWorkerTicks === undefined) {
    activeWorkerTicks = 0;
    for (const worker of s.workers) {
      let active = / 1$/.test(worker.label),
        last = 0;
      for (const event of s.events
        .filter(
          (e) =>
            e.workerId === worker.id &&
            ['worker_activated', 'worker_deactivated'].includes(e.type) &&
            e.tick <= horizon,
        )
        .sort((a, b) => a.tick - b.tick)) {
        if (active) activeWorkerTicks += event.tick - last;
        active = event.type === 'worker_activated';
        last = event.tick;
      }
      if (active)
        activeWorkerTicks += Math.max(0, Math.min(horizon, s.run.tick) - last);
    }
  }
  let reward = 0,
    lateTicks = 0,
    waitTicks = 0,
    completedCarts = 0;
  for (const cart of s.carts) {
    const orders = s.orders.filter((o) => o.cartId === cart.id);
    if (!orders.length) continue;
    const finish = orders.every((o) => o.deliveredTick !== undefined)
      ? Math.max(...orders.map((o) => o.deliveredTick!))
      : Infinity;
    if (finish <= horizon) {
      reward += orders.reduce((n, o) => n + o.value, 0);
      completedCarts++;
    }
    const end = Math.min(finish, horizon);
    waitTicks += Math.max(0, end - cart.arrivalTick);
    lateTicks += Math.max(
      0,
      end - Math.min(...orders.map((o) => o.deadlineTick)),
    );
  }
  const cancelled = s.jobs.filter(
    (j) =>
      j.status === 'cancelled' &&
      j.submittedTick !== undefined &&
      s.events.some(
        (e) =>
          e.type === 'agent_result' &&
          e.detail === 'stopped' &&
          e.taskId === j.taskId &&
          e.attempt === j.attempt &&
          e.tick <= horizon,
      ),
  );
  const cancelledAttempts = cancelled.length;
  const completed = s.jobs.filter((j) =>
    s.tasks.some(
      (t) =>
        t.id === j.taskId &&
        t.attempt === j.attempt &&
        t.status === 'succeeded' &&
        t.finishedTick !== undefined &&
        t.finishedTick <= horizon,
    ),
  );
  const executionDollars =
    Number(
      [...completed, ...cancelled].reduce(
        (n, j) => n + j.reservedCostMicrousd,
        0n,
      ),
    ) / 1000000;
  const penalty =
    lateTicks * REWARD_WEIGHTS.latePerTick +
    waitTicks * REWARD_WEIGHTS.waitPerTick +
    executionDollars * REWARD_WEIGHTS.executionPerDollar +
    cancelledAttempts * REWARD_WEIGHTS.cancelledAttempt +
    activeWorkerTicks * REWARD_WEIGHTS.activeWorkerTick +
    planningMs * REWARD_WEIGHTS.planningPerMs;
  return {
    reward,
    penalty,
    netReward: reward - penalty,
    completedCarts,
    lateTicks,
    waitTicks,
    executionDollars,
    cancelledAttempts,
    activeWorkerTicks,
    planningMs,
  };
}
