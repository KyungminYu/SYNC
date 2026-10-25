// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { MockSyncSource } from '../sync/mock/MockSyncSource';
import type { RunData } from '../sync/contract';
import type { SyncSnapshot, SyncSource } from '../sync/source';
import { Dashboard } from './Dashboard';

/** Dashboard through the port with a real mock source; Phaser is stubbed (no canvas in jsdom). */

vi.mock('./floor/FloorCanvas', () => ({
  FloorCanvas: ({ label }: { label: string }) => (
    <div role="img" aria-label={label} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('renders the mock runs through the port: floors, scorecard, decisions, sample banner', async () => {
  vi.useFakeTimers();
  render(<Dashboard source={new MockSyncSource({ seed: 5 })} />);
  expect(screen.getByText('Connecting to SYNC…')).toBeTruthy();
  await act(async () => vi.advanceTimersByTime(0));
  expect(screen.getByRole('note').textContent).toMatch(/placeholders/);
  expect(screen.getByLabelText('SYNC shop floor')).toBeTruthy();
  expect(screen.getByLabelText('Baseline shop floor')).toBeTruthy();
  expect(screen.getByText('Not measured')).toBeTruthy();
  expect(screen.getByText(/^SYNC finished/)).toBeTruthy();
  // Service speed sits apart from the scored terms.
  const speed = screen.getByLabelText('Service speed (not scored)');
  expect(speed.textContent).not.toMatch(/Last order done/);
  expect(speed.textContent).toMatch(/Average wait/);

  fireEvent.change(screen.getByLabelText('Simulated time'), {
    target: { value: '400' },
  });
  const wait = screen.getByRole('button', { name: /^Wait/ });
  expect(wait.textContent).toMatch(/Wait \d+/);
  fireEvent.click(wait);
  // First row of the decision history (the Scorecard legend is a list too).
  const first = document.querySelector<HTMLButtonElement>('.history button')!;
  fireEvent.click(first);
  const detail = screen.getByLabelText('Selected decision').textContent;
  expect(detail).toMatch(/wait for the/i);
  expect(detail).toMatch(/Admitted/);
  expect(detail).toMatch(/done \d/);
});

/** A read-only live source with a fixed snapshot (no network in tests). */
function fakeLive(snapshot: SyncSnapshot): SyncSource {
  return {
    origin: 'live',
    label: 'SpacetimeDB',
    delivery: 'stream',
    clockNote: 'Clock owned by feeder',
    connect() {},
    disconnect() {},
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  };
}

it('keeps production controls visible with an explicit viewing-only state when no runner is configured', () => {
  render(
    <Dashboard
      mode="live"
      source={fakeLive({ status: { kind: 'ready' }, runs: {} })}
    />,
  );
  expect(screen.getByText('Viewing only: runner not configured')).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Algorithm' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'LLM · Claude' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it('live without visible runs shows who to grant and the feeder command', () => {
  render(
    <Dashboard
      source={fakeLive({
        status: { kind: 'ready' },
        runs: {},
        emptyHint: {
          message: 'Connected as abc…',
          command: 'pnpm feed --viewer abc',
        },
      })}
    />,
  );
  expect(screen.getByText('SpacetimeDB')).toBeTruthy();
  expect(screen.getByText('pnpm feed --viewer abc')).toBeTruthy();
  // Never the sample banner on live data.
  expect(screen.queryByText(/placeholders from the mock backend/)).toBeNull();
  // The layout stays on screen: both empty shops, the scorecard and decisions.
  expect(screen.getByLabelText('Baseline shop floor')).toBeTruthy();
  expect(screen.getByLabelText('SYNC shop floor')).toBeTruthy();
  expect(screen.getByText(/No runs yet — scores fill in/)).toBeTruthy();
  expect(screen.getByText('No decisions yet at this time.')).toBeTruthy();
});

it('no run and no hint still shows the default layout with the empty banner', () => {
  render(
    <Dashboard source={fakeLive({ status: { kind: 'ready' }, runs: {} })} />,
  );
  expect(screen.getByRole('note').textContent).toMatch(/^NO RUN/);
  expect(screen.getByLabelText('Baseline shop floor')).toBeTruthy();
  expect(screen.queryByText('Not measured')).toBeNull();
});

it('live runs hide playback controls and the seed comparison', async () => {
  const mock = new MockSyncSource({
    seed: 5,
    delivery: 'replay',
    latencyMs: 0,
  });
  mock.connect();
  await vi.waitFor(() => expect(mock.getSnapshot().status.kind).toBe('ready'));
  // A live run that is still running: time comes from the database.
  const running = (r?: RunData) =>
    r && { ...r, run: { ...r.run, status: 'running' as const } };
  const { baseline, sync } = mock.getSnapshot().runs;
  const runs = { baseline: running(baseline), sync: running(sync) };
  render(
    <Dashboard
      source={fakeLive({
        status: { kind: 'ready' },
        runs,
        note: 'Driven by the feeder · tick 12',
      })}
    />,
  );
  expect(screen.getByText('Driven by the feeder · tick 12')).toBeTruthy();
  expect(screen.getByText(/Clock owned by feeder/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Step forward/ })).toBeNull();
  expect(screen.queryByText(/Seed comparison pending/)).toBeNull();
});
