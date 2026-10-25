import { expect, it } from 'vitest';
import { applyScenario, MEAN_GAP, SCENARIOS, scenarioById } from './scenarioCatalog';
import { MENU } from './menu';

/** 24 customers arriving 5 s apart, one black coffee each. */
const base = Array.from({ length: 24 }, (_, i) => ({
  id: `c${i + 1}`,
  arrival: i * 5,
  items: [MENU[0]],
}));

it('ranks the nine scenarios by drinks, fewer customers first on a tie', () => {
  expect(SCENARIOS.map((s) => [s.id, s.customers, s.maxDrinks, s.drinks])).toEqual([
    ['Low-1', 16, 1, 16],
    ['Low-2', 20, 1, 20],
    ['Low-3', 16, 2, 24],
    ['Mid-1', 24, 1, 24],
    ['Mid-2', 20, 2, 30],
    ['Mid-3', 16, 3, 32],
    ['High-1', 24, 2, 36],
    ['High-2', 20, 3, 40],
    ['High-3', 24, 3, 48],
  ]);
});

it('gives each scenario its customers and exactly its drinks', () => {
  for (const def of SCENARIOS) {
    const customers = applyScenario(def, base);
    expect(customers).toHaveLength(def.customers);
    const sizes = customers.map((c) => c.items.length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(def.drinks);
    expect(Math.max(...sizes)).toBe(def.maxDrinks);
    expect(Math.min(...sizes)).toBe(1);
  }
});

it('spaces arrivals at random intervals, the same on every run', () => {
  const def = scenarioById('High-2')!;
  const a = applyScenario(def, base);
  const times = a.map((c) => c.arrival);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  expect(times[0]).toBe(0);
  expect(times.at(-1)).toBeCloseTo((def.customers - 1) * MEAN_GAP, 0);
  expect(gaps.every((g) => g >= 0)).toBe(true);
  // Not a fixed pace: some customers bunch up, others come after a lull.
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(MEAN_GAP);
  expect(a.map((c) => c.id)).toEqual(base.slice(0, 20).map((c) => c.id));
  expect(applyScenario(def, base)).toEqual(a);
});
