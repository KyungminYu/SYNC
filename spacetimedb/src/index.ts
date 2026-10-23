import { schema, table, t, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import {
  plan,
  validateProposal,
  eligible,
  isDue,
  completionDisposition,
  type Snapshot,
} from '@sync/core';
import { taskState, policyId } from './adapters/snapshot';
import { demoFixture } from '@sync/test-fixtures';
const id = () => t.u64().primaryKey().autoInc();
const runId = () => t.u64().index('btree');
const simulationSchedule = table(
  {},
  { scheduledId: id(), scheduledAt: t.scheduleAt(), runId: runId() },
);
const db = schema({
  run: table(
    { public: true },
    {
      id: id(),
      seed: t.u32(),
      policy: t.string(),
      tick: t.u32(),
      status: t.string(),
      controller: t.identity(),
    },
  ),
  task: table(
    { public: true },
    {
      id: id(),
      runId: runId(),
      label: t.string(),
      state: t.string(),
      capabilities: t.array(t.string()),
      duration: t.u32(),
      release: t.u32(),
      deadline: t.option(t.u32()),
      attempt: t.u32(),
      startedAt: t.option(t.u32()),
    },
  ),
  dependency: table(
    { public: true },
    {
      id: id(),
      runId: runId(),
      taskId: t.u64().index('btree'),
      prerequisiteId: t.u64(),
    },
  ),
  worker: table(
    { public: true },
    {
      id: id(),
      runId: runId(),
      label: t.string(),
      capabilities: t.array(t.string()),
      taskId: t.option(t.u64()),
    },
  ),
  resource: table(
    { public: true },
    { id: id(), runId: runId(), label: t.string(), capacity: t.u32() },
  ),
  taskRequirement: table(
    { public: true },
    {
      id: id(),
      runId: runId(),
      taskId: t.u64().index('btree'),
      resourceId: t.u64(),
      units: t.u32(),
    },
  ),
  reservation: table(
    { public: true },
    {
      id: id(),
      runId: runId(),
      taskId: t.u64().index('btree'),
      attempt: t.u32(),
      resourceId: t.u64().index('btree'),
      units: t.u32(),
    },
  ),
  agentJob: table(
    { public: true },
    {
      id: id(),
      runId: runId(),
      taskId: t.u64().index('btree'),
      workerId: t.u64(),
      attempt: t.u32(),
      state: t.string(),
      claimant: t.option(t.identity()),
    },
  ),
  decision: table(
    { public: true },
    {
      id: id(),
      runId: runId(),
      tick: t.u32(),
      taskId: t.u64(),
      workerId: t.u64(),
      reason: t.string(),
    },
  ),
  executionEvent: table(
    { public: true },
    {
      id: id(),
      runId: runId(),
      tick: t.u32(),
      taskId: t.option(t.u64()),
      attempt: t.u32(),
      kind: t.string(),
    },
  ),
  serviceRegistration: table(
    {},
    { id: id(), runId: runId(), identity: t.identity() },
  ),
  simulationSchedule,
});
export default db;
type Ctx = ReducerCtx<typeof db.schemaType>;
function run(ctx: Ctx, id: bigint) {
  const r = ctx.db.run.id.find(id);
  if (!r) throw new Error('Unknown run');
  return r;
}
function controller(ctx: Ctx, id: bigint) {
  const r = run(ctx, id);
  if (!r.controller.isEqual(ctx.sender)) throw new Error('Controller required');
  return r;
}
function event(
  ctx: Ctx,
  runId: bigint,
  kind: string,
  taskId?: bigint,
  attempt = 0,
) {
  ctx.db.executionEvent.insert({
    id: 0n,
    runId,
    tick: run(ctx, runId).tick,
    taskId,
    attempt,
    kind,
  });
}
function snapshot(ctx: Ctx, runId: bigint): Snapshot {
  const r = run(ctx, runId);
  const dependencies = [...ctx.db.dependency.runId.filter(runId)],
    requirements = [...ctx.db.taskRequirement.runId.filter(runId)];
  return {
    tick: r.tick,
    tasks: [...ctx.db.task.runId.filter(runId)].map((t) => ({
      ...t,
      state: taskState(t.state),
      dependencies: dependencies
        .filter((d) => d.taskId === t.id)
        .map((d) => d.prerequisiteId),
      requirements: requirements.filter((x) => x.taskId === t.id),
    })),
    workers: [...ctx.db.worker.runId.filter(runId)],
    resources: [...ctx.db.resource.runId.filter(runId)],
    reservations: [...ctx.db.reservation.runId.filter(runId)],
  };
}
function create(ctx: Ctx, seed: number, policy: string) {
  if (policy !== 'fcfs' && policy !== 'resource-aware')
    throw new Error('Unknown policy');
  const r = ctx.db.run.insert({
    id: 0n,
    seed,
    policy,
    tick: 0,
    status: 'paused',
    controller: ctx.sender,
  });
  const f = demoFixture(seed),
    resourceIds = new Map<bigint, bigint>(),
    taskIds = new Map<bigint, bigint>();
  for (const x of f.resources)
    resourceIds.set(
      x.id,
      ctx.db.resource.insert({
        id: 0n,
        runId: r.id,
        label: x.id === 1n ? 'Prep station' : 'Shared oven',
        capacity: x.capacity,
      }).id,
    );
  for (const [i, w] of f.workers.entries())
    ctx.db.worker.insert({
      id: 0n,
      runId: r.id,
      label: `Worker ${i + 1}`,
      capabilities: w.capabilities,
      taskId: undefined,
    });
  for (const task of f.tasks)
    taskIds.set(
      task.id,
      ctx.db.task.insert({
        id: 0n,
        runId: r.id,
        label: `Task ${task.id}`,
        state: task.state,
        capabilities: task.capabilities,
        duration: task.duration,
        release: task.release,
        deadline: task.deadline,
        attempt: 0,
        startedAt: undefined,
      }).id,
    );
  for (const task of f.tasks) {
    for (const d of task.dependencies)
      ctx.db.dependency.insert({
        id: 0n,
        runId: r.id,
        taskId: taskIds.get(task.id)!,
        prerequisiteId: taskIds.get(d)!,
      });
    for (const q of task.requirements)
      ctx.db.taskRequirement.insert({
        id: 0n,
        runId: r.id,
        taskId: taskIds.get(task.id)!,
        resourceId: resourceIds.get(q.resourceId)!,
        units: q.units,
      });
  }
  ctx.db.simulationSchedule.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(500_000n),
    runId: r.id,
  });
  event(ctx, r.id, 'INITIALIZED');
  return r;
}
function schedule(ctx: Ctx, runId: bigint) {
  const r = run(ctx, runId);
  if (r.status !== 'running') return;
  let s = snapshot(ctx, runId);
  for (const t of s.tasks)
    if (t.state === 'blocked' && eligible(t, s))
      ctx.db.task.id.update({ ...ctx.db.task.id.find(t.id)!, state: 'ready' });
  s = snapshot(ctx, runId);
  const p = plan(s, { policy: policyId(r.policy) });
  validateProposal(s, p);
  for (const a of p.assignments) {
    const task = ctx.db.task.id.find(a.taskId)!,
      worker = ctx.db.worker.id.find(a.workerId)!;
    const attempt = task.attempt + 1;
    ctx.db.task.id.update({ ...task, state: 'assigned', attempt });
    ctx.db.worker.id.update({ ...worker, taskId: task.id });
    for (const q of s.tasks.find((t) => t.id === task.id)!.requirements)
      ctx.db.reservation.insert({
        id: 0n,
        runId,
        taskId: task.id,
        attempt,
        resourceId: q.resourceId,
        units: q.units,
      });
    ctx.db.agentJob.insert({
      id: 0n,
      runId,
      taskId: task.id,
      workerId: worker.id,
      attempt,
      state: 'pending',
      claimant: undefined,
    });
    ctx.db.decision.insert({ id: 0n, runId, tick: r.tick, ...a });
  }
}
function complete(ctx: Ctx, runId: bigint, taskId: bigint, attempt: number) {
  const s = snapshot(ctx, runId),
    t = s.tasks.find((t) => t.id === taskId);
  if (!t) throw new Error('Wrong run');
  if (completionDisposition(t, attempt) === 'duplicate') return;
  ctx.db.task.id.update({
    ...ctx.db.task.id.find(taskId)!,
    state: 'succeeded',
  });
  for (const q of ctx.db.reservation.taskId.filter(taskId))
    if (q.runId === runId && q.attempt === attempt)
      ctx.db.reservation.id.delete(q.id);
  for (const w of ctx.db.worker.runId.filter(runId))
    if (w.taskId === taskId)
      ctx.db.worker.id.update({ ...w, taskId: undefined });
  event(ctx, runId, 'COMPLETED', taskId, attempt);
}
export const createDemoRun = db.reducer(
  { seed: t.u32(), policy: t.string() },
  (ctx, args) => {
    create(ctx, args.seed, args.policy);
  },
);
export const startRun = db.reducer({ runId: t.u64() }, (ctx, { runId }) => {
  const r = controller(ctx, runId);
  if (r.status !== 'paused') throw new Error('Run is not paused');
  ctx.db.run.id.update({ ...r, status: 'running' });
  schedule(ctx, runId);
});
export const pauseRun = db.reducer({ runId: t.u64() }, (ctx, { runId }) => {
  const r = controller(ctx, runId);
  if (r.status === 'running') ctx.db.run.id.update({ ...r, status: 'paused' });
});
export const resetRun = db.reducer({ runId: t.u64() }, (ctx, { runId }) => {
  const r = controller(ctx, runId);
  ctx.db.run.id.update({ ...r, status: 'retired' });
  for (const s of ctx.db.simulationSchedule.runId.filter(runId))
    ctx.db.simulationSchedule.scheduledId.delete(s.scheduledId);
  const fresh = create(ctx, r.seed, r.policy);
  for (const registration of ctx.db.serviceRegistration.runId.filter(runId))
    ctx.db.serviceRegistration.insert({
      id: 0n,
      runId: fresh.id,
      identity: registration.identity,
    });
});
export const registerService = db.reducer(
  { runId: t.u64(), identity: t.identity() },
  (ctx, { runId, identity }) => {
    controller(ctx, runId);
    if (
      ![...ctx.db.serviceRegistration.runId.filter(runId)].some((s) =>
        s.identity.isEqual(identity),
      )
    )
      ctx.db.serviceRegistration.insert({ id: 0n, runId, identity });
  },
);
export const scheduleReadyTasks = db.reducer(
  { runId: t.u64() },
  (ctx, { runId }) => {
    controller(ctx, runId);
    schedule(ctx, runId);
  },
);
export const claimAgentJob = db.reducer(
  { jobId: t.u64() },
  (ctx, { jobId }) => {
    const j = ctx.db.agentJob.id.find(jobId);
    if (!j || j.state !== 'pending' || run(ctx, j.runId).status !== 'running')
      throw new Error('Job unavailable');
    if (
      ![...ctx.db.serviceRegistration.runId.filter(j.runId)].some((s) =>
        s.identity.isEqual(ctx.sender),
      )
    )
      throw new Error('Service not authorized');
    ctx.db.agentJob.id.update({ ...j, state: 'claimed', claimant: ctx.sender });
  },
);
export const submitAgentAction = db.reducer(
  { jobId: t.u64(), taskId: t.u64(), attempt: t.u32(), action: t.string() },
  (ctx, { jobId, taskId, attempt, action }) => {
    const j = ctx.db.agentJob.id.find(jobId);
    if (!j || j.state !== 'claimed' || !j.claimant?.isEqual(ctx.sender))
      throw new Error('Claim owner required');
    const r = run(ctx, j.runId),
      task = ctx.db.task.id.find(taskId),
      worker = ctx.db.worker.id.find(j.workerId);
    if (r.status !== 'running' && r.status !== 'paused')
      throw new Error('Retired run');
    if (
      action !== 'start_operation' ||
      j.taskId !== taskId ||
      j.attempt !== attempt ||
      !task ||
      task.runId !== r.id ||
      task.attempt !== attempt ||
      task.state !== 'assigned' ||
      worker?.runId !== r.id ||
      worker.taskId !== taskId
    )
      throw new Error('Stale or invalid action');
    const s = snapshot(ctx, r.id),
      domain = s.tasks.find((t) => t.id === taskId)!;
    if (!eligible(domain, s)) throw new Error('Dependencies not complete');
    for (const req of domain.requirements)
      if (
        s.reservations
          .filter(
            (x) =>
              x.taskId === taskId &&
              x.attempt === attempt &&
              x.resourceId === req.resourceId,
          )
          .reduce((n, x) => n + x.units, 0) !== req.units
      )
        throw new Error('Reservation mismatch');
    ctx.db.agentJob.id.update({ ...j, state: 'accepted' });
    ctx.db.task.id.update({ ...task, state: 'running', startedAt: r.tick });
    event(ctx, r.id, 'STARTED', task.id, attempt);
  },
);
export const markJobUncertain = db.reducer(
  { jobId: t.u64() },
  (ctx, { jobId }) => {
    const j = ctx.db.agentJob.id.find(jobId);
    if (!j || j.state !== 'claimed' || !j.claimant?.isEqual(ctx.sender))
      throw new Error('Claim owner required');
    ctx.db.agentJob.id.update({ ...j, state: 'uncertain' });
    event(ctx, j.runId, 'UNCERTAIN', j.taskId, j.attempt);
  },
);
export const advanceTick = db.reducer(
  { onSchedule: simulationSchedule },
  { arg: simulationSchedule.rowType },
  (ctx, { arg }) => {
    const r = run(ctx, arg.runId);
    if (r.status !== 'running') return;
    ctx.db.run.id.update({ ...r, tick: r.tick + 1 });
    for (const task of snapshot(ctx, r.id).tasks)
      if (isDue(task, r.tick + 1)) complete(ctx, r.id, task.id, task.attempt);
    schedule(ctx, r.id);
    if (
      [...ctx.db.task.runId.filter(r.id)].every((t) => t.state === 'succeeded')
    ) {
      ctx.db.run.id.update({ ...run(ctx, r.id), status: 'complete' });
      ctx.db.simulationSchedule.scheduledId.delete(arg.scheduledId);
    }
  },
);
