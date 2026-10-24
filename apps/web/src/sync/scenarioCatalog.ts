import type { OrderItem } from './contract';
import { MENU } from './menu';

/**
 * Fixed live scenarios: three per load level, each turning up one lever of
 * difficulty on the same customers (mock scenario, seed 5). The values are
 * provisional and live only here (design doc §7).
 *   -1 speed  — customers arrive faster (arrival times × factor)
 *   -2 volume — customers order more drinks
 *   -3 stream — customers arrive back to back in groups (one every STREAM_GAP s)
 * Deadlines, recipes and the menu are unchanged.
 */

/** Load levels, lightest first (also the dropdown group order). */
export const LOADS = ['Low', 'Mid', 'High'] as const;
export type Load = (typeof LOADS)[number];

export interface ScenarioDef {
  /** "Mid-2": also the engine run-name prefix. */
  id: string;
  load: Load;
  n: 1 | 2 | 3;
  /** One line for the dropdown. */
  description: string;
  /** Arrival times × this (1 = unchanged). */
  arrivalFactor: number;
  /** Extra drinks per customer, as [share of customers, drinks added]. */
  extraDrinks: [number, number];
  /** Customers per back-to-back stream (1 = arrivals unchanged). */
  groupSize: number;
}

/** Seconds between customers within one stream: they keep coming, never all at once. */
export const STREAM_GAP = 2;

const BASE = { arrivalFactor: 1, extraDrinks: [0, 0] as [number, number], groupSize: 1 };
/** Lever strength per level: speed factor, extra drinks, group size. */
const LEVELS: Record<Load, { speed: number; drinks: [number, number]; group: number }> = {
  Low: { speed: 0.85, drinks: [1 / 3, 1], group: 2 },
  Mid: { speed: 0.65, drinks: [1, 1], group: 4 },
  High: { speed: 0.45, drinks: [1, 2], group: 6 },
};

export const SCENARIOS: ScenarioDef[] = LOADS.flatMap((load) => {
  const l = LEVELS[load];
  const drinks =
    l.drinks[0] < 1
      ? `1 in ${Math.round(1 / l.drinks[0])} +${l.drinks[1]}`
      : `all +${l.drinks[1]}`;
  return [
    { ...BASE, id: `${load}-1`, load, n: 1 as const, description: `Faster arrivals ×${l.speed}`, arrivalFactor: l.speed },
    { ...BASE, id: `${load}-2`, load, n: 2 as const, description: `More drinks: ${drinks}`, extraDrinks: l.drinks },
    { ...BASE, id: `${load}-3`, load, n: 3 as const, description: `Back-to-back streams of ${l.group} (${STREAM_GAP} s apart)`, groupSize: l.group },
  ];
});

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id);

/** A customer of a scenario: door time in seconds and the drinks ordered. */
export interface ScenarioCustomer {
  id: string;
  arrival: number;
  items: OrderItem[];
}

/** Applies a scenario's levers to the base customers (deterministic). */
export function applyScenario(def: ScenarioDef, base: ScenarioCustomer[]): ScenarioCustomer[] {
  const [share, add] = def.extraDrinks;
  return base.map((c, i) => {
    // A stream starts when its first customer would have come; the rest
    // follow one after another, STREAM_GAP seconds apart.
    const first = Math.floor(i / def.groupSize) * def.groupSize;
    const lead = base[first];
    // Every (1/share)-th customer gets the extra drinks, alternating through the menu.
    const extra = share > 0 && i % Math.round(1 / share) === 0 ? add : 0;
    return {
      id: c.id,
      arrival:
        Math.round((lead.arrival * def.arrivalFactor + (i - first) * STREAM_GAP) * 100) / 100,
      items: [
        ...c.items,
        ...Array.from({ length: extra }, (_, k) => MENU[(i + k) % MENU.length]),
      ],
    };
  });
}
