/** Optional host instrumentation. Reducers never install a probe or read wall time.
 * Benchmark hosts can measure the exact planner call for every policy. */
export type PlanningProbe = <T>(compute: () => T) => T;
let probe: PlanningProbe = (compute) => compute();
export function installPlanningProbe(next: PlanningProbe): void {
  probe = next;
}
export function measurePlanning<T>(compute: () => T): T {
  return probe(compute);
}
