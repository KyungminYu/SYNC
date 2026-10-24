import type { ScenarioOption } from './source';

/**
 * Port for running scenarios: the dashboard asks for a scenario to be played
 * without knowing who plays it. It sits beside SyncSource (which only reads)
 * so data sources stay read-only; the composition root picks an
 * implementation (today the dev-server feeder, sync/dev/DevFeederRunner.ts).
 */
export interface ScenarioRunner {
  /** The fixed scenarios that can be run (id, label, level group, detail). */
  readonly scenarios: readonly ScenarioOption[];
  /**
   * Runs one scenario (again). `viewer` is the identity the dashboard reads
   * as, so the new runs are shared with it. Resolves when execution completes; rejects on launch or execution failure.
   */
  start(id: string, viewer: string): Promise<void>;
}
