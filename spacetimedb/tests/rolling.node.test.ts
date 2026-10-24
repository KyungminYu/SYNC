import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  addOrder,
  setPolicy,
  setRunning,
  schedule,
  advance,
  closeArrivals,
  assertInvariants,
  setCapacity,
  setBudget,
  refreshReady,
} from '../src/domain/engine.ts';
import { RollingHorizonEngine } from '../src/domain/rollingHorizonEngine.ts';
const owner = { identityHex: 'owner' };
function fixture(
  count = 4,
  mode: 'deterministic' | 'claude' = 'deterministic',
) {
  const s = createState(1n, 'owner', 'primal dual', 42, 4, mode);
  setPolicy(s, owner, { policy: 'primal_dual' });
  for (let i = 0; i < count; i++)
    addOrder(s, owner, {
      externalKey: `o${i}`,
      recipe: 'latte',
      deadlineInTicks: 100,
      value: 10,
      priority: 1,
      customerUseTicks: 3,
    });
  refreshReady(s);
  return s;
}
test('rolling execution completes real DAGs and conserves all capacities', () => {
  const s = fixture();
  closeArrivals(s, owner);
  setRunning(s, owner, true);
  for (let i = 0; i < 500 && s.run.status !== 'completed'; i++) {
    advance(s);
    assertInvariants(s);
  }
  assert.equal(s.run.status, 'completed');
  assert.equal(s.reservations.length, 0);
  assert.equal(s.run.reservedMicrousd, 0n);
  assert.ok(s.decisions.every((d) => d.policy === 'primal_dual'));
});
test('same state does not replan; bounded timer and arrivals do', () => {
  const s = fixture(0);
  setRunning(s, owner, true);
  const count = s.planner[0]!.replanCount;
  schedule(s);
  advance(s);
  assert.equal(s.planner[0]!.replanCount, count);
  for (let i = 0; i < 7; i++) advance(s);
  assert.equal(s.planner[0]!.replanCount, count + 1n);
  addOrder(s, owner, {
    externalKey: 'new',
    recipe: 'latte',
    deadlineInTicks: 100,
    value: 10,
    priority: 1,
    customerUseTicks: 3,
  });
  schedule(s);
  assert.equal(s.planner[0]!.trigger, 'state_changed');
  assert.equal(s.planner[0]!.replanCount, count + 2n);
});
test('forecasts are advisory and dependent tasks never start predictively', () => {
  const s = fixture();
  setRunning(s, owner, true);
  const plan = JSON.parse(s.planner[0]!.planJson) as {
    taskId: string;
    startTick: number;
  }[];
  assert.ok(plan.some((p) => p.startTick > s.run.tick));
  for (const p of plan.filter((p) => p.startTick > s.run.tick))
    assert.equal(
      s.tasks.find((t) => t.id === BigInt(p.taskId))!.status,
      'ready',
    );
  for (const d of s.dependencies)
    if (s.tasks.find((t) => t.id === d.predecessorId)!.status !== 'succeeded')
      assert.equal(
        s.tasks.find((t) => t.id === d.successorId)!.status,
        'blocked',
      );
});
test('scarcity prices warm start durably, deterministic from the same snapshot', () => {
  const a = fixture(8),
    b = structuredClone(a);
  const engine = new RollingHorizonEngine();
  assert.deepEqual(engine.plan(a), engine.plan(b));
  assert.ok(
    Object.values(
      JSON.parse(a.planner[0]!.pricesJson) as Record<string, number>,
    ).some((v) => v > 0),
  );
  const restored = structuredClone(a);
  restored.run.tick = 8;
  engine.plan(restored);
  assert.equal(restored.planner[0]!.replanCount, 2n);
  assert.ok(
    Object.keys(JSON.parse(restored.planner[0]!.pricesJson)).every(
      (k) => !k.endsWith(':0'),
    ),
  );
});
test('budget feasibility retains bigint precision beyond Number.MAX_SAFE_INTEGER', () => {
  const s = fixture(2);
  const ready = s.tasks.filter((t) => t.status === 'ready');
  assert.equal(ready.length, 2);
  for (const t of ready) t.estimatedCostMicrousd = 9007199254740993n;
  s.run.budgetMicrousd = 18014398509481985n;
  setRunning(s, owner, true);
  assert.equal(s.tasks.filter((t) => t.status === 'running').length, 1);
  assert.equal(s.run.reservedMicrousd, 9007199254740993n);
});
test('capacity and budget edits protect active reservations and require control', () => {
  const s = fixture();
  setRunning(s, owner, true);
  const held = s.reservations[0]!;
  assert.throws(
    () => setCapacity(s, owner, held.resourceId, 0),
    /CAPACITY_BELOW/,
  );
  assert.throws(() => setBudget(s, owner, 0n), /INVALID_BUDGET/);
  assert.throws(() =>
    setCapacity(s, { identityHex: 'stranger' }, held.resourceId, 10),
  );
  const count = s.planner[0]!.replanCount;
  setCapacity(s, owner, held.resourceId, 4);
  assert.equal(s.planner[0]!.replanCount, count + 1n);
});
test('unconfirmed external jobs retain worker and resource capacity across horizons', () => {
  const s = fixture(4, 'claude');
  setRunning(s, owner, true);
  const held = s.reservations.map((r) => r.key);
  const jobs = s.jobs.length;
  for (let i = 0; i < 30; i++) advance(s);
  assert.deepEqual(
    s.reservations.map((r) => r.key),
    held,
  );
  assert.equal(s.jobs.length, jobs);
  assertInvariants(s);
});
test('simultaneous resource dimensions and duplicate requirements are aggregated', () => {
  const s = fixture(1);
  const task = s.tasks.find((t) => t.status === 'ready')!;
  const req = s.requirements.find((r) => r.taskId === task.id)!;
  s.requirements.push({ ...req, id: 99999n, key: '1:99999', units: 3 });
  setRunning(s, owner, true);
  assert.equal(s.decisions.length, 0);
});

test('two different resource dimensions jointly limit immediate assignments', () => {
  const s = fixture(4);
  const ready = s.tasks.filter((t) => t.status === 'ready');
  const shared = s.resources.find((r) => r.role === 'cleaner')!;
  shared.capacity = 1;
  for (const [i, task] of ready.entries())
    s.requirements.push({
      id: 100000n + BigInt(i),
      key: `1:${100000 + i}`,
      runId: 1n,
      taskId: task.id,
      resourceId: shared.id,
      units: 1,
    });
  setRunning(s, owner, true);
  assert.equal(s.tasks.filter((t) => t.status === 'running').length, 1);
  assert.equal(
    s.reservations.filter((r) => r.resourceId === shared.id).length,
    1,
  );
  assertInvariants(s);
});
