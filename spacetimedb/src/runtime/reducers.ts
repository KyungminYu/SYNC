import { t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import { db, clock } from '../tables.ts';
import {
  createState,
  addOrder,
  setMember,
  setPolicy,
  setRunning,
  closeArrivals,
  advance,
  schedule,
  claimJob,
  submitAction,
  setAvailability,
  markUncertain,
  reconcile,
} from '../domain/engine.ts';
import { requireService, requireControl } from '../domain/access.ts';
import { nextBase } from '../domain/model.ts';
import type { PolicyConfig } from '../policies/scheduler.ts';
import { load, save } from './store.ts';
import type { MutableDb } from './store.ts';
import { isRecipeId } from '../domain/recipes.ts';
export const create_run = db.reducer(
  {
    name: t.string(),
    seed: t.u32(),
    trayCount: t.u32(),
    mode: t.string(),
    budgetMicrousd: t.option(t.u64()),
  },
  (ctx, args) => {
    if (args.mode !== 'deterministic' && args.mode !== 'claude')
      throw new Error('INVALID_MODE');
    const ownerIdentityHex = ctx.sender.toHexString();
    if ([...ctx.db.run.ownerIdentityHex.filter(ownerIdentityHex)].length >= 10)
      throw new Error('OWNER_RUN_LIMIT');
    const initial = createState(
      0n,
      ownerIdentityHex,
      args.name,
      args.seed,
      args.trayCount,
      args.mode,
      args.budgetMicrousd,
    );
    const inserted = ctx.db.run.insert({
      ...initial.run,
      budgetMicrousd: initial.run.budgetMicrousd,
    });
    const state = createState(
      inserted.id,
      ownerIdentityHex,
      args.name,
      args.seed,
      args.trayCount,
      args.mode,
      args.budgetMicrousd,
    );
    save(ctx.db as unknown as MutableDb, state);
    // Exactly one schedule row per run; runId has a unique index.
    ctx.db.clock.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.interval(200000n),
      runId: inserted.id,
    });
  },
);
export const grant_member = db.reducer(
  {
    runId: t.u64(),
    identity: t.identity(),
    permission: t.string(),
    enabled: t.bool(),
  },
  (ctx, args) => {
    if (!['viewer', 'operator', 'service'].includes(args.permission))
      throw new Error('INVALID_PERMISSION');
    const store = ctx.db as unknown as MutableDb;
    const s = load(store, args.runId);
    setMember(
      s,
      { identityHex: ctx.sender.toHexString() },
      args.identity.toHexString(),
      args.permission as 'viewer' | 'operator' | 'service',
      args.enabled,
    );
    save(store, s);
  },
);
export const set_run_status = db.reducer(
  { runId: t.u64(), running: t.bool() },
  (ctx, args) => {
    const store = ctx.db as unknown as MutableDb;
    const s = load(store, args.runId);
    setRunning(s, { identityHex: ctx.sender.toHexString() }, args.running);
    save(store, s);
  },
);
export const enqueue_order = db.reducer(
  {
    runId: t.u64(),
    externalKey: t.string(),
    cartKey: t.option(t.string()),
    recipe: t.string(),
    deadlineInTicks: t.u32(),
    value: t.u32(),
    priority: t.u32(),
    customerUseTicks: t.u32(),
  },
  (ctx, args) => {
    if (!isRecipeId(args.recipe)) throw new Error('INVALID_RECIPE');
    const store = ctx.db as unknown as MutableDb;
    const s = load(store, args.runId);
    addOrder(
      s,
      { identityHex: ctx.sender.toHexString() },
      { ...args, cartKey: args.cartKey ?? undefined, recipe: args.recipe },
    );
    schedule(s);
    save(store, s);
  },
);
export const set_policy = db.reducer(
  { runId: t.u64(), configJson: t.string() },
  (ctx, args) => {
    if (args.configJson.length > 4096) throw new Error('POLICY_TOO_LARGE');
    const patch: unknown = JSON.parse(args.configJson);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
      throw new Error('INVALID_POLICY');
    const allowed = [
      'policy',
      'urgencyWeight',
      'criticalityWeight',
      'ageWeight',
      'durationWeight',
      'costWeight',
      'priorityWeight',
      'valueWeight',
      'timeScaleTicks',
      'costScaleMicrousd',
      'maxAgeTicks',
      'candidatesPerWorker',
      'maxBranches',
    ];
    if (Object.keys(patch).some((k) => !allowed.includes(k)))
      throw new Error('UNKNOWN_POLICY_FIELD');
    const store = ctx.db as unknown as MutableDb;
    const s = load(store, args.runId);
    setPolicy(
      s,
      { identityHex: ctx.sender.toHexString() },
      patch as Partial<PolicyConfig>,
    );
    schedule(s);
    save(store, s);
  },
);
export const step_run = db.reducer({ runId: t.u64() }, (ctx, args) => {
  const store = ctx.db as unknown as MutableDb;
  const s = load(store, args.runId);
  requireControl(s, { identityHex: ctx.sender.toHexString() });
  // Manual step is deliberately paused-only to avoid a browser speeding up a live clock.
  if (s.run.status !== 'paused') throw new Error('PAUSE_BEFORE_MANUAL_STEP');
  s.run.status = 'running';
  advance(s);
  if (s.run.status === 'running') s.run.status = 'paused';
  save(store, s);
});
export const tick_run = db.reducer(
  { onSchedule: clock },
  { arg: clock.rowType },
  (ctx, { arg }) => {
    const store = ctx.db as unknown as MutableDb;
    const s = load(store, arg.runId);
    if (ctx.db.run.id.find(arg.runId)?.status === 'completed') {
      ctx.db.clock.scheduledId.delete(arg.scheduledId);
      return;
    }
    if (s.run.status !== 'running') return;
    advance(s);
    save(store, s);
    if (ctx.db.run.id.find(arg.runId)?.status === 'completed')
      ctx.db.clock.scheduledId.delete(arg.scheduledId);
  },
);
export const claim_agent_job = db.reducer(
  { runId: t.u64(), jobId: t.u64() },
  (ctx, args) => {
    const store = ctx.db as unknown as MutableDb;
    const s = load(store, args.runId);
    claimJob(s, { identityHex: ctx.sender.toHexString() }, args.jobId);
    save(store, s);
  },
);
export const submit_agent_action = db.reducer(
  { runId: t.u64(), jobId: t.u64(), attempt: t.u32(), action: t.string() },
  (ctx, args) => {
    const store = ctx.db as unknown as MutableDb;
    const s = load(store, args.runId);
    submitAction(
      s,
      { identityHex: ctx.sender.toHexString() },
      args.jobId,
      args.attempt,
      args.action,
    );
    save(store, s);
  },
);
export const set_resource_available = db.reducer(
  { runId: t.u64(), resourceId: t.u64(), available: t.bool() },
  (ctx, args) => {
    const store = ctx.db as unknown as MutableDb;
    const s = load(store, args.runId);
    setAvailability(
      s,
      { identityHex: ctx.sender.toHexString() },
      args.resourceId,
      args.available,
    );
    save(store, s);
  },
);
export const mark_job_uncertain = db.reducer(
  { runId: t.u64(), jobId: t.u64() },
  (ctx, args) => {
    const store = ctx.db as unknown as MutableDb;
    const s = load(store, args.runId);
    markUncertain(s, { identityHex: ctx.sender.toHexString() }, args.jobId);
    save(store, s);
  },
);
export const reconcile_job = db.reducer(
  { runId: t.u64(), jobId: t.u64(), resolution: t.string() },
  (ctx, args) => {
    if (args.resolution !== 'resume' && args.resolution !== 'retry_safe')
      throw new Error('INVALID_RESOLUTION');
    const store = ctx.db as unknown as MutableDb;
    const s = load(store, args.runId);
    reconcile(
      s,
      { identityHex: ctx.sender.toHexString() },
      args.jobId,
      args.resolution,
    );
    save(store, s);
  },
);
export const report_usage = db.reducer(
  {
    runId: t.u64(),
    externalKey: t.string(),
    taskId: t.option(t.u64()),
    attempt: t.option(t.u32()),
    source: t.string(),
    inputTokens: t.u64(),
    outputTokens: t.u64(),
    reportedCostMicrousd: t.u64(),
    wallMilliseconds: t.f64(),
  },
  (ctx, args) => {
    const store = ctx.db as unknown as MutableDb;
    const s = load(store, args.runId);
    const actor = { identityHex: ctx.sender.toHexString() };
    requireService(s, actor);
    if (
      !args.externalKey ||
      args.externalKey.length > 100 ||
      s.telemetry.length >= 10000
    )
      throw new Error('TELEMETRY_LIMIT');
    if (args.source !== 'anthropic' && args.source !== 'coordinator')
      throw new Error('INVALID_SOURCE');
    if (
      !Number.isFinite(args.wallMilliseconds) ||
      args.wallMilliseconds < 0 ||
      args.wallMilliseconds > 3600000
    )
      throw new Error('INVALID_DURATION');
    if (args.source === 'anthropic') {
      if (args.taskId === undefined || args.attempt === undefined)
        throw new Error('TASK_ATTEMPT_REQUIRED');
      const job = s.jobs.find(
        (j) =>
          j.taskId === args.taskId &&
          j.attempt === args.attempt &&
          j.claimantIdentityHex === actor.identityHex,
      );
      if (!job) throw new Error('USAGE_JOB_NOT_OWNED');
    }
    const old = s.telemetry.find((t) => t.externalKey === args.externalKey);
    if (old) return;
    s.telemetry.push({
      ...nextBase(s),
      ...args,
      source: args.source,
      reporterIdentityHex: actor.identityHex,
    });
    s.run.version++;
    save(store, s);
  },
);
// No reducer accepts arbitrary task completion, raw table writes, or model-generated code.
export const close_arrivals = db.reducer({ runId: t.u64() }, (ctx, args) => {
  const store = ctx.db as unknown as MutableDb;
  const s = load(store, args.runId);
  closeArrivals(s, { identityHex: ctx.sender.toHexString() });
  save(store, s);
});
