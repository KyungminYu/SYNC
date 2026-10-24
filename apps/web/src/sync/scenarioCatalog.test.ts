import { expect, it } from 'vitest';
import { applyScenario, SCENARIOS, scenarioById } from './scenarioCatalog';
import { MENU } from './menu';

/** 20 customers arriving 5 s apart, one black coffee each. */
const base = Array.from({ length: 20 }, (_, i) => ({
  id: `c${i + 1}`,
  arrival: i * 5,
  items: [MENU[0]],
}));

it('ranks the nine scenarios by drinks, fewer customers first on a tie', () => {
  expect(SCENARIOS.map((s) => [s.id, s.customers, s.maxDrinks, s.drinks])).toEqual([
    ['Low-1', 12, 1, 12],
    ['Low-2', 16, 1, 16],
    ['Low-3', 12, 2, 18],
    ['Mid-1', 20, 1, 20],
    ['Mid-2', 12, 3, 24],
    ['Mid-3', 16, 2, 24],
    ['High-1', 20, 2, 30],
    ['High-2', 16, 3, 32],
    ['High-3', 20, 3, 40],
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

it('keeps the base arrivals and is the same on every run', () => {
  const def = scenarioById('High-2')!;
  const a = applyScenario(def, base);
  expect(a.map((c) => c.arrival)).toEqual(base.slice(0, 16).map((c) => c.arrival));
  expect(applyScenario(def, base)).toEqual(a);
});
