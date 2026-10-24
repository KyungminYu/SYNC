import { addCart } from '../src/domain/cartWorkflow.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../../apps/web/src/sync/mock/scenario.ts';
import {
  SCENARIOS,
  applyScenario,
} from '../../apps/web/src/sync/scenarioCatalog.ts';
import { menuByName, cartKeyFor } from '../../apps/web/src/sync/menu.ts';
import {
  createState,
  setPolicy,
  advance,
  closeArrivals,
  assertInvariants,
} from '../src/domain/engine.ts';
const owner = { identityHex: 'scenarios' };
for (const scenario of SCENARIOS)
  test(`${scenario.id}: identical arrivals complete under FCFS and primal-dual`, () => {
    const customers = applyScenario(
      scenario,
      simulate('baseline', { seed: 5 }).jobs,
    );
    const count = customers.reduce((n, c) => n + c.items.length, 0);
    assert.ok(count <= 100);
    for (const policy of ['fcfs', 'primal_dual'] as const) {
      const s = createState(
        1n,
        owner.identityHex,
        scenario.id,
        5,
        12,
        'deterministic',
      );
      setPolicy(s, owner, { policy });
      s.run.status = 'running';
      const arrivals = customers.map((c) => ({
        ...c,
        tick: Math.round(c.arrival) + 4,
      }));
      const last = Math.max(...arrivals.map((c) => c.tick));
      for (let tick = 0; tick < 3000 && s.run.status !== 'completed'; tick++) {
        for (const c of arrivals.filter((c) => c.tick === tick))
          addCart(s, owner, {
            cartKey: cartKeyFor(c.id, c.items),
            items: c.items.map((item) => ({
              recipe: menuByName(item.name)!.recipe,
              quantity: 1,
            })),
            deadlineInTicks: 86,
            value: 1,
            priority: 0,
            customerUseTicks: 0,
          });
        if (tick === last) closeArrivals(s, owner);
        advance(s);
      }
      assert.equal(s.run.status, 'completed');
      assert.equal(s.orders.length, count);
      assert.ok(s.orders.every((o) => o.status === 'cleaned'));
      assertInvariants(s);
    }
  });
