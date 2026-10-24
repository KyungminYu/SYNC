import type { State, Run, Base } from '../domain/model.ts';
import { STATE_TABLES } from '../domain/model.ts';
// This explicit port keeps domain code host-independent. The adapter is the only
// structural cast boundary; tables.ts is the matching wire schema. No host mocks
// are represented as proof of SpacetimeDB transaction/subscription behavior.
type ChildName = (typeof STATE_TABLES)[number];
type Child<K extends ChildName> = State[K][number];
export type ReadTable<T> = {
  runId: {
    filter(id: bigint): Iterable<T>;
  };
  key: {
    find(key: string): T | undefined;
  };
};
export type ReadDb = {
  run: {
    id: {
      find(id: bigint): Run | undefined;
    };
    ownerIdentityHex: {
      filter(hex: string): Iterable<Run>;
    };
  };
} & {
  [K in ChildName]: ReadTable<Child<K>>;
};
type MutableTable<T extends Base> = ReadTable<T> & {
  insert(row: T): T;
  key: ReadTable<T>['key'] & {
    update(row: T): boolean;
    delete(key: string): boolean;
  };
};
export type MutableDb = {
  run: {
    insert(row: Run): Run;
    id: {
      find(id: bigint): Run | undefined;
      update(row: Run): boolean;
    };
    ownerIdentityHex: {
      filter(hex: string): Iterable<Run>;
    };
  };
} & {
  [K in ChildName]: MutableTable<Child<K>>;
};
export function load(store: ReadDb, runId: bigint): State {
  const row = store.run.id.find(runId);
  if (!row) throw new Error('RUN_NOT_FOUND');
  const state = { run: { ...row } } as State;
  for (const table of STATE_TABLES) {
    // Host returns detached product values; clone small array columns too.
    const rows = [...store[table].runId.filter(runId)].map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
      ),
    );
    rows.sort((a, b) => ((a.id as bigint) < (b.id as bigint) ? -1 : 1));
    Object.assign(state, { [table]: rows });
  }
  return state;
}
const signature = (row: unknown): string =>
  JSON.stringify(row, (_k, v) =>
    typeof v === 'bigint' ? { $bigint: v.toString() } : v,
  );
function saveTable<T extends Base>(
  table: MutableTable<T>,
  rows: T[],
  runId: bigint,
): void {
  const ids = new Set(rows.map((r) => r.key));
  for (const old of [...table.runId.filter(runId)])
    if (!ids.has(old.key)) table.key.delete(old.key);
  for (const row of rows) {
    const old = table.key.find(row.key);
    if (!old) table.insert(row);
    else if (signature(old) !== signature(row)) table.key.update(row);
  }
}
export function save(store: MutableDb, state: State): void {
  store.run.id.update(state.run);
  saveTable(store.taskItems, state.taskItems, state.run.id);
  saveTable(store.utensils, state.utensils, state.run.id);
  saveTable(store.planner, state.planner, state.run.id);
  // Explicit calls preserve row/table correlation under strict TypeScript.
  saveTable(store.members, state.members, state.run.id);
  saveTable(store.carts, state.carts, state.run.id);
  saveTable(store.recipes, state.recipes, state.run.id);
  saveTable(store.orders, state.orders, state.run.id);
  saveTable(store.tasks, state.tasks, state.run.id);
  saveTable(store.dependencies, state.dependencies, state.run.id);
  saveTable(store.workers, state.workers, state.run.id);
  saveTable(store.resources, state.resources, state.run.id);
  saveTable(store.requirements, state.requirements, state.run.id);
  saveTable(store.reservations, state.reservations, state.run.id);
  saveTable(store.trays, state.trays, state.run.id);
  saveTable(store.jobs, state.jobs, state.run.id);
  saveTable(store.decisions, state.decisions, state.run.id);
  saveTable(store.events, state.events, state.run.id);
  saveTable(store.telemetry, state.telemetry, state.run.id);
}
export type ViewDb = ReadDb & {
  members: ReadTable<State['members'][number]> & {
    identityHex: {
      filter(hex: string): Iterable<State['members'][number]>;
    };
  };
};
export function readableRuns(store: ViewDb, identityHex: string): Run[] {
  const map = new Map<bigint, Run>();
  for (const r of store.run.ownerIdentityHex.filter(identityHex))
    map.set(r.id, r);
  for (const m of store.members.identityHex.filter(identityHex)) {
    if (!m.enabled || m.permission === 'service') continue;
    const r = store.run.id.find(m.runId);
    if (r) map.set(r.id, r);
  }
  return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
export function serviceRuns(store: ViewDb, identityHex: string): Run[] {
  const ids = new Set<bigint>();
  for (const m of store.members.identityHex.filter(identityHex))
    if (m.enabled && m.permission === 'service') ids.add(m.runId);
  return [...ids].flatMap((id) => {
    const r = store.run.id.find(id);
    return r ? [r] : [];
  });
}
