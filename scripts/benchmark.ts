import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  createState,
  setPolicy,
  advance,
  closeArrivals,
  assertInvariants,
} from '../spacetimedb/src/domain/engine.ts';
import { addCart } from '../spacetimedb/src/domain/cartWorkflow.ts';
import {
  evaluateRun,
  REWARD_WEIGHTS,
} from '../spacetimedb/src/domain/reward.ts';
import { installPlanningProbe } from '../spacetimedb/src/domain/planningProbe.ts';
import { simulate } from '../apps/web/src/sync/mock/scenario.ts';
import {
  SCENARIOS,
  applyScenario,
} from '../apps/web/src/sync/scenarioCatalog.ts';
import { menuByName } from '../apps/web/src/sync/menu.ts';
const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const seeds = flag('--seeds', '5,17,29')
  .split(/[,\s]+/)
  .map(Number);
const selected = flag('--scenario', 'all');
if (
  seeds.some((s) => !Number.isSafeInteger(s) || s < 0) ||
  !SCENARIOS.some((s) => selected === 'all' || s.id === selected)
)
  throw new Error('Invalid seed or scenario');
const results: unknown[] = [];
let timings: number[] = [];
installPlanningProbe((compute) => {
  const start = performance.now();
  try {
    return compute();
  } finally {
    timings.push(performance.now() - start);
  }
});
for (const seed of seeds)
  for (const scenario of SCENARIOS.filter(
    (s) => selected === 'all' || s.id === selected,
  )) {
    const customers = applyScenario(
      scenario,
      simulate('baseline', { seed }).jobs,
    );
    for (const policy of ['fcfs', 'primal_dual'] as const) {
      timings = [];
      const owner = { identityHex: 'benchmark' };
      const s = createState(
        1n,
        owner.identityHex,
        scenario.id,
        seed,
        12,
        'deterministic',
      );
      setPolicy(s, owner, { policy });
      s.run.status = 'running';
      let activeTicks = 0;
      const start = performance.now();
      const arrivals = customers.map((c) => ({
        ...c,
        tick: Math.round(c.arrival) + 4,
      }));
      const last = Math.max(...arrivals.map((c) => c.tick));
      for (
        let tick = 0;
        tick < 3000 && String(s.run.status) !== 'completed';
        tick++
      ) {
        for (const c of arrivals.filter((c) => c.tick === tick))
          addCart(s, owner, {
            cartKey: c.id,
            items: c.items.map((i) => ({
              recipe: menuByName(i.name)!.recipe,
              quantity: 1,
            })),
            deadlineInTicks: 86,
            value: 1,
            priority: 0,
            customerUseTicks: 0,
          });
        if (tick === last) closeArrivals(s, owner);
        advance(s);
        assertInvariants(s);
        if (s.run.tick <= 420)
          activeTicks += s.workers.filter((w) => w.enabled).length;
      }
      const totalMs = performance.now() - start;
      const planningMs = timings.reduce((n, t) => n + t, 0);
      const sorted = [...timings].sort((a, b) => a - b);
      results.push({
        scenario: scenario.id,
        seed,
        policy,
        status: s.run.status,
        drinks: s.orders.length,
        makespanTicks: s.run.tick,
        wallMs: totalMs,
        optimizerCalls: timings.length,
        optimizerTotalMs: planningMs,
        optimizerP95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        optimizerOverheadFraction: planningMs / totalMs,
        ...evaluateRun(s, 420, activeTicks, planningMs),
      });
      console.info(
        `${scenario.id} seed=${seed} ${policy}: ${s.run.status}, ${s.run.tick} ticks, planner=${planningMs.toFixed(1)}ms`,
      );
    }
  }
mkdirSync('.local/benchmarks', { recursive: true });
writeFileSync(
  '.local/benchmarks/latest.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runtime: process.version,
      weights: REWARD_WEIGHTS,
      notes:
        'Local deterministic engine timings, not Maincloud reducer latency. Execution costs are modeled. Same arrivals, four initial workers and seven-slot limit; SYNC can activate extra slots, charged per active worker tick. No competitive-ratio or optimality guarantee.',
      results,
    },
    null,
    2,
  ),
);
