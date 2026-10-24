import type { State } from './model.ts';
import { nextBase } from './model.ts';
import type { Assignment } from '../policies/scheduler.ts';

// Fixed deterministic work bounds; these are algorithm parameters, not wall time.
export const ROLLING_CONFIG = Object.freeze({
  horizon: 24,
  iterations: 16,
  maxCandidates: 4096,
  refreshTicks: 8,
  step: 2,
  maxPrice: 100,
});
export interface Forecast extends Assignment {
  startTick: number;
  finishTick: number;
}
type Candidate = Forecast & { demand: Map<string, bigint>; utility: number };
const encode = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
// Ratios are used only for scoring. Feasibility and budget arithmetic stay exact.
const ratio = (a: bigint, b: bigint): number =>
  Number((a * 1000000n) / (b > 0n ? b : 1n)) / 1000000;

export function planningFingerprint(s: State): string {
  return encode([
    s.run.policyJson,
    s.run.status,
    s.run.budgetMicrousd,
    s.run.modeledSpentMicrousd,
    s.run.reservedMicrousd,
    s.tasks,
    s.workers,
    s.resources,
    s.requirements,
    s.dependencies,
    s.trays,
    s.orders,
  ]);
}

/** Online projected-subgradient pricing plus an exact feasible primal repair.
 * Future rows are advisory. The engine never releases actual reservations.
 */
