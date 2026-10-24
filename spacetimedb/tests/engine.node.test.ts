import { reportJobResult } from '../src/domain/externalExecution.ts';
/** Run with Node.js 24+: node --test tests/engine.node.test.ts */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addOrder,
  advance,
  assertInvariants,
  blockedReason,
  claimJob,
  closeArrivals,
  createState,
  finishTask,
  freeUnits,
  markUncertain,
  reconcile,
  refreshReady,
  schedule,
  setAvailability,
  setMember,
  setPolicy,
  setRunning,
  snapshot,
  submitAction,
} from '../src/domain/engine.ts';
import {
  permission,
  requireControl,
  requireOwner,
  requireService,
} from '../src/domain/access.ts';
import {
  materializeRecipe,
  ROLE_CAPACITIES,
  isRole,
  isRecipeId,
  isTaskKind,
} from '../src/domain/recipes.ts';
import type { State, Task, Principal } from '../src/domain/model.ts';
import type { RecipeId, TaskKind } from '../src/domain/recipes.ts';

const OWNER: Principal = { identityHex: 'owner' };
const SERVICE: Principal = { identityHex: 'service' };
const OTHER_SERVICE: Principal = { identityHex: 'service-2' };
const VIEWER: Principal = { identityHex: 'viewer' };
const OPERATOR: Principal = { identityHex: 'operator' };
const STRANGER: Principal = { identityHex: 'stranger' };

function fresh(
  mode: 'deterministic' | 'claude' = 'deterministic',
  trays = 2,
  budget?: bigint,
): State {
  return createState(
    1n,
    OWNER.identityHex,
    'Test café',
    42,
    trays,
    mode,
    budget,
  );
}

function order(
  s: State,
  key = 'order-1',
  recipe: RecipeId = 'latte',
  customerUseTicks = 3,
) {
  return addOrder(s, OWNER, {
    externalKey: key,
    recipe,
    deadlineInTicks: 100,
    value: 10,
    priority: 1,
    customerUseTicks,
  });
}

function taskFor(s: State, orderId: bigint, kind: TaskKind): Task {
  const task = s.tasks.find((t) => t.orderId === orderId && t.kind === kind);
  assert.ok(task, `Missing ${kind} for order ${orderId}`);
  return task;
}

function advanceUntil(s: State, predicate: () => boolean, limit = 1_000) {
  for (let n = 0; n < limit && !predicate(); n++) {
    assert.equal(
      s.run.status,
      'running',
      'Run stopped before target condition',
    );
    advance(s);
    assertInvariants(s);
  }
  assert.ok(predicate(), `Target condition was not reached in ${limit} ticks`);
}

function registerServices(s: State) {
  setMember(s, OWNER, SERVICE.identityHex, 'service', true);
  setMember(s, OWNER, OTHER_SERVICE.identityHex, 'service', true);
}

test('recipes expose the exact optional-milk DAG and fresh mutable definitions', () => {
  const black = materializeRecipe('black_coffee');
  const latte = materializeRecipe('latte');
  assert.equal(black.length, 9);
  assert.equal(latte.length, 10);
  assert.equal(
    black.some((t) => t.kind === 'prepare_milk'),
    false,
  );
  assert.deepEqual(
    black.find((t) => t.kind === 'assemble_drink')!.dependencies,
    ['prepare_coffee'],
  );
  assert.deepEqual(
    latte.find((t) => t.kind === 'assemble_drink')!.dependencies,
    ['prepare_coffee', 'prepare_milk'],
  );
  for (const recipe of [black, latte]) {
    const seen = new Set<TaskKind>();
    for (const task of recipe) {
      for (const dependency of task.dependencies)
        assert.ok(seen.has(dependency));
      seen.add(task.kind);
    }
    assert.deepEqual(
      recipe.filter((t) => t.rewardDelivery).map((t) => t.kind),
      ['deliver_order'],
    );
    assert.deepEqual(
      recipe.filter((t) => t.customerReleaseGuard).map((t) => t.kind),
      ['collect_tray'],
    );
    assert.deepEqual(
      recipe.filter((t) => t.trayMode === 'acquire').map((t) => t.kind),
      ['pick_up_drink'],
    );
    assert.deepEqual(
      recipe.filter((t) => t.trayMode === 'release').map((t) => t.kind),
      ['return_tray'],
    );
  }
  latte[0]!.capabilities.push('corrupted');
  assert.deepEqual(materializeRecipe('latte')[0]!.capabilities, ['cashier']);
  assert.ok(isRole('cashier'));
  assert.equal(isRole('constructor'), false);
  assert.ok(isRecipeId('latte'));
  assert.equal(isRecipeId('tea'), false);
  assert.ok(isTaskKind('return_tray'));
  assert.equal(isTaskKind('unknown'), false);
});

