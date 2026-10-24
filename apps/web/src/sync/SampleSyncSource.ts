import type { ScenarioOption, SyncSnapshot, SyncSource } from './source';

/**
 * Sample mode: the mock scenario (always listed, the default) plus the
 * finished live results a stored-results source lists. The dropdown picks
 * one; this source then shows that source's runs. Adapter-agnostic: it only
 * sees the port, so the composition root decides what backs each part.
 */
export const MOCK_SCENARIO_ID = 'mock';

const MOCK_OPTION: ScenarioOption = {
  id: MOCK_SCENARIO_ID,
  label: 'Mock scenario (default)',
  group: 'Default',
  meta: 'sample data',
};

export class SampleSyncSource implements SyncSource {
  private selected = MOCK_SCENARIO_ID;
  private listeners = new Set<() => void>();
  private unsubscribers: Array<() => void> = [];
  /** Last combined snapshot and what it was built from (stable between changes). */
  private cache?: {
    inner: SyncSnapshot;
    stored: SyncSnapshot;
    selected: string;
    outer: SyncSnapshot;
  };

  constructor(
    private readonly mock: SyncSource,
    /** Lists finished results as `scenarios` and shows the picked one. */
    private readonly stored: SyncSource,
  ) {}

  /** The source whose runs are on screen. */
  private get active() {
    return this.selected === MOCK_SCENARIO_ID ? this.mock : this.stored;
  }
  get origin() {
    return this.active.origin;
  }
  get label() {
    return this.active.label;
  }
  get delivery() {
    return this.active.delivery;
  }
  get clockNote() {
    return this.active.clockNote;
  }
  get commands() {
    return this.active.commands;
  }

  connect() {
    this.disconnect();
    for (const s of [this.mock, this.stored]) {
      this.unsubscribers.push(s.subscribe(() => this.emit()));
      // The stored source always runs so its results appear in the dropdown.
      s.connect();
    }
  }

  disconnect() {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    this.mock.disconnect();
    this.stored.disconnect();
  }

  selectScenario(id: string) {
    this.selected = id;
    if (id !== MOCK_SCENARIO_ID) this.stored.selectScenario?.(id);
    this.emit();
  }

  getSnapshot = (): SyncSnapshot => {
    const inner = this.active.getSnapshot();
    const stored = this.stored.getSnapshot();
    const c = this.cache;
    if (c && c.inner === inner && c.stored === stored && c.selected === this.selected)
      return c.outer;
    const saved = (stored.scenarios ?? []).map((s) => ({
      ...s,
      group: 'Saved live results',
    }));
    // A picked result that disappeared (database reset) falls back to the mock.
    if (this.selected !== MOCK_SCENARIO_ID && !saved.some((s) => s.id === this.selected))
      this.selected = MOCK_SCENARIO_ID;
    const shown = this.active.getSnapshot();
    const outer: SyncSnapshot = {
      ...shown,
      // Showing the mock never needs the database's empty-state hint.
      emptyHint: this.selected === MOCK_SCENARIO_ID ? undefined : shown.emptyHint,
      scenarios: [MOCK_OPTION, ...saved],
      scenarioId: this.selected,
    };
    this.cache = { inner: shown, stored, selected: this.selected, outer };
    return outer;
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    for (const l of this.listeners) l();
  }
}
