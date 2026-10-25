import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, addOrder, setMember } from '../src/domain/engine.ts';
import { load, save, readableRuns, serviceRuns } from '../src/runtime/store.ts';
import { STATE_TABLES } from '../src/domain/model.ts';
import type { State } from '../src/domain/model.ts';
import type { MutableDb, ViewDb } from '../src/runtime/store.ts';

// Only tests the explicit persistence/access port, not host transaction isolation.
function memoryPort(states: State[]) {
  const runRows = new Map(
    states.map((s) => [s.run.id, structuredClone(s.run)]),
  );
  const counters = { writes: 0, childFinds: 0 };
  const store: Record<string, unknown> = {
    run: {
      id: {
        find: (id: bigint) => structuredClone(runRows.get(id)),
        update: (row: State['run']) => {
          runRows.set(row.id, structuredClone(row));
          counters.writes++;
          return true;
        },
      },
      ownerIdentityHex: {
        filter: (hex: string) =>
          [...runRows.values()]
            .filter((r) => r.ownerIdentityHex === hex)
            .map((r) => structuredClone(r)),
      },
      status: {
        filter: (status: string) =>
          [...runRows.values()]
            .filter((r) => r.status === status)
            .map((r) => structuredClone(r)),
      },
    },
  };
  for (const name of STATE_TABLES) {
    const rows = new Map(
      states
        .flatMap((s) => s[name])
        .map((row) => [row.key, structuredClone(row)]),
    );
    store[name] = {
      key: {
        find: (key: string) => {
          counters.childFinds++;
          return structuredClone(rows.get(key));
        },
        update: (row: { key: string }) => {
          rows.set(row.key, structuredClone(row));
          counters.writes++;
          return true;
        },
        delete: (key: string) => {
          counters.writes++;
          return rows.delete(key);
        },
      },
      runId: {
        filter: (id: bigint) =>
          [...rows.values()]
            .filter((r) => r.runId === id)
            .map((r) => structuredClone(r)),
      },
      identityHex: {
        filter: (hex: string) =>
          [...rows.values()]
            .filter((r) => 'identityHex' in r && r.identityHex === hex)
            .map((r) => structuredClone(r)),
      },
      insert: (row: { key: string }) => {
        assert.equal(rows.has(row.key), false);
        rows.set(row.key, structuredClone(row));
        counters.writes++;
        return row;
      },
    };
  }
  return { store: store as unknown as MutableDb & ViewDb, counters };
}
const owner = { identityHex: 'alice' };
function fresh(id = 1n) {
  return createState(id, owner.identityHex, 'Cafe', 1, 2, 'deterministic');
}
test('persistence port stores new DAG rows and keeps another run untouched', () => {
  const a = fresh(),
    b = fresh(2n);
  const { store } = memoryPort([a, b]);
  const before = load(store, 2n);
  const s = load(store, 1n);
  addOrder(s, owner, {
    externalKey: 'o1',
    recipe: 'latte',
    deadlineInTicks: 60,
    value: 10,
    priority: 1,
    customerUseTicks: 3,
  });
  save(store, s);
  assert.equal(load(store, 1n).tasks.length, 10);
  assert.deepEqual(load(store, 2n), before);
});
test('saving an unchanged state does not rewrite every child row', () => {
  const { store, counters } = memoryPort([fresh()]);
  save(store, load(store, 1n));
  assert.equal(counters.writes, 0); // no run invalidation or child row writes
  assert.equal(counters.childFinds, 0); // indexed scan is reused for comparisons
});

test('persistence detects in-place array edits and deleted rows without rewriting the run', () => {
  const { store, counters } = memoryPort([fresh()]);
  const state = load(store, 1n);
  state.workers[0]!.capabilities.push('new-capability');
  const removed = state.workers.pop()!;
  save(store, state);
  assert.equal(counters.writes, 2);
  const after = load(store, 1n);
  assert.ok(after.workers[0]!.capabilities.includes('new-capability'));
  assert.ok(!after.workers.some((w) => w.id === removed.id));
});
test('indexed readable runs enforce owner/viewer/operator isolation and exclude service membership', () => {
  const a = fresh(),
    b = createState(2n, 'bob', 'Bob', 1, 1, 'deterministic');
  setMember(a, owner, 'viewer', 'viewer', true);
  setMember(a, owner, 'operator', 'operator', true);
  setMember(a, owner, 'service', 'service', true);
  const { store } = memoryPort([a, b]);
  assert.deepEqual(readableRuns(store, 'stranger'), []);
  assert.deepEqual(
    readableRuns(store, 'alice').map((r) => r.id),
    [1n],
  );
  assert.deepEqual(
    readableRuns(store, 'bob').map((r) => r.id),
    [2n],
  );
  assert.deepEqual(
    readableRuns(store, 'viewer').map((r) => r.id),
    [1n],
  );
  assert.deepEqual(
    readableRuns(store, 'operator').map((r) => r.id),
    [1n],
  );
  assert.deepEqual(readableRuns(store, 'service'), []);
  assert.deepEqual(
    serviceRuns(store, 'service').map((r) => r.id),
    [1n],
  );
  assert.deepEqual(serviceRuns(store, 'alice'), []);
});
test('completed runs are readable by every identity, unfinished ones stay private', () => {
  const done = fresh(),
    open = createState(2n, 'bob', 'Bob', 1, 1, 'deterministic');
  done.run.status = 'completed';
  const { store } = memoryPort([done, open]);
  assert.deepEqual(
    readableRuns(store, 'stranger').map((r) => r.id),
    [1n],
  );
  assert.deepEqual(
    readableRuns(store, 'bob').map((r) => r.id),
    [1n, 2n],
  );
});
test('revoked membership immediately stops readable-run access', () => {
  const s = fresh();
  setMember(s, owner, 'viewer', 'viewer', true);
  const { store } = memoryPort([s]);
  setMember(s, owner, 'viewer', 'viewer', false);
  save(store, s);
  assert.deepEqual(readableRuns(store, 'viewer'), []);
});