test('initial state represents seven concrete workers and station capacities 2/2/2/1', () => {
  const s = fresh();
  assert.equal(s.workers.length, 7);
  assert.equal(s.resources.length, 4);
  for (const [role, capacity] of Object.entries(ROLE_CAPACITIES)) {
    assert.equal(s.workers.filter((w) => w.role === role).length, capacity);
    const resource = s.resources.find((r) => r.role === role)!;
    assert.equal(resource.capacity, capacity);
    assert.equal(freeUnits(s, resource.id), capacity);
  }
  assert.equal(s.run.status, 'paused');
  assertInvariants(s);
});

test('multiple mixed orders complete, release all trays and reservations, and respect the budget', () => {
  const s = fresh('deterministic', 2, 100_000n);
  order(s, 'a', 'latte');
  order(s, 'b', 'black_coffee');
  order(s, 'c', 'latte');
  setRunning(s, OWNER, true);
  closeArrivals(s, OWNER);
  advanceUntil(s, () => s.run.status === 'completed');
  assert.equal(s.orders.filter((o) => o.status === 'cleaned').length, 3);
  assert.ok(
    s.orders.every(
      (o) =>
        o.deliveredTick !== undefined && o.cleanupCompletedTick !== undefined,
    ),
  );
  assert.ok(s.tasks.every((t) => t.status === 'succeeded'));
  assert.equal(s.reservations.length, 0);
  assert.ok(s.workers.every((w) => w.currentTaskId === undefined));
  assert.ok(
    s.trays.every((t) => t.state === 'clean' && t.orderId === undefined),
  );
  assert.equal(s.run.reservedMicrousd, 0n);
  const expected = s.tasks.reduce((n, t) => n + t.estimatedCostMicrousd, 0n);
  assert.equal(s.run.modeledSpentMicrousd, expected);
  assert.ok(s.run.modeledSpentMicrousd <= s.run.budgetMicrousd!);
});

test('latte assembly cannot start until both coffee and milk have succeeded', () => {
  const s = fresh();
  const o = order(s);
  setRunning(s, OWNER, true);
  advanceUntil(
    s,
    () => taskFor(s, o.id, 'prepare_milk').status === 'succeeded',
  );
  const milk = taskFor(s, o.id, 'prepare_milk');
  const coffee = taskFor(s, o.id, 'prepare_coffee');
  const assembly = taskFor(s, o.id, 'assemble_drink');
  assert.equal(milk.status, 'succeeded');
  assert.equal(coffee.status, 'running');
  assert.equal(assembly.status, 'blocked');
  assert.equal(blockedReason(s, assembly), 'dependencies');
  advanceUntil(s, () => assembly.status === 'running');
  assert.equal(coffee.status, 'succeeded');
  assert.ok(
    assembly.startedTick! >= Math.max(coffee.finishedTick!, milk.finishedTick!),
  );
});

test('failed prerequisites do not unlock a dependent task', () => {
  const s = fresh();
  const o = order(s, 'black', 'black_coffee');
  taskFor(s, o.id, 'capture_order').status = 'failed';
  refreshReady(s);
  assert.equal(taskFor(s, o.id, 'take_payment').status, 'blocked');
  assert.equal(snapshot(s).tasks.length, 0);
});

