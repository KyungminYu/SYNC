import type { BenchmarkSummary, Policy, RunData } from './contract';

/**
 * The single boundary between the dashboard and whatever produces SYNC data.
 * The dashboard only sees this port; mock and live adapters implement it.
 * Shaped for React's useSyncExternalStore.
 */

/** 'sample' shows the Sample data banner; 'live' means real SYNC output. */
export type DataOrigin = 'sample' | 'live';

/** Connection state shown in the top bar and as empty/error states. */
export type SourceStatus =
  | { kind: 'connecting' }
  | { kind: 'ready' }
  | {
      kind: 'disconnected';
      reason: string;
      /** A fix the user can run from the dashboard (e.g. start as a new identity). */
      action?: { label: string; run(): void };
    };

/** One entry of the scenario dropdown (Figma "Scenario dropdown (open)"). */
export interface ScenarioOption {
  /** External runs are controlled by their owner, not the scenario feeder. */
  canRun?: boolean;
  id: string;
  label: string;
  /** Menu section, e.g. "Low" or "Saved live results". */
  group: string;
  /** Right-hand detail, e.g. "running · tick 246". */
  meta?: string;
  /** Second line under the label, e.g. "Faster arrivals ×0.65". */
  detail?: string;
  /** Listed but not viewable yet (e.g. a scenario that was never run). */
  disabled?: boolean;
  /** What Run plays for this entry: the fixed scenario and its SYNC planner. */
  run?: { scenario: string; planner: 'algorithm' | 'llm' };
}

/** Everything the source has delivered so far. Immutable: a new object per change. */
export interface SyncSnapshot {
  status: SourceStatus;
  /** One run per policy; missing until it arrives. */
  runs: Partial<Record<Policy, RunData>>;
  /** Paired-seed comparison; may arrive after the runs. */
  benchmark?: BenchmarkSummary;
  /** One line about where the data comes from, shown in the live banner. */
  note?: string;
  /** Shown instead of "No runs yet." when the source knows what is missing. */
  emptyHint?: { message: string; command?: string };
  /** Scenarios this source can show; the dashboard offers them in a dropdown. */
  scenarios?: ScenarioOption[];
  /** The scenario on screen (an id from `scenarios`). */
  scenarioId?: string;
  /** Identity the source reads as (runs must be shared with it to be visible). */
  viewer?: string;
}

/** UI → SYNC commands. Live delivery only (INTERFACE.md §3). */
export interface SyncCommands {
  setPaused(paused: boolean): Promise<void>;
  setSpeed(speed: SimSpeed): Promise<void>;
}

/** Playback / simulation speeds offered in the timeline. */
export const simSpeeds = [0.5, 1, 2, 4, 8] as const;
export type SimSpeed = (typeof simSpeeds)[number];

/** Implemented by MockSyncSource now and SpacetimeSyncSource later. */
export interface SyncSource {
  readonly origin: DataOrigin;
  /** Backend name shown next to "Live" in the source badge, e.g. "SpacetimeDB". */
  readonly label?: string;
  /**
   * Set when time moves outside the dashboard's playback (a driver steps the
   * runs): shown as a pill and hides play / step / speed.
   */
  readonly clockNote?: string;
  /** 'replay': whole runs arrive at once. 'stream': rows arrive as simulated time passes. */
  readonly delivery: 'replay' | 'stream';
  /** Present only when the source accepts commands (live / stream). */
  readonly commands?: SyncCommands;
  /** Switch to another entry of `snapshot.scenarios`. */
  selectScenario?(id: string): void;
  /**
   * The runner stopped driving: unfinished scenarios count as stopped at once
   * (instead of after their tick stops moving) until newer runs appear.
   */
  runnerStopped?(): void;
  /** Begin receiving data. Called when the dashboard mounts. */
  connect(): void;
  /** Stop receiving data. Called when the dashboard unmounts. */
  disconnect(): void;
  /** Current snapshot; must return the same object until something changes. */
  getSnapshot(): SyncSnapshot;
  /** Register a change listener; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}