export class RollingHorizonEngine {
  plan(s: State): Forecast[] | undefined {
    const previous = s.planner[0];
    const fingerprint = planningFingerprint(s);
    if (
      previous &&
      previous.fingerprint === fingerprint &&
      s.run.tick < previous.nextWakeTick
    )
      return undefined;
    const trigger = !previous
      ? 'initial'
      : previous.fingerprint !== fingerprint
        ? 'state_changed'
        : 'horizon_wakeup';
    const now = s.run.tick;
    const end = now + ROLLING_CONFIG.horizon;
    const capacity = new Map<string, bigint>();
    const release = (taskId: bigint): number => {
      const task = s.tasks.find((t) => t.id === taskId);
      // Assigned, uncertain, and overdue work retains capacity throughout the horizon.
      return task?.status === 'running' &&
        task.finishAtTick !== undefined &&
        task.finishAtTick > now
        ? task.finishAtTick
        : end;
    };
    for (let tick = now; tick < end; tick++) {
      for (const w of s.workers)
        capacity.set(
          `worker:${w.id}:${tick}`,
          w.enabled &&
            (w.currentTaskId === undefined || release(w.currentTaskId) <= tick)
            ? 1n
            : 0n,
        );
      for (const r of s.resources) {
        const held = s.reservations
          .filter((x) => x.resourceId === r.id && release(x.taskId) > tick)
          .reduce((a, x) => a + x.units, 0);
        capacity.set(
          `resource:${r.id}:${tick}`,
          BigInt(r.available ? Math.max(0, r.capacity - held) : 0),
        );
      }
    }
    const trays = s.trays
      .filter((t) => t.state === 'clean' && t.orderId === undefined)
      .map((t) => t.id);
    capacity.set('trays', BigInt(trays.length));
    if (s.run.budgetMicrousd !== undefined)
      capacity.set(
        'budget',
        s.run.budgetMicrousd -
          s.run.modeledSpentMicrousd -
          s.run.reservedMicrousd,
      );
    const candidates: Candidate[] = [];
    const tasks = s.tasks
      .filter((t) => t.status === 'ready')
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    // Start-time outer loop ensures the bounded candidate prefix includes due-now choices first.
    outer: for (let start = now; start < end; start++)
      for (const task of tasks)
        for (const worker of s.workers) {
          if (
            !worker.enabled ||
            !task.requiredCapabilities.every((c) =>
              worker.capabilities.includes(c),
            )
          )
            continue;
          const durationTicks = Math.max(
            1,
            Math.ceil(task.durationTicks / worker.speedFactor),
          );
          const finish = start + durationTicks;
          const demand = new Map<string, bigint>();
          const add = (key: string, units: bigint) =>
            demand.set(key, (demand.get(key) ?? 0n) + units);
          // Long work occupies all remaining slots; its true finish is retained in the forecast.
          for (let tick = start; tick < Math.min(end, finish); tick++) {
            add(`worker:${worker.id}:${tick}`, 1n);
            for (const req of s.requirements.filter(
              (r) => r.taskId === task.id,
            ))
              add(`resource:${req.resourceId}:${tick}`, BigInt(req.units));
          }
          if (capacity.has('budget')) add('budget', task.estimatedCostMicrousd);
          if (
            task.trayMode === 'acquire' &&
            s.orders.find((o) => o.id === task.orderId)?.trayId === undefined
          )
            add('trays', 1n);
          if ([...demand].some(([k, v]) => v > (capacity.get(k) ?? 0n)))
            continue;
          const age = Math.min(300, Math.max(0, now - task.releaseTick));
          const late =
            task.deadlineTick === undefined
              ? 0
              : Math.max(0, finish - task.deadlineTick);
          const utility =
            1 +
            task.value +
            task.priority +
            age * 0.05 +
            Math.min(30, late) * 0.1;
          candidates.push({
            taskId: task.id,
            workerId: worker.id,
            durationTicks,
            costMicrousd: task.estimatedCostMicrousd,
            startTick: start,
            finishTick: finish,
            score: utility,
            reasonCodes: ['primal_dual', 'exact_capacity_repair'],
            demand,
            utility: utility / (1 + 0.05 * (start - now)),
          });
          if (candidates.length >= ROLLING_CONFIG.maxCandidates) break outer;
        }
    const oldPrices = previous
      ? (JSON.parse(previous.pricesJson) as Record<string, number>)
      : {};
    const prices = new Map(
      [...capacity.keys()].map((k) => [k, oldPrices[k] ?? 0]),
    );
    const bid = (c: Candidate): number =>
      c.utility -
      [...c.demand].reduce(
        (v, [k, n]) =>
          v + (prices.get(k) ?? 0) * ratio(n, capacity.get(k) ?? 1n),
        0,
      );
    const repair = (priced: boolean): Candidate[] => {
      const remaining = new Map(capacity);
      const used = new Set<bigint>();
      const selected: Candidate[] = [];
      const ordered = candidates
        .map((c, i) => ({ c, i, score: priced ? bid(c) : c.utility }))
        .sort((a, b) => b.score - a.score || a.i - b.i);
      for (const { c, score } of ordered) {
        if (
          score <= 0 ||
          used.has(c.taskId) ||
          [...c.demand].some(([k, n]) => n > (remaining.get(k) ?? 0n))
        )
          continue;
        used.add(c.taskId);
        selected.push(c);
        for (const [k, n] of c.demand) remaining.set(k, remaining.get(k)! - n);
      }
      return selected;
    };
    const objective = (rows: Candidate[]) =>
      rows.reduce((v, c) => v + c.utility, 0);
    let best = repair(false);
    for (
      let iteration = 0;
      iteration < ROLLING_CONFIG.iterations;
      iteration++
    ) {
      const repaired = repair(true);
      if (objective(repaired) > objective(best)) best = repaired;
      const relaxed = new Map<bigint, Candidate>();
      for (const c of candidates)
        if (
          bid(c) > 0 &&
          (!relaxed.has(c.taskId) || bid(c) > bid(relaxed.get(c.taskId)!))
        )
          relaxed.set(c.taskId, c);
      const load = new Map<string, bigint>();
      for (const c of relaxed.values())
        for (const [k, n] of c.demand) load.set(k, (load.get(k) ?? 0n) + n);
      for (const [k, cap] of capacity)
        prices.set(
          k,
          Math.max(
            0,
            Math.min(
              ROLLING_CONFIG.maxPrice,
              prices.get(k)! +
                (ROLLING_CONFIG.step / Math.sqrt(iteration + 1)) *
                  ratio((load.get(k) ?? 0n) - cap, cap),
            ),
          ),
        );
    }
    let trayIndex = 0;
    const forecast: Forecast[] = best
      .sort(
        (a, b) => a.startTick - b.startTick || (a.taskId < b.taskId ? -1 : 1),
      )
      .map((c) => ({
        taskId: c.taskId,
        workerId: c.workerId,
        durationTicks: c.durationTicks,
        costMicrousd: c.costMicrousd,
        startTick: c.startTick,
        finishTick: c.finishTick,
        score: c.utility,
        reasonCodes: c.reasonCodes,
        ...(c.demand.has('trays') ? { trayId: trays[trayIndex++] } : {}),
      }));
    const nextWakeTick = Math.min(
      now + ROLLING_CONFIG.refreshTicks,
      ...forecast.filter((c) => c.startTick > now).map((c) => c.startTick),
    );
    const row = {
      ...(previous ?? nextBase(s)),
      fingerprint,
      lastPlanTick: now,
      nextWakeTick,
      replanCount: (previous?.replanCount ?? 0n) + 1n,
      snapshotVersion: s.run.version,
      trigger,
      objective: objective(best),
      candidateCount: candidates.length,
      candidateLimitReached: candidates.length === ROLLING_CONFIG.maxCandidates,
      pricesJson: encode(Object.fromEntries(prices)),
      planJson: encode(forecast),
    };
    s.planner = [row];
    return forecast;
  }
}