test('customer-use wait retains the order tray and blocks collection without occupying a cleaner', () => {
  const s = fresh('deterministic', 1);
  const o = order(s, 'a', 'black_coffee', 8);
  order(s, 'b', 'black_coffee', 0);
  setRunning(s, OWNER, true);
  advanceUntil(s, () => o.deliveredTick !== undefined);
  const trayId = o.trayId;
  assert.notEqual(trayId, undefined);
  const tray = s.trays.find((t) => t.id === trayId)!;
  assert.equal(tray.orderId, o.id);
  assert.equal(tray.state, 'in_use');
  assert.equal(
    blockedReason(s, taskFor(s, o.id, 'collect_tray')),
    'customer_using_tray',
  );
  assert.equal(
    s.workers.filter(
      (w) => w.role === 'cleaner' && w.currentTaskId !== undefined,
    ).length,
    0,
  );
  while (s.run.tick + 1 < o.customerReleaseTick!) {
    advance(s);
    assert.equal(tray.orderId, o.id);
    assert.equal(taskFor(s, o.id, 'collect_tray').status, 'blocked');
    assert.equal(
      s.orders.filter((x) => x.deliveredTick !== undefined).length,
      1,
    );
    assertInvariants(s);
  }
  advanceUntil(s, () => taskFor(s, o.id, 'return_tray').status === 'succeeded');
  assert.equal(o.trayId, undefined);
  assert.equal(o.status, 'cleaned');
  closeArrivals(s, OWNER);
  advanceUntil(s, () => s.run.status === 'completed');
});

test('duplicate task completion is a no-op and premature/stale completion is rejected', () => {
  const s = fresh();
  const o = order(s);
  setRunning(s, OWNER, true);
  const task = taskFor(s, o.id, 'capture_order');
  assert.throws(() => finishTask(s, task.id, task.attempt), /NOT_FINISHED/);
  assert.throws(
    () => finishTask(s, task.id, task.attempt + 1),
    /STALE_ATTEMPT/,
  );
  advanceUntil(s, () => task.status === 'succeeded');
  const before = structuredClone(s);
  finishTask(s, task.id, task.attempt);
  assert.deepEqual(s, before);
});

test('external order keys are idempotent and reject conflicting payloads', () => {
  const s = fresh();
  const first = order(s, 'same-key');
  const taskCount = s.tasks.length;
  const duplicate = order(s, 'same-key');
  assert.equal(duplicate.id, first.id);
  assert.equal(s.tasks.length, taskCount);
  assert.throws(
    () => order(s, 'same-key', 'black_coffee'),
    /IDEMPOTENCY_KEY_CONFLICT/,
  );
});

test('unknown and viewer identities cannot control runs or self-register services', () => {
  const s = fresh();
  assert.equal(permission(s, STRANGER), undefined);
  assert.throws(() => requireControl(s, STRANGER), /FORBIDDEN_CONTROL/);
  assert.throws(
    () => setMember(s, STRANGER, SERVICE.identityHex, 'service', true),
    /FORBIDDEN_OWNER/,
  );
  setMember(s, OWNER, VIEWER.identityHex, 'viewer', true);
  assert.equal(permission(s, VIEWER), 'viewer');
  assert.throws(() => setRunning(s, VIEWER, true), /FORBIDDEN_CONTROL/);
  assert.throws(() => requireService(s, OWNER), /FORBIDDEN_SERVICE/);
  setMember(s, OWNER, OPERATOR.identityHex, 'operator', true);
  requireControl(s, OPERATOR);
  assert.throws(() => requireOwner(s, OPERATOR), /FORBIDDEN_OWNER/);
  assert.throws(
    () => setMember(s, OPERATOR, 'x', 'service', true),
    /FORBIDDEN_OWNER/,
  );
});

test('policy updates are validated and cannot modify running task ownership', () => {
  const s = fresh();
  order(s);
  setRunning(s, OWNER, true);
  const running = s.tasks.find((t) => t.status === 'running')!;
  const original = {
    id: running.id,
    attempt: running.attempt,
    worker: running.workerId,
    finish: running.finishAtTick,
  };
  setPolicy(s, OWNER, { policy: 'fcfs' });
  schedule(s);
  assert.deepEqual(
    {
      id: running.id,
      attempt: running.attempt,
      worker: running.workerId,
      finish: running.finishAtTick,
    },
    original,
  );
  assert.throws(
    () => setPolicy(s, OWNER, { urgencyWeight: Number.NaN }),
    /INVALID|finite|weight/i,
  );
});

