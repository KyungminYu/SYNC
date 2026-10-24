import type { State } from './model.ts';
import { readPolicy } from './model.ts';
import { emit } from './engine.ts';
/** Staffing is separate from station capacity. Busy and uncertain workers drain safely. */
export function adaptStaffing(s: State): void {
  for (const role of ['cashier', 'barista', 'server'] as const) {
    const slots = s.workers
      .filter((w) => w.role === role)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const pending = s.tasks.filter(
      (t) => t.role === role && ['ready', 'blocked'].includes(t.status),
    );
    const upcoming = pending.filter((t) =>
      s.dependencies
        .filter((d) => d.successorId === t.id)
        .every((d) => {
          const p = s.tasks.find((x) => x.id === d.predecessorId)!;
          return (
            p.status === 'succeeded' ||
            (p.status === 'running' &&
              (p.finishAtTick ?? Infinity) <= s.run.tick + 8) ||
            p.status === 'ready'
          );
        }),
    );
    const second = slots[1];
    if (!second) continue;
    // γ (execution cost weight) raises the queue needed to add a second worker.
    const threshold = 2 + Math.round(2 * (readPolicy(s).executionWeight ?? 0));
    const wanted = upcoming.length >= threshold;
    if (wanted && !second.enabled) {
      second.enabled = true;
      emit(s, 'worker_activated', role, { workerId: second.id });
    }
    if (!wanted && second.enabled && second.currentTaskId === undefined) {
      second.enabled = false;
      emit(s, 'worker_deactivated', role, { workerId: second.id });
    }
  }
}
/** Backpressure stops excess checkout while specialist work is already queued. */
export function admissionBackpressure(s: State, taskId: bigint): boolean {
  const task = s.tasks.find((t) => t.id === taskId)!;
  if (task.kind !== 'capture_order' && task.kind !== 'take_payment')
    return false;
  const brewing = s.tasks.filter(
    (t) =>
      t.role === 'barista' &&
      ['ready', 'running', 'assigned', 'uncertain'].includes(t.status),
  );
  return brewing.length >= 6;
}
