import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  setPolicy,
  setRunning,
  advance,
  assertInvariants,
  closeArrivals,
  setMember,
  claimJob,
  submitAction,
} from '../src/domain/engine.ts';
import { addCart, taskOrders } from '../src/domain/cartWorkflow.ts';
import {
  requestCancellation,
  reportJobResult,
} from '../src/domain/externalExecution.ts';
const owner = { identityHex: 'owner' },
  service = { identityHex: 'service' };
function fixture(mode: 'deterministic' | 'claude' = 'deterministic') {
  const s = createState(1n, 'owner', 'cart test', 42, 2, mode);
  setPolicy(s, owner, { policy: 'primal_dual' });
  return s;
}
const cart = (cartKey: string, quantity = 5) => ({
  cartKey,
  items: [{ recipe: 'latte' as const, quantity }],
  deadlineInTicks: 100,
  value: 2,
  priority: 1,
  customerUseTicks: 2,
});
test('five duplicate drinks remain five orders with a single joined handoff and finite recycling', () => {
  const s = fixture();
  assert.equal(s.workers.filter((w) => w.enabled).length, 4);
  const id = addCart(s, owner, cart('first'));
  assert.equal(addCart(s, owner, cart('first')), id);
  addCart(s, owner, cart('second', 3));
  assert.equal(s.orders.length, 8);
  assert.equal(s.recipes.length, 1);
  assert.equal(s.tasks.filter((t) => t.kind === 'deliver_order').length, 2);
  closeArrivals(s, owner);
  setRunning(s, owner, true);
  let peak = 4;
  for (let i = 0; i < 500 && s.run.status !== 'completed'; i++) {
    advance(s);
    assertInvariants(s);
    peak = Math.max(peak, s.workers.filter((w) => w.enabled).length);
  }
  assert.equal(
    s.run.status,
    'completed',
    JSON.stringify(
      s.tasks.filter((t) => t.status !== 'succeeded'),
      (_k, v) => (typeof v === 'bigint' ? String(v) : v),
    ),
  );
  assert.ok(peak > 4 && peak <= 7);
  assert.equal(s.workers.filter((w) => w.enabled).length, 4);
  assert.ok(s.utensils.every((u) => u.state === 'clean'));
  assert.ok(s.trays.every((t) => t.state === 'clean'));
  for (const c of s.carts) {
    const orders = s.orders.filter((o) => o.cartId === c.id);
    assert.equal(new Set(orders.map((o) => o.deliveredTick)).size, 1);
  }
  assert.ok(
    s.tasks.some(
      (t) => t.kind === 'prepare_coffee' && taskOrders(s, t).length > 1,
    ),
  );
});
test('external execution never finishes on a predicted clock and cancellation is fenced', () => {
  const s = fixture('claude');
  addCart(s, owner, cart('external', 1));
  setMember(s, owner, service.identityHex, 'service', true);
  setRunning(s, owner, true);
  const job = s.jobs[0];
  claimJob(s, service, job.id);
  submitAction(s, service, job.id, job.attempt, job.expectedAction);
  for (let i = 0; i < 20; i++) advance(s);
  const t = s.tasks.find((t) => t.id === job.taskId)!;
  assert.equal(t.status, 'running');
  const held = s.reservations.length;
  requestCancellation(s, owner, job.id);
  assert.equal(s.reservations.length, held);
  assert.throws(() =>
    reportJobResult(
      s,
      { identityHex: 'stranger' },
      job.id,
      job.attempt,
      'stopped',
    ),
  );
  reportJobResult(s, service, job.id, job.attempt, 'stopped');
  assert.equal(job.status, 'cancelled');
  reportJobResult(s, service, job.id, job.attempt, 'stopped');
  assert.throws(() =>
    reportJobResult(s, service, job.id, job.attempt, 'completed'),
  );
  assert.ok(s.run.modeledSpentMicrousd > 0n);
  assertInvariants(s);
});
test('uncertain worker effects retain all capacity until owner reconciliation', () => {
  const s = fixture('claude');
  addCart(s, owner, cart('external', 1));
  setMember(s, owner, service.identityHex, 'service', true);
  setRunning(s, owner, true);
  const job = s.jobs[0];
  claimJob(s, service, job.id);
  submitAction(s, service, job.id, job.attempt, job.expectedAction);
  const reserved = s.run.reservedMicrousd;
  reportJobResult(s, service, job.id, job.attempt, 'uncertain');
  for (let i = 0; i < 40; i++) advance(s);
  assert.equal(s.run.reservedMicrousd, reserved);
  assert.equal(s.tasks.find((t) => t.id === job.taskId)!.status, 'uncertain');
  assertInvariants(s);
});
