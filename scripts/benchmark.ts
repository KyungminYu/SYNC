import { demoFixture } from '../packages/test-fixtures/src';
import {
  plan,
  validateProposal,
  eligible,
  isDue,
  completionDisposition,
} from '../packages/sync-core/src';
for (const policy of ['fcfs', 'resource-aware'] as const) {
  const s = demoFixture(42);
  let schedulerMs = 0,
    deadlineMisses = 0;
  while (s.tasks.some((t) => t.state !== 'succeeded') && s.tick < 1000) {
    for (const t of s.tasks)
      if (
        isDue(t, s.tick) &&
        completionDisposition(t, t.attempt) === 'complete'
      ) {
        t.state = 'succeeded';
        s.reservations = s.reservations.filter(
          (r) => r.taskId !== t.id || r.attempt !== t.attempt,
        );
        for (const w of s.workers) if (w.taskId === t.id) w.taskId = undefined;
        if (t.deadline !== undefined && s.tick > t.deadline) deadlineMisses++;
      }
    for (const t of s.tasks)
      if (t.state === 'blocked' && eligible(t, s)) t.state = 'ready';
    const before = performance.now(),
      proposal = plan(s, { policy });
    schedulerMs += performance.now() - before;
    validateProposal(s, proposal);
    for (const a of proposal.assignments) {
      const t = s.tasks.find((t) => t.id === a.taskId)!,
        w = s.workers.find((w) => w.id === a.workerId)!;
      t.attempt++;
      t.state = 'running';
      t.startedAt = s.tick;
      w.taskId = t.id;
      for (const r of t.requirements)
        s.reservations.push({ ...r, taskId: t.id, attempt: t.attempt });
    }
    if (s.tasks.every((t) => t.state === 'succeeded')) break;
    s.tick++;
  }
  console.log(
    JSON.stringify({
      fixture: true,
      policy,
      seed: 42,
      completed: s.tasks.filter((t) => t.state === 'succeeded').length,
      logicalCompletionTicks: s.tick,
      deadlineMisses,
      schedulerMs,
    }),
  );
}