test('live jobs require authoritative single-owner claims and exact action/attempt', () => {
  const s = fresh('claude');
  registerServices(s);
  order(s);
  setRunning(s, OWNER, true);
  const job = s.jobs.find((j) => j.status === 'pending')!;
  assert.ok(job);
  assert.throws(() => claimJob(s, STRANGER, job.id), /FORBIDDEN_SERVICE/);
  claimJob(s, SERVICE, job.id);
  claimJob(s, SERVICE, job.id); // Idempotent retry by current claimant.
  assert.throws(() => claimJob(s, OTHER_SERVICE, job.id), /ALREADY_CLAIMED/);
  assert.throws(
    () =>
      submitAction(s, OTHER_SERVICE, job.id, job.attempt, job.expectedAction),
    /INVALID_JOB_OWNER_OR_ATTEMPT/,
  );
  assert.throws(
    () => submitAction(s, SERVICE, job.id, job.attempt + 1, job.expectedAction),
    /INVALID_JOB_OWNER_OR_ATTEMPT/,
  );
  assert.throws(
    () => submitAction(s, SERVICE, job.id, job.attempt, 'return_tray'),
    /INVALID_ACTION/,
  );
  submitAction(s, SERVICE, job.id, job.attempt, job.expectedAction);
  const before = structuredClone(s);
  submitAction(s, SERVICE, job.id, job.attempt, job.expectedAction);
  assert.deepEqual(s, before);
  assert.equal(s.tasks.find((t) => t.id === job.taskId)!.status, 'running');
  assertInvariants(s);
});

test('pausing live execution stops ticks and rejects newly submitted actions', () => {
  const s = fresh('claude');
  registerServices(s);
  order(s);
  setRunning(s, OWNER, true);
  const job = s.jobs.find((j) => j.status === 'pending')!;
  claimJob(s, SERVICE, job.id);
  setRunning(s, OWNER, false);
  const tick = s.run.tick;
  advance(s);
  assert.equal(s.run.tick, tick);
  assert.throws(
    () => submitAction(s, SERVICE, job.id, job.attempt, job.expectedAction),
    /RUN_PAUSED/,
  );
  assert.throws(() => claimJob(s, OTHER_SERVICE, job.id), /NOT_LIVE_RUN/);
  setRunning(s, OWNER, true);
  submitAction(s, SERVICE, job.id, job.attempt, job.expectedAction);
  assert.equal(job.status, 'accepted');
});

test('uncertain jobs retain reservations and budget until owner reconciliation', () => {
  const s = fresh('claude', 1, 20_000n);
  registerServices(s);
  order(s, 'a', 'black_coffee');
  setRunning(s, OWNER, true);
  const job = s.jobs.find((j) => j.status === 'pending')!;
  claimJob(s, SERVICE, job.id);
  const reserved = s.run.reservedMicrousd;
  const reservations = structuredClone(s.reservations);
  markUncertain(s, OWNER, job.id);
  assert.equal(job.status, 'uncertain');
  assert.equal(s.run.reservedMicrousd, reserved);
  assert.deepEqual(s.reservations, reservations);
  assert.throws(
    () => reconcile(s, SERVICE, job.id, 'retry_safe'),
    /FORBIDDEN_OWNER/,
  );
  assert.throws(
    () => submitAction(s, SERVICE, job.id, job.attempt, job.expectedAction),
    /JOB_NOT_CLAIMED/,
  );
  reconcile(s, OWNER, job.id, 'resume');
  assert.equal(job.status, 'accepted');
  assert.equal(s.tasks.find((t) => t.id === job.taskId)!.status, 'running');
  assert.equal(s.run.reservedMicrousd, reserved);
  assertInvariants(s);
});

