/// <reference types="vite/client" />
import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SyncSource } from '../sync/source';
import { SampleSyncSource } from '../sync/SampleSyncSource';
import { MockSyncSource } from '../sync/mock/MockSyncSource';
import { SpacetimeSyncSource } from '../sync/live/SpacetimeSyncSource';
import { DevFeederRunner } from '../sync/dev/DevFeederRunner';
import { Dashboard } from './Dashboard';
import type { DashboardMode } from './components/TopBar';
import './dashboard.css';

/**
 * Composition root: the only module that knows which adapter backs the
 * dashboard. Everything is chosen on screen (Live / Sample toggle and the
 * scenario dropdown); the URL carries no options. The dashboard only reads
 * the database; scenarios are written by scripts/feed-scenario.ts, which the
 * dev server can start for the dashboard through the ScenarioRunner port.
 *   Live   — (default) subscribes to SpacetimeDB and shows the picked scenario
 *            (Low-1, Mid-2, …) as it changes.
 *   Sample — the mock scenario or a finished live result saved in
 *            the database, replayed from the start.
 * The database comes from VITE_SPACETIMEDB_* (apps/web/.env.local).
 */

/** Scenario seed of the mock (docs/SCENARIO.md). */
const SEED = 5;

/**
 * Starts scenarios from the dashboard: the dev server runs the test feeder.
 * Production uses a separately hosted persistent runner when configured.
 */
const runnerUrl = import.meta.env.VITE_SYNC_RUNNER_URL?.trim();
const runner = runnerUrl
  ? new DevFeederRunner(runnerUrl, true)
  : import.meta.env.DEV
    ? new DevFeederRunner()
    : undefined;

/** Source for a toggle position. */
function sourceFor(mode: DashboardMode): SyncSource {
  if (mode === 'live') return new SpacetimeSyncSource('live');
  return new SampleSyncSource(
    new MockSyncSource({ seed: SEED, delivery: 'replay', latencyMs: 300 }),
    new SpacetimeSyncSource('stored'),
  );
}

function App() {
  const [mode, setMode] = useState<DashboardMode>('live');
  const source = useMemo(() => sourceFor(mode), [mode]);
  return (
    <Dashboard
      key={mode}
      source={source}
      // Starting a scenario belongs to Live mode only.
      runner={mode === 'live' ? runner : undefined}
      mode={mode}
      onMode={setMode}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
