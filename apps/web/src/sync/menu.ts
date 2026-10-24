import type { OrderItem } from './contract';

/**
 * Coffee-shop menu shared by every adapter: display name, difficulty, and the
 * SYNC engine recipe that makes it (docs/LIVE_SPACETIMEDB_DESIGN.md §2).
 *
 * The shop sells two drinks, black coffee and latte, one per engine recipe.
 * A new drink is one more row here (plus its recipe in the engine).
 */
export interface MenuEntry extends OrderItem {
  /** Stable id used on the wire (cart keys), e.g. "latte". */
  id: string;
  /** Engine recipe id (`enqueue_order.recipe`). */
  recipe: 'black_coffee' | 'latte';
}

export const MENU_TABLE: MenuEntry[] = [
  {
    id: 'black_coffee',
    name: 'Black coffee',
    complexity: 'simple',
    recipe: 'black_coffee',
  },
  { id: 'latte', name: 'Latte', complexity: 'medium', recipe: 'latte' },
];

/** Menu as plain order items (name + difficulty), in menu order. */
export const MENU: OrderItem[] = MENU_TABLE.map(({ name, complexity }) => ({
  name,
  complexity,
}));

/** Lookup by display name (mock items) or by wire id (live cart keys). */
export const menuByName = (name: string) =>
  MENU_TABLE.find((m) => m.name === name);
export const menuById = (id: string) => MENU_TABLE.find((m) => m.id === id);

/**
 * Cart key carrying the customer id and their drinks in order, e.g.
 * "c7:latte+black_coffee". The engine treats it as an opaque cart id; the live
 * adapter reads the drinks back from it because `ui_orders` has only recipes.
 */
export function cartKeyFor(customerId: string, items: OrderItem[]) {
  const ids = items.map((i) => menuByName(i.name)?.id ?? 'unknown');
  return `${customerId}:${ids.join('+')}`;
}

/** Inverse of cartKeyFor. Unknown drink ids come back as plain names. */
export function parseCartKey(key: string): {
  customerId: string;
  items: OrderItem[];
} {
  const [customerId, spec = ''] = key.split(':');
  const items = spec
    .split('+')
    .filter(Boolean)
    .map(
      (id): OrderItem => {
        const m = menuById(id);
        return m
          ? { name: m.name, complexity: m.complexity }
          : { name: id, complexity: 'medium' };
      },
    );
  return { customerId, items };
}
