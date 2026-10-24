import { expect, it } from 'vitest';
import { MOCK_SCENARIO_ID, SampleSyncSource } from './SampleSyncSource';
import { parseRunName, runName } from './live/scenarioNames';
import type { SyncSnapshot, SyncSource } from './source';

/** A source whose snapshot the test sets by hand. */
function manual(origin: SyncSource['origin'], first: SyncSnapshot) {
  let snap = first;
  const listeners = new Set<() => void>();
  return {
    origin,
    delivery: 'replay' as const,
    picked: '',
    connect() {},
    disconnect() {},
    selectScenario(id: string) {
      this.picked = id;
    },
    getSnapshot: () => snap,
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    push(next: SyncSnapshot) {
      snap = next;
      for (const l of listeners) l();
    },
  };
}

const run = (id: string) =>
  ({ run: { runId: id } }) as unknown as NonNullable<SyncSnapshot['runs']['sync']>;

it('round-trips live run names and ignores other names', () => {
  expect(runName('Mid', 2, 'sync')).toBe('Mid-2 · SYNC');
  expect(parseRunName('Mid-2 · SYNC')).toEqual({ scenario: 'Mid-2', load: 'Mid', n: 2, policy: 'sync' });
  expect(parseRunName('SYNC sync_greedy · seed 5')).toBeUndefined();
});

it('starts on the mock and lists saved results after it', () => {
  const mock = manual('sample', { status: { kind: 'ready' }, runs: { sync: run('mock') } });
  const db = manual('live', {
    status: { kind: 'ready' },
    runs: {},
    scenarios: [{ id: 'Low-1', label: 'Low-1', group: 'Low', meta: 'completed · tick 415' }],
  });
  const s = new SampleSyncSource(mock, db);
  s.connect();
  const snap = s.getSnapshot();
  expect(s.origin).toBe('sample');
  expect(snap.scenarioId).toBe(MOCK_SCENARIO_ID);
  expect(snap.scenarios?.map((o) => [o.id, o.group])).toEqual([
    ['mock', 'Default'],
    ['Low-1', 'Saved live results'],
  ]);
  // Stable object between changes (useSyncExternalStore contract).
  expect(s.getSnapshot()).toBe(snap);
});

it('shows a saved result when picked', () => {
  const mock = manual('sample', { status: { kind: 'ready' }, runs: { sync: run('mock') } });
  const db = manual('live', {
    status: { kind: 'ready' },
    runs: { sync: run('db') },
    scenarios: [{ id: 'Low-1', label: 'Low-1', group: 'Low' }],
  });
  const s = new SampleSyncSource(mock, db);
  s.connect();
  s.selectScenario('Low-1');
  expect(db.picked).toBe('Low-1');
  expect(s.origin).toBe('live');
  expect(s.getSnapshot().runs.sync?.run.runId).toBe('db');
});