test('safe retry fences the old attempt and creates only one replacement job', () => {
  const s = fresh('claude');
  registerServices(s);
  order(s);
  setRunning(s, OWNER, true);
  const old = s.jobs.find((j) => j.status === 'pending')!;
  claimJob(s, SERVICE, old.id);
  markUncertain(s, OWNER, old.id);
  reconcile(s, OWNER, old.id, 'retry_safe');
  assert.equal(old.status, 'failed');
  const replacements = s.jobs.filter(
    (j) => j.taskId === old.taskId && j.attempt === old.attempt + 1,
  );
  assert.equal(replacements.length, 1);
  assert.throws(
    () => submitAction(s, SERVICE, old.id, old.attempt, old.expectedAction),
    /STALE_ATTEMPT/,
  );
  const replacement = replacements[0]!;
  claimJob(s, OTHER_SERVICE, replacement.id);
  submitAction(
    s,
    OTHER_SERVICE,
    replacement.id,
    replacement.attempt,
    replacement.expectedAction,
  );
  assertInvariants(s);
});

test('safe retry of pickup retains its order-owned tray without acquiring another', () => {
  const s = fresh('claude', 1);
  registerServices(s);
  const o = order(s, 'a', 'black_coffee');
  setRunning(s, OWNER, true);
  let pickupJob = s.jobs.find(
    (j) => j.expectedAction === 'pick_up_drink' && j.status === 'pending',
  );
  for (let n = 0; n < 100 && !pickupJob; n++) {
    for (const job of s.jobs.filter((j) => j.status === 'pending')) {
      claimJob(s, SERVICE, job.id);
      submitAction(s, SERVICE, job.id, job.attempt, job.expectedAction);
      reportJobResult(s, SERVICE, job.id, job.attempt, 'completed');
    }
    advance(s);
    pickupJob = s.jobs.find(
      (j) => j.expectedAction === 'pick_up_drink' && j.status === 'pending',
    );
  }
  assert.ok(pickupJob);
  const originalTrayId = o.trayId;
  assert.notEqual(originalTrayId, undefined);
  assert.equal(s.trays.filter((t) => t.orderId === o.id).length, 1);
  claimJob(s, SERVICE, pickupJob.id);
  markUncertain(s, OWNER, pickupJob.id);
  reconcile(s, OWNER, pickupJob.id, 'retry_safe');
  assert.equal(o.trayId, originalTrayId);
  assert.equal(s.trays.filter((t) => t.orderId === o.id).length, 1);
  const replacement = s.jobs.find(
    (j) => j.taskId === pickupJob.taskId && j.attempt === pickupJob.attempt + 1,
  );
  assert.ok(replacement);
  assert.equal(replacement.status, 'pending');
  claimJob(s, OTHER_SERVICE, replacement.id);
  submitAction(
    s,
    OTHER_SERVICE,
    replacement.id,
    replacement.attempt,
    replacement.expectedAction,
  );
  assert.equal(o.trayId, originalTrayId);
  assertInvariants(s);
});

test('service authorization cannot be revoked while it owns an unresolved claim', () => {
  const s = fresh('claude');
  registerServices(s);
  order(s);
  setRunning(s, OWNER, true);
  const job = s.jobs.find((j) => j.status === 'pending')!;
  claimJob(s, SERVICE, job.id);
  assert.throws(
    () => setMember(s, OWNER, SERVICE.identityHex, 'service', false),
    /RECONCILE_CLAIMS_BEFORE_REVOKE/,
  );
});

test('service demotion is rejected for both claimed and uncertain jobs even when enabled stays true', () => {
  for (const status of ['claimed', 'uncertain'] as const) {
    const s = fresh('claude');
    registerServices(s);
    order(s);
    setRunning(s, OWNER, true);
    const job = s.jobs.find((j) => j.status === 'pending')!;
    claimJob(s, SERVICE, job.id);
    if (status === 'uncertain') markUncertain(s, OWNER, job.id);
    assert.equal(job.status, status);
    assert.throws(
      () => setMember(s, OWNER, SERVICE.identityHex, 'viewer', true),
      /RECONCILE_CLAIMS_BEFORE_REVOKE/,
    );
    assert.throws(
      () => setMember(s, OWNER, SERVICE.identityHex, 'operator', true),
      /RECONCILE_CLAIMS_BEFORE_REVOKE/,
    );
    assert.equal(permission(s, SERVICE), 'service');
    assertInvariants(s);
  }
});

