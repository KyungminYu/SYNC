import { it, expect, vi } from 'vitest';
vi.mock('../../lib/env', () => ({
  env: {
    VITE_SPACETIMEDB_URI: 'http://localhost:3000',
    VITE_SPACETIMEDB_DATABASE: 'test',
  },
}));
import { scenariosOf } from './SpacetimeSyncSource';
import { runName } from './scenarioNames';
it('never pairs a rerun with the previous counterpart and retains completed samples', () => {
  const runs = [
    {
      id: 1n,
      name: runName('Low', 3, 'baseline', 'old'),
      seed: 5,
      tick: 100,
      status: 'completed',
    },
    {
      id: 2n,
      name: runName('Low', 3, 'sync', 'old'),
      seed: 5,
      tick: 100,
      status: 'completed',
    },
    {
      id: 3n,
      name: runName('Low', 3, 'baseline', 'new'),
      seed: 5,
      tick: 0,
      status: 'paused',
    },
  ];
  expect(scenariosOf(runs)[0].runs.sync).toBeUndefined();
  expect(scenariosOf(runs, true)[0].runs.sync?.id).toBe(2n);
});
