import type { ReactNode } from 'react';
import type { DataOrigin, SourceStatus } from '../../sync/source';

/** Top bar (logo, run, data-source badge, Live / Sample toggle) and the data banners. */

/** Live: run the scenario on the engine now. Sample: replay saved runs (or the mock). */
export type DashboardMode = 'live' | 'sample';

/** Badge tone and text: connection problems first, then where the data comes from. */
const badge = (origin: DataOrigin, status: SourceStatus, label?: string) =>
  status.kind === 'disconnected'
    ? { tone: 'critical', text: 'Disconnected' }
    : status.kind === 'connecting'
      ? { tone: 'warning', text: 'Connecting' }
      : origin === 'sample'
        ? { tone: 'neutral', text: 'Sample data' }
        : // The Live / Sample toggle names the mode; the badge names the backend only.
          { tone: 'good', text: label ?? 'Live' };

export function TopBar({
  run,
  origin,
  status,
  label,
  clock,
  mode,
  onMode,
  onStop,
}: {
  /** Run name, or the scenario dropdown when the source offers scenarios. */
  run: ReactNode;
  origin: DataOrigin;
  status: SourceStatus;
  /** Backend name for the live badge. */
  label?: string;
  /** Who drives time when the dashboard cannot (live runs stepped by the feeder). */
  clock?: string;
  mode?: DashboardMode;
  onMode?(mode: DashboardMode): void;
  /** Stops the live scenario (shown beside the clock pill while it runs). */
  onStop?(): void;
}) {
  const b = badge(origin, status, label);
  return (
    <header className="topbar">
      <strong className="logo">SYNC</strong>
      <div className="run">{run}</div>
      {mode && onMode && (
        <div className="mode-toggle segmented" role="group" aria-label="Data mode">
          {(['live', 'sample'] as DashboardMode[]).map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => onMode(m)}>
              {m === 'live' ? 'Live' : 'Sample'}
            </button>
          ))}
        </div>
      )}
      <span className={`source-badge tone-${b.tone}`}>
        <span className="dot" aria-hidden /> {b.text}
      </span>
      {clock && status.kind === 'ready' && (
        <span className="clock-pill">
          <span className="dot" aria-hidden /> {clock}
        </span>
      )}
      {clock && onStop && status.kind === 'ready' && (
        <button className="stop-pill" onClick={onStop}>
          ■ Stop
        </button>
      )}
    </header>
  );
}

/** Shown whenever the data is sample (mock) data, so numbers are never mistaken for results. */
export function SampleBanner({ note }: { note?: string }) {
  return (
    <div className="sample-banner" role="note">
      <span className="tag">SAMPLE</span>
      {note ? `${note} ` : ''}All numbers on this screen are placeholders from
      the mock backend, not SYNC results.
    </div>
  );
}

/** Live data: where it comes from (the source writes the line). */
export function LiveBanner({ note, tag = 'LIVE' }: { note: string; tag?: string }) {
  return (
    <div className="live-banner" role="note">
      <span className="tag">{tag}</span>
      {note}
    </div>
  );
}

/**
 * No run yet (Figma "SYNC Dashboard · Empty (no scenario)"): the layout stays
 * on screen and this line says how to get a run, using the source's hint.
 */
export function EmptyBanner({
  hint,
}: {
  hint?: { message: string; command?: string };
}) {
  return (
    <div className="sample-banner empty-banner" role="note">
      <span className="tag">NO RUN</span>
      {hint?.message ??
        'No runs yet · Pick a scenario above. The empty shop is shown until the first run arrives.'}
      {hint?.command && <code>{hint.command}</code>}
    </div>
  );
}
