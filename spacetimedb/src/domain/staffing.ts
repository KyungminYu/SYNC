import type { State } from './model.ts';
import { readPolicy } from './model.ts';
import {
  DEFAULT_POLICY_CONFIG,
  STAFFED_ROLES,
  type StaffedRole,
} from '../policies/scheduler.ts';
import { emit } from './engine.ts';
/**
 * Staffing for this tick: an external target when the policy sets one,
 * otherwise the adaptive rule when it is on. Busy and uncertain workers
 * drain safely (a worker being dropped finishes the task in hand).
 */
export function applyStaffing(s: State): void {
  const config = readPolicy(s);
  if (config.staffTarget) return staffTo(s, config.staffTarget);
  if (config.adaptiveStaffing)
    adaptStaffing(
      s,
      config.staffingThreshold ?? DEFAULT_POLICY_CONFIG.staffingThreshold,
    );
}
/** Second worker of each role on when its upcoming work reaches `threshold`. */
export function adaptStaffing(s: State, threshold: number): void {
  const wanted: Partial<Record<StaffedRole, 1 | 2>> = {};
  for (const role of STAFFED_ROLES) {
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
    wanted[role] = upcoming.length >= threshold ? 2 : 1;
  }
  staffTo(s, wanted);
}
/** Switches each role's second worker on or (once idle) off. */
function staffTo(s: State, target: Partial<Record<StaffedRole, 1 | 2>>): void {
  for (const role of STAFFED_ROLES) {
    const second = s.workers
      .filter((w) => w.role === role)
      .sort((a, b) => (a.id < b.id ? -1 : 1))[1];
    if (!second) continue;
    const want = (target[role] ?? 1) === 2;
    if (want && !second.enabled) {
      second.enabled = true;
      emit(s, 'worker_activated', role, { workerId: second.id });
    }
    if (!want && second.enabled && second.currentTaskId === undefined) {
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
