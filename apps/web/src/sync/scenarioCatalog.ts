import type { OrderItem } from './contract';
import { MENU } from './menu';

/**
 * Fixed live scenarios, ranked by how many drinks the shop must make.
 *
 * Each scenario is a number of customers (12 / 16 / 20) and an order size
 * (1 drink each, 1–2, or 1–3). The nine combinations are sorted by total
 * drinks; on a tie the one with fewer customers is easier. Arrivals keep the
 * mock's pace (the first customers of the mock scenario), so more customers
 * also means a longer stream of arrivals. Values live only here
 * (design doc §7).
 */

/** Load levels, lightest first (also the dropdown group order). */
export const LOADS = ['Low', 'Mid', 'High'] as const;
export type Load = (typeof LOADS)[number];

export interface ScenarioDef {
  /** "Mid-2": also the engine run-name prefix. */
  id: string;
  load: Load;
  n: 1 | 2 | 3;
  /** Customers who come in. */
  customers: number;
  /** Most drinks one customer orders (1 = one each, 2 = 1–2, 3 = 1–3). */
  maxDrinks: 1 | 2 | 3;
  /** Drinks the shop must make (exact). */
  drinks: number;
  /** One line for the dropdown. */
  description: string;
}

/** Drinks per customer: as even a split of 1..maxDrinks as possible. */
function drinkCounts(customers: number, maxDrinks: number): number[] {
  const base = Math.floor(customers / maxDrinks);
  const extra = customers % maxDrinks;
  // Leftover customers keep the average at (1 + maxDrinks) / 2: an odd one
  // takes the middle size, pairs take the two ends (1 and maxDrinks), …
  const bonus = new Set<number>();
  let left = extra;
  if (left % 2 === 1 && maxDrinks % 2 === 1) {
    bonus.add((maxDrinks + 1) / 2);
    left--;
  }
  for (let lo = 1, hi = maxDrinks; left >= 2 && lo < hi; lo++, hi--) {
    bonus.add(lo).add(hi);
    left -= 2;
  }
  const counts: number[] = [];
  for (let k = 1; k <= maxDrinks; k++) {
    const n = base + (bonus.has(k) ? 1 : 0);
    for (let i = 0; i < n; i++) counts.push(k);
  }
  return counts;
}

const SIZE_TEXT = { 1: '1 drink each', 2: '1–2 drinks', 3: '1–3 drinks' } as const;

/** Every customers × order-size pair, ranked by drinks (ties: fewer customers). */
export const SCENARIOS: ScenarioDef[] = ([12, 16, 20] as const)
  .flatMap((customers) =>
    ([1, 2, 3] as const).map((maxDrinks) => {
      const drinks = drinkCounts(customers, maxDrinks).reduce((a, b) => a + b, 0);
      return { customers, maxDrinks, drinks };
    }),
  )
  .sort((a, b) => a.drinks - b.drinks || a.customers - b.customers)
  .map((s, i) => {
    const load = LOADS[Math.floor(i / 3)];
    const n = ((i % 3) + 1) as 1 | 2 | 3;
    return {
      ...s,
      id: `${load}-${n}`,
      load,
      n,
      description: `${s.customers} customers · ${SIZE_TEXT[s.maxDrinks]} (${s.drinks} drinks)`,
    };
  });

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id);

/** A customer of a scenario: door time in seconds and the drinks ordered. */
export interface ScenarioCustomer {
  id: string;
  arrival: number;
  items: OrderItem[];
}

/** Small deterministic PRNG, so a scenario is the same on every run. */
function rng(seed: number) {
  let n = seed >>> 0 || 1;
  return () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n / 4294967296;
  };
}

/**
 * The scenario's customers: the first `def.customers` of `base` (their ids
 * and arrival times), each ordering their share of drinks. Who orders how
 * many, and which drinks, is shuffled with `seed` (fixed per scenario).
 */
export function applyScenario(
  def: ScenarioDef,
  base: ScenarioCustomer[],
  seed = 5,
): ScenarioCustomer[] {
  const random = rng(seed * 101 + def.customers * 7 + def.maxDrinks);
  const counts = drinkCounts(def.customers, def.maxDrinks);
  // Fisher–Yates shuffle so big orders are spread over the arrivals.
  for (let i = counts.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [counts[i], counts[j]] = [counts[j], counts[i]];
  }
  return base.slice(0, def.customers).map((c, i) => ({
    id: c.id,
    arrival: c.arrival,
    items: Array.from(
      { length: counts[i] },
      () => MENU[Math.floor(random() * MENU.length)],
    ),
  }));
}
