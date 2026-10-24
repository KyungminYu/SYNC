import type { ScenarioOption } from './source';

/**
 * Port for running scenarios: the dashboard asks for a scenario to be played
 * without knowing who plays it. It sits beside SyncSource (which only reads)
 * so data sources stay read-only; the composition root picks an
 * implementation (today the dev-server feeder, sync/dev/DevFeederRunner.ts).
 */
/** Who plans the SYNC run: the engine policy alone, or an LLM tuning its objective weights. */
export type Planner = 'algorithm' | 'llm';

export interface ScenarioRunner {
  /** The fixed scenarios that can be run (id, label, level group, detail). */
  readonly scenarios: readonly ScenarioOption[];
  /**
   * Runs one scenario (again). `viewer` is the identity the dashboard reads
   * as, so the new runs are shared with it. `planner` picks who plans the
   * SYNC run (default 'algorithm'). Resolves when execution completes; rejects on launch or execution failure.
   */
  start(id: string, viewer: string, planner?: Planner): Promise<void>;
  /** Whether the LLM planner can be used (e.g. an API key is configured). */
  llmAvailable?(): Promise<boolean>;
  /** Stops the scenario being played; its runs stay unfinished (shown as stopped). */
  stop?(): Promise<void>;
  /**
   * The global clock of the scenario being played: tick n is due at
   * startedAt + n × tickMs (epoch ms). Undefined when nothing is playing.
   */
  clock?(): Promise<RunnerClock | undefined>;
}

/** Global clock shared by the runner and every viewer of its scenario. */
export interface RunnerClock {
  scenario: string;
  startedAt: number;
  tickMs: number;
}
