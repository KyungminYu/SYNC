import { expect, it } from 'vitest';
import { applyScenario, SCENARIOS, scenarioById } from './scenarioCatalog';
import { MENU } from './menu';

/** Three customers arriving 10 s apart, one black coffee each. */
const base = [0, 10, 20].map((arrival, i) => ({
  id: `c${i + 1}`,
  arrival,
  items: [MENU[0]],
}));

it('lists three fixed scenarios per level', () => {
  expect(SCENARIOS.map((s) => s.id)).toEqual([
    'Low-1', 'Low-2', 'Low-3', 'Mid-1', 'Mid-2', 'Mid-3', 'High-1', 'High-2', 'High-3',
  ]);
});

it('-1 speeds up arrivals only', () => {
  const out = applyScenario(scenarioById('Mid-1')!, base);
  expect(out.map((c) => c.arrival)).toEqual([0, 6.5, 13]);
  expect(out.every((c) => c.items.length === 1)).toBe(true);
});

it('-2 adds drinks only', () => {
  expect(applyScenario(scenarioById('Low-2')!, base).map((c) => c.items.length)).toEqual([2, 1, 1]);
  expect(applyScenario(scenarioById('High-2')!, base).map((c) => c.items.length)).toEqual([3, 3, 3]);
  expect(applyScenario(scenarioById('High-2')!, base).map((c) => c.arrival)).toEqual([0, 10, 20]);
});

it('-3 makes groups arrive together', () => {
  expect(applyScenario(scenarioById('Low-3')!, base).map((c) => c.arrival)).toEqual([0, 0, 20]);
});
