import { useEffect, useRef, useState } from 'react';
import type { ScenarioOption } from '../../sync/source';

/**
 * Scenario dropdown in the top bar (Figma "Scenario dropdown (open)"): the
 * button shows the scenario on screen; the menu lists the mode's scenarios by
 * group (Low / Mid / High, or Default / Saved live results) with a detail
 * line and state. With `onRun` every row also gets Run / Rerun (Live mode on
 * the dev server). Closes on pick, outside click or Escape.
 */
export function ScenarioPicker({
  options,
  value,
  showMeta,
  onSelect,
  onRun,
  onStop,
  footnote,
}: {
  options: ScenarioOption[];
  value?: string;
  /** Also show the state (running · tick) on the button (Live mode). */
  showMeta: boolean;
  onSelect(id: string): void;
  /** Plays a scenario (again); rows show Run / Rerun when given. */
  onRun?(id: string): Promise<void>;
  /** Stops the running scenario; its row then shows Stop instead of "…". */
  onStop?(): Promise<void>;
  /** One line under the list. */
  footnote?: string;
}) {
  const [open, setOpen] = useState(false);
  /**
   * Run request state: the scenario being played (its start resolves when the
   * run ends), whether a stop is in flight, or the last error.
   */
  const [run, setRun] = useState<{
    busy?: string;
    stopping?: boolean;
    error?: string;
  }>({});
  const root = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === 'Escape'
          : !root.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  // Options keep their order; a group heading starts each new group.
  const groups: Array<[string, ScenarioOption[]]> = [];
  for (const o of options) {
    const last = groups[groups.length - 1];
    if (last && last[0] === o.group) last[1].push(o);
    else groups.push([o.group, [o]]);
  }

  /** Running: in the database, or the one this menu is playing right now. */
  const running = (o: ScenarioOption) =>
    !!o.meta?.startsWith('running') || run.busy === o.id;
  /** Run / Rerun, or Stop for the running scenario (when stopping is possible). */
  const action = (o: ScenarioOption) =>
    running(o)
      ? onStop
        ? run.stopping
          ? 'Stopping…'
          : '■ Stop'
        : run.busy === o.id
          ? 'Running…'
          : '…'
      : o.disabled
        ? '▶ Run'
        : '↻ Rerun';
  const stop = () => {
    setRun((r) => ({ ...r, stopping: true }));
    onStop!().then(
      () => setRun({}),
      (e: Error) => setRun({ error: e.message }),
    );
  };
  const start = (id: string) => {
    setRun({ busy: id });
    onRun!(id).then(
      () => {
        setRun({});
        setOpen(false);
      },
      (e: Error) => {
        setRun({ error: e.message });
        setOpen(true);
      },
    );
  };

  return (
    <div className="scenario-picker" ref={root}>
      <button
        className="picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {current
          ? showMeta && current.meta
            ? `${current.label} · ${current.meta}`
            : current.label
          : 'No scenario'}
        <span className="chevron" aria-hidden>
          {open ? '⌃' : '⌄'}
        </span>
      </button>
      {open && (
        <div className="picker-menu" role="listbox" aria-label="Scenario">
          {groups.map(([group, items]) => (
            <div key={group} role="group" aria-label={group}>
              <div className="picker-group">{group}</div>
              {items.map((o) => (
                <div
                  key={o.id}
                  className="picker-row"
                  role="option"
                  aria-selected={o.id === value}
                  aria-disabled={onRun ? undefined : o.disabled}
                >
                  <button
                    className="pick"
                    disabled={o.disabled}
                    onClick={() => {
                      onSelect(o.id);
                      setOpen(false);
                    }}
                  >
                    <span className="check" aria-hidden>
                      {o.id === value ? '✓' : ''}
                    </span>
                    <span className="picker-text">
                      <span className="label">{o.label}</span>
                      {o.detail && (
                        <span className="picker-detail">{o.detail}</span>
                      )}
                    </span>
                    {o.meta && <span className="meta">{o.meta}</span>}
                  </button>
                  {onRun && o.canRun !== false && (
                    <button
                      className={running(o) && onStop ? 'run stop' : 'run'}
                      disabled={
                        running(o) && onStop
                          ? !!run.stopping
                          : !!run.busy || running(o)
                      }
                      onClick={() =>
                        running(o) && onStop ? stop() : start(o.id)
                      }
                    >
                      {action(o)}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
          {(footnote || run.error) && (
            <p className={run.error ? 'picker-foot error' : 'picker-foot'}>
              {run.error ?? footnote}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