test('uncertain resume is rejected while paused and succeeds after explicit resume', () => {
  const s = fresh('claude');
  registerServices(s);
  order(s);
  setRunning(s, OWNER, true);
  const job = s.jobs.find((j) => j.status === 'pending')!;
  claimJob(s, SERVICE, job.id);
  markUncertain(s, OWNER, job.id);
  setRunning(s, OWNER, false);
  const before = structuredClone(s);
  assert.throws(() => reconcile(s, OWNER, job.id, 'resume'), /RUN_PAUSED/);
  assert.deepEqual(s, before);
  setRunning(s, OWNER, true);
  reconcile(s, OWNER, job.id, 'resume');
  assert.equal(job.status, 'accepted');
  assert.equal(s.tasks.find((t) => t.id === job.taskId)!.status, 'running');
  assertInvariants(s);
});

test('live mode can complete the entire DAG using validated mock agent actions', () => {
  const s = fresh('claude');
  registerServices(s);
  order(s, 'a', 'latte', 2);
  setRunning(s, OWNER, true);
  closeArrivals(s, OWNER);
  for (let n = 0; n < 300 && s.run.status !== 'completed'; n++) {
    for (const job of s.jobs.filter((j) => j.status === 'pending')) {
      claimJob(s, SERVICE, job.id);
      submitAction(s, SERVICE, job.id, job.attempt, job.expectedAction);
      reportJobResult(s, SERVICE, job.id, job.attempt, 'completed');
    }
    advance(s);
    assertInvariants(s);
  }
  assert.equal(s.run.status, 'completed');
  assert.equal(s.run.reservedMicrousd, 0n);
  assert.equal(s.orders[0]!.status, 'cleaned');
});

test('orders can be revealed while a run is in progress and are absent before arrival', () => {
  const s = fresh();
  order(s, 'a', 'black_coffee');
  setRunning(s, OWNER, true);
  advance(s);
  const before = new Set(snapshot(s).tasks.map((t) => t.orderId));
  const added = order(s, 'later', 'latte');
  assert.equal(added.arrivalTick, 1);
  assert.equal(before.has(added.id), false);
  schedule(s);
  assert.ok(
    s.tasks
      .filter((t) => t.orderId === added.id)
      .every((t) => t.releaseTick === 1),
  );
  closeArrivals(s, OWNER);
  advanceUntil(s, () => s.run.status === 'completed');
  assert.equal(s.orders.length, 2);
});

test('an open-arrival run remains running across idle gaps and accepts later orders', () => {
  const s = fresh();
  const first = order(s, 'first', 'black_coffee', 0);
  setRunning(s, OWNER, true);
  advanceUntil(s, () => first.status === 'cleaned');
  assert.equal(s.run.status, 'running');
  assert.equal(s.run.arrivalsClosed, false);
  for (let i = 0; i < 5; i++) advance(s);
  assert.equal(s.run.status, 'running');
  const later = order(s, 'after-idle', 'latte');
  assert.ok(later.arrivalTick > first.cleanupCompletedTick!);
  schedule(s);
  closeArrivals(s, OWNER);
  assert.throws(() => order(s, 'too-late'), /ARRIVALS_CLOSED/);
  advanceUntil(s, () => s.run.status === 'completed');
  assert.equal(s.orders.length, 2);
});

test('closing arrivals is access controlled and completes an already idle run', () => {
  const s = fresh();
  setRunning(s, OWNER, true);
  assert.throws(() => closeArrivals(s, STRANGER), /FORBIDDEN_CONTROL/);
  assert.equal(s.run.arrivalsClosed, false);
  closeArrivals(s, OWNER);
  assert.equal(s.run.arrivalsClosed, true);
  assert.equal(s.run.status, 'completed');
});

