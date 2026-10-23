export * from './types';
import type {
  Assignment,
  Policy,
  ScheduleProposal,
  Snapshot,
  Task,
} from './types';
const compareId = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
export function eligible(task: Task, snapshot: Snapshot): boolean {
  return (
    task.release <= snapshot.tick &&
    task.dependencies.every((id) =>
      snapshot.tasks.some((t) => t.id === id && t.state === 'succeeded'),
    )
  );
}
export function plan(
  snapshot: Snapshot,
  configuration: { policy: Policy },
): ScheduleProposal {
  const score = (t: Task) =>
    (t.deadline === undefined
      ? 0
      : 100 / Math.max(1, t.deadline - snapshot.tick - t.duration)) +
    (snapshot.tick - t.release) * 2 -
    t.duration;
  const tasks = snapshot.tasks
    .filter((t) => t.state === 'ready' && eligible(t, snapshot))
    .sort(
      (a, b) =>
        (configuration.policy === 'fcfs'
          ? a.release - b.release
          : score(b) - score(a)) || compareId(a.id, b.id),
    );
  const workers = snapshot.workers
    .filter((w) => w.taskId === undefined)
    .sort((a, b) => compareId(a.id, b.id));
  const available = new Map(
    snapshot.resources.map((r) => [
      r.id,
      r.capacity -
        snapshot.reservations
          .filter((x) => x.resourceId === r.id)
          .reduce((n, x) => n + x.units, 0),
    ]),
  );
  const assignments: Assignment[] = [];
  for (const task of tasks) {
    const index = workers.findIndex((w) =>
      task.capabilities.every((c) => w.capabilities.includes(c)),
    );
    if (
      index < 0 ||
      task.requirements.some(
        (r) => (available.get(r.resourceId) ?? 0) < r.units,
      )
    )
      continue;
    const [worker] = workers.splice(index, 1);
    for (const r of task.requirements)
      available.set(r.resourceId, available.get(r.resourceId)! - r.units);
    assignments.push({
      taskId: task.id,
      workerId: worker.id,
      reason:
        configuration.policy === 'fcfs'
          ? 'FCFS_FEASIBLE'
          : 'URGENCY_AGE_DURATION',
    });
  }
  return { assignments };
}
export function validateProposal(s: Snapshot, p: ScheduleProposal): void {
  const tasks = new Set<bigint>(),
    workers = new Set<bigint>();
  const usage = new Map(
    s.resources.map((r) => [
      r.id,
      s.reservations
        .filter((x) => x.resourceId === r.id)
        .reduce((n, x) => n + x.units, 0),
    ]),
  );
  for (const a of p.assignments) {
    const t = s.tasks.find((t) => t.id === a.taskId),
      w = s.workers.find((w) => w.id === a.workerId);
    if (
      !t ||
      !w ||
      t.state !== 'ready' ||
      !eligible(t, s) ||
      w.taskId !== undefined ||
      tasks.has(t.id) ||
      workers.has(w.id) ||
      !t.capabilities.every((c) => w.capabilities.includes(c))
    )
      throw new Error('Invalid assignment');
    tasks.add(t.id);
    workers.add(w.id);
    for (const r of t.requirements) {
      const capacity = s.resources.find((x) => x.id === r.resourceId)?.capacity;
      const n = (usage.get(r.resourceId) ?? 0) + r.units;
      if (
        !Number.isInteger(r.units) ||
        r.units <= 0 ||
        capacity === undefined ||
        n > capacity
      )
        throw new Error('Resource capacity exceeded');
      usage.set(r.resourceId, n);
    }
  }
}
/** Pure authoritative timing rule, also used by the benchmark. */
export function isDue(task: Task, tick: number) {
  return (
    task.state === 'running' &&
    task.startedAt !== undefined &&
    tick - task.startedAt >= task.duration
  );
}
export function completionDisposition(
  task: Task,
  attempt: number,
): 'complete' | 'duplicate' {
  if (task.attempt !== attempt) throw new Error('Stale attempt');
  if (task.state === 'succeeded') return 'duplicate';
  if (task.state !== 'running') throw new Error('Task is not running');
  return 'complete';
}
