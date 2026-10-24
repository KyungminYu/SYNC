import { requireControl, requireService } from './access.ts';
import { emit, finishTask, refreshReady, schedule } from './engine.ts';
import type { Job, Principal, State } from './model.ts';

/** Cancellation is a handshake. A request alone never revokes physical ownership. */
export function requestCancellation(
  s: State,
  actor: Principal,
  jobId: bigint,
): void {
  requireControl(s, actor);
  if (s.run.mode !== 'claude') throw new Error('EXTERNAL_RUN_REQUIRED');
  const job = s.jobs.find((j) => j.id === jobId);
  if (!job) throw new Error('JOB_NOT_FOUND');
  if (job.status === 'cancel_requested' || job.status === 'cancelled') return;
  if (!['pending', 'claimed', 'accepted'].includes(job.status))
    throw new Error('JOB_NOT_CANCELLABLE');
  // Pending jobs have never been handed to a process and can be safely withdrawn.
  if (job.status === 'pending') releaseStopped(s, job);
  else job.status = 'cancel_requested';
  emit(
    s,
    'cancellation_requested',
    'Capacity held until stopped acknowledgement.',
    { taskId: job.taskId, attempt: job.attempt },
  );
  s.run.version++;
}

function releaseStopped(s: State, job: Job): void {
  const task = s.tasks.find((t) => t.id === job.taskId)!;
  const worker = s.workers.find((w) => w.id === job.workerId)!;
  if (
    task.attempt !== job.attempt ||
    worker.currentTaskId !== task.id ||
    worker.currentAttempt !== job.attempt
  )
    throw new Error('STALE_ATTEMPT');
  // A stopped acknowledgement certifies no committed effect and reusable physical inputs.
  const pitcher = s.utensils.find((u) => u.taskId === task.id);
  if (task.kind === 'prepare_milk' && pitcher) {
    pitcher.state = 'clean';
    pitcher.taskId = undefined;
  }
  if (task.kind === 'wash_pitcher') {
    const pred = s.dependencies.find((d) => d.successorId === task.id);
    const held = s.utensils.find((u) => u.taskId === pred?.predecessorId);
    if (held) held.state = 'dirty';
  }
  if (task.kind === 'clean_tray') {
    const order = s.orders.find((o) => o.id === task.orderId)!;
    const tray = s.trays.find((t) => t.id === order.trayId);
    if (tray) tray.state = 'dirty';
  }
  s.reservations = s.reservations.filter(
    (r) => r.taskId !== task.id || r.attempt !== job.attempt,
  );
  s.run.reservedMicrousd -= job.reservedCostMicrousd;
  // Conservatively charge the entire attempt if execution began; cancelled work is not free.
  if (job.submittedTick !== undefined)
    s.run.modeledSpentMicrousd += job.reservedCostMicrousd;
  job.status = 'cancelled';
  worker.currentTaskId = undefined;
  worker.currentAttempt = undefined;
  task.status = 'blocked';
  task.workerId = undefined;
  task.startedTick = undefined;
  task.finishAtTick = undefined;
  refreshReady(s);
}

export function reportJobResult(
  s: State,
  actor: Principal,
  jobId: bigint,
  attempt: number,
  outcome: string,
): void {
  requireService(s, actor);
  if (s.run.mode !== 'claude') throw new Error('EXTERNAL_RUN_REQUIRED');
  const job = s.jobs.find((j) => j.id === jobId);
  if (
    !job ||
    job.claimantIdentityHex !== actor.identityHex ||
    job.attempt !== attempt
  )
    throw new Error('INVALID_JOB_OWNER_OR_ATTEMPT');
  if (
    (job.status === 'succeeded' && outcome === 'completed') ||
    (job.status === 'cancelled' && outcome === 'stopped') ||
    (job.status === 'uncertain' && outcome === 'uncertain')
  )
    return;
  const task = s.tasks.find((t) => t.id === job.taskId)!;
  if (task.attempt !== attempt) throw new Error('STALE_ATTEMPT');
  if (!['claimed', 'accepted', 'cancel_requested'].includes(job.status))
    throw new Error('INVALID_JOB_STATE');
  if (outcome === 'completed') {
    if (task.status !== 'running') throw new Error('JOB_NOT_STARTED');
    // Actual acknowledgement, never a forecast, makes an external task complete.
    task.finishAtTick = s.run.tick;
    finishTask(s, task.id, attempt);
  } else if (outcome === 'stopped') {
    if (job.status !== 'cancel_requested')
      throw new Error('CANCEL_NOT_REQUESTED');
    releaseStopped(s, job);
  } else if (outcome === 'uncertain') {
    job.status = 'uncertain';
    task.status = 'uncertain';
  } else throw new Error('INVALID_OUTCOME');
  emit(s, 'agent_result', outcome, {
    taskId: task.id,
    workerId: job.workerId,
    attempt,
  });
  s.run.version++;
  if (s.run.status === 'running') schedule(s);
}