test('resource disruption blocks new admissions while existing operations drain', () => {
  const s = fresh();
  const o = order(s, 'a', 'black_coffee');
  setRunning(s, OWNER, true);
  const cashier = s.resources.find((r) => r.role === 'cashier')!;
  const capture = taskFor(s, o.id, 'capture_order');
  assert.equal(capture.status, 'running');
  setAvailability(s, OWNER, cashier.id, false);
  assert.equal(freeUnits(s, cashier.id), 0);
  advanceUntil(s, () => capture.status === 'succeeded');
  assert.equal(taskFor(s, o.id, 'take_payment').status, 'ready');
  for (let i = 0; i < 5; i++) advance(s);
  assert.equal(taskFor(s, o.id, 'take_payment').status, 'ready');
  assert.equal(
    s.reservations.filter((r) => r.resourceId === cashier.id).length,
    0,
  );
  setAvailability(s, OWNER, cashier.id, true);
  assert.equal(taskFor(s, o.id, 'take_payment').status, 'running');
  closeArrivals(s, OWNER);
  advanceUntil(s, () => s.run.status === 'completed');
});

test('a zero budget admits no task and repeated scheduling does not duplicate claims', () => {
  const s = fresh('deterministic', 1, 0n);
  order(s, 'a', 'black_coffee');
  setRunning(s, OWNER, true);
  for (let i = 0; i < 10; i++) advance(s);
  assert.equal(s.jobs.length, 0);
  assert.equal(s.reservations.length, 0);
  assert.equal(s.run.reservedMicrousd, 0n);
  assert.equal(s.run.modeledSpentMicrousd, 0n);
  assertInvariants(s);
});

test('partial budget stops further admissions without overspending reserved plus settled cost', () => {
  const s = fresh('deterministic', 1, 5_000n);
  const o = order(s, 'a', 'black_coffee');
  setRunning(s, OWNER, true);
  for (let i = 0; i < 50; i++) {
    advance(s);
    assert.ok(s.run.modeledSpentMicrousd + s.run.reservedMicrousd <= 5_000n);
    assertInvariants(s);
  }
  assert.equal(taskFor(s, o.id, 'take_payment').status, 'succeeded');
  assert.equal(taskFor(s, o.id, 'prepare_coffee').status, 'ready');
  assert.equal(s.run.modeledSpentMicrousd, 4_000n);
  assert.equal(s.run.reservedMicrousd, 0n);
});

test('invariants reject a modeled budget cap violation independently of admission', () => {
  const s = fresh('deterministic', 1, 1_000n);
  s.run.modeledSpentMicrousd = 1_001n;
  assert.throws(() => assertInvariants(s), /BUDGET_CAP/);
});

test('invalid initial inputs and completed-run additions fail explicitly', () => {
  assert.throws(
    () => createState(1n, 'owner', '', 0, 1, 'deterministic'),
    /INVALID_NAME/,
  );
  assert.throws(
    () => createState(1n, 'owner', 'x', -1, 1, 'deterministic'),
    /INVALID_SEED/,
  );
  assert.throws(
    () => createState(1n, 'owner', 'x', 0, 0, 'deterministic'),
    /INVALID_TRAYS/,
  );
  assert.throws(
    () => createState(1n, 'owner', 'x', 0, 1, 'deterministic', -1n),
    /INVALID_BUDGET/,
  );
  const s = fresh();
  order(s, 'a', 'black_coffee', 0);
  setRunning(s, OWNER, true);
  closeArrivals(s, OWNER);
  advanceUntil(s, () => s.run.status === 'completed');
  assert.throws(() => order(s, 'b'), /RUN_COMPLETED/);
  assert.throws(() => setRunning(s, OWNER, true), /RUN_COMPLETED/);
});

test('invariant checks detect cross-run rows and malformed dependency links', () => {
  const s = fresh();
  const o = order(s);
  s.tasks[0]!.runId = 2n;
  assert.throws(() => assertInvariants(s), /CROSS_RUN_ROW/);
  s.tasks[0]!.runId = s.run.id;
  s.dependencies[0]!.predecessorId = 9_999_999n;
  assert.throws(() => assertInvariants(s), /INVALID_EDGE/);
  assert.equal(o.status, 'open');
});
