import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Decision, Policy } from '../sync/contract';
import type { Planner, RunnerClock, ScenarioRunner } from '../sync/runner';
import type { ScenarioOption, SyncSource } from '../sync/source';
import { SCENARIOS } from '../sync/scenarioCatalog';
import { DecisionsPanel } from './components/DecisionsPanel';
import { PlannerSwitch } from './components/PlannerSwitch';
import { ScenarioPicker } from './components/ScenarioPicker';
import { Scorecard } from './components/Scorecard';
import { ShopCard } from './components/ShopCard';
import { Timeline, type Marker } from './components/Timeline';
import { buildLayout } from '../sync/shopLayout';
import {
  EmptyBanner,
  LiveBanner,
  SampleBanner,
  TopBar,
  type DashboardMode,
} from './components/TopBar';
import type { DecisionFilter } from './model/decisions';
import { buildLanes } from './model/lanes';
import { scoreAt } from './model/scoreAt';
import { serviceAt } from './model/service';
import { peakLine, peakWaiting, sceneAt } from './model/scene';
import { usePlayback } from './usePlayback';
import { useSyncSnapshot } from './useSyncSnapshot';

/** Shared empty list, so memoised panels see the same array when there is no run. */
const NONE: never[] = [];

/** Shop drawn with nobody in it while there is no run (one cashier, barista, server, cleaner). */
const DEFAULT_LAYOUT = buildLayout();

/** The one-screen dashboard. Knows only the SyncSource port, never an adapter. */
/** localStorage key of the SYNC planner choice. */
const PLANNER_KEY = 'sync-planner';

export function Dashboard({
  source,
  runner,
  mode,
  onMode,
}: {
  source: SyncSource;
  /** Starts new scenarios (Live mode on the dev server); absent = no start buttons. */
  runner?: ScenarioRunner;
  /** Live / Sample toggle; the composition root swaps the source. */
  mode?: DashboardMode;
  onMode?(mode: DashboardMode): void;
}) {
  const {
    status,
    runs,
    benchmark,
    issues,
    note,
    emptyHint,
    scenarios,
    scenarioId,
    viewer,
  } = useSyncSnapshot(source);
  const { baseline, sync } = runs;
  const end = Math.max(baseline?.run.simTime ?? 0, sync?.run.simTime ?? 0);
  // Live = stream delivery that is still running; the playhead then follows it.
  const live =
    source.delivery === 'stream' &&
    [baseline, sync].some((r) => r?.run.status === 'running');
  // Time moves outside playback (the database) while a live run is running;
  // a finished scenario can be replayed with the normal controls.
  const externalClock = !!source.clockNote && live;
  // Global clock of the scenario the runner is playing: live time is read
  // from it (shared by everyone) instead of being guessed from arrivals.
  const [clock, setClock] = useState<RunnerClock>();
  useEffect(() => {
    if (!live || !runner?.clock) return setClock(undefined);
    let stop = false;
    const read = () =>
      runner.clock!().then(
        (c) => !stop && setClock(c),
        () => !stop && setClock(undefined),
      );
    void read();
    const timer = setInterval(read, 2000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [live, runner]);
  const playback = usePlayback(
    end,
    live ? end : undefined,
    clock && clock.scenario === scenarioId ? clock : undefined,
  );
  const [policy, setPolicy] = useState<Policy>('sync');
  const [filter, setFilter] = useState<DecisionFilter>('all');
  const [selected, setSelected] = useState<Decision>();
  // Stop the runner, then tell the source at once: its runs stay unfinished
  // in the database, so it would otherwise notice only when ticks stop moving.
  // Who plans the next SYNC run; remembered per browser (a convenience only).
  const [planner, setPlanner] = useState<Planner>(() => {
    try {
      return localStorage.getItem(PLANNER_KEY) === 'llm' ? 'llm' : 'algorithm';
    } catch {
      return 'algorithm';
    }
  });
  const pickPlanner = (p: Planner) => {
    setPlanner(p);
    try {
      localStorage.setItem(PLANNER_KEY, p);
    } catch {
      // Without storage the choice lasts until reload.
    }
  };
  const [llmOk, setLlmOk] = useState(false);
  useEffect(() => {
    if (!runner?.llmAvailable) return;
    let stop = false;
    runner.llmAvailable().then(
      (ok) => !stop && setLlmOk(ok),
      () => !stop && setLlmOk(false),
    );
    return () => {
      stop = true;
    };
  }, [runner]);
  /** Latest database entry of a fixed scenario (algorithm or LLM run). */
  const latestRun = (id: string) =>
    (scenarios ?? [])
      .filter((s) => (s.run?.scenario ?? s.id) === id)
      .sort((a, b) => (b.recency ?? 0) - (a.recency ?? 0))[0];
  const stopRunner =
    runner?.stop &&
    (async () => {
      await runner.stop!();
      source.runnerStopped?.();
    });

  // Another scenario: forget the selected decision. A replay starts from 0;
  // in Live a finished scenario opens on its final tick, and a running one
  // keeps following the newest tick (seeking would stop following).
  useEffect(() => {
    setSelected(undefined);
    if (source.delivery === 'replay') playback.seek(0);
    else if (!live) playback.seek(end);
    // Reset only on scenario change; playback ticks must not reset the selection.
  }, [scenarioId]);

  const t = playback.t;
  // Both floors share one lane network sized for the busier run, so the two
  // cards keep the same board height (>10 waiting widens, >12 adds rows).
  // Without a run the floors show the default shop, so the layout never disappears.
  const layout = (sync ?? baseline)?.layout ?? DEFAULT_LAYOUT;
  const lanes = useMemo(() => {
    const capacity = Math.max(
      baseline ? peakWaiting(baseline) : 0,
      sync ? peakWaiting(sync) : 0,
      10,
    );
    // Long lines add queue rows in pairs (same rule for both cards).
    const line = Math.max(
      baseline ? peakLine(baseline) : 0,
      sync ? peakLine(sync) : 0,
    );
    return buildLanes(layout, capacity, line);
  }, [baseline, sync, layout]);
  // Both floors are drawn at the same time t.
  const scenes = {
    baseline: baseline ? sceneAt(baseline, t, lanes) : null,
    sync: sync ? sceneAt(sync, t, lanes) : null,
  };
  // Scores move once per simulated second; memo keeps the card still in between.
  const second = Math.floor(t);
  const syncScore = useMemo(
    () => sync && scoreAt(sync, second),
    [sync, second],
  );
  const baselineScore = useMemo(
    () => baseline && scoreAt(baseline, second),
    [baseline, second],
  );
  // Service speed (not scored), also once per simulated second.
  const service = useMemo(
    () => ({
      baseline: baseline && serviceAt(baseline, second),
      sync: sync && serviceAt(sync, second),
    }),
    [baseline, sync, second],
  );
  const panelRun = runs[policy];
  // The decision list only changes when the next decision is reached, so it
  // gets the time of the newest decision so far (not every playback tick).
  const decisionT = useMemo(() => {
    const ds = panelRun?.decisions ?? [];
    let lo = 0,
      hi = ds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ds[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo ? ds[lo - 1].t : -1;
  }, [panelRun, t]);
  const onPolicy = useCallback((p: Policy) => {
    setPolicy(p);
    setSelected(undefined);
  }, []);
  // Outline the selected decision's agent, slot and customer on the panel's policy floor only.
  const highlight = (p: Policy) =>
    selected && p === policy
      ? {
          agentId: selected.agentId,
          resourceId: selected.resourceId,
          jobId: selected.jobId,
        }
      : {};
  // Timeline ticks: customer arrivals and the panel policy's Wait decisions.
  const markers = useMemo<Marker[]>(
    () => [
      ...(sync?.jobs ?? []).map((j) => ({
        t: j.arrival,
        kind: 'arrival' as const,
      })),
      ...(panelRun?.decisions ?? [])
        .filter((d) => d.kind === 'wait')
        .map((d) => ({ t: d.t, kind: 'wait' as const })),
    ],
    [sync, panelRun],
  );
  const runLabel = sync
    ? `${sync.run.scenario} · seed ${sync.run.seed}`
    : 'No run';

  return (
    <div className="dashboard">
      <TopBar
        run={
          scenarios?.length || runner || mode === 'live' ? (
            <div className="run-controls">
              <ScenarioPicker
                options={
                  runner
                    ? // Live: the fixed scenarios only, each with the state of
                      // its latest run (algorithm or LLM; never run = listed
                      // but not viewable yet). Stored results are in Sample.
                      runner.scenarios
                        .map((r): ScenarioOption => {
                          const db = latestRun(r.id);
                          return {
                            ...r,
                            meta: db?.meta
                              ? `${db.meta}${db.run?.planner === 'llm' ? ' · LLM' : ''}`
                              : 'not run',
                            disabled: !db,
                          };
                        })
                        .concat(
                          // Runs outside the fixed scenarios (external workers).
                          (scenarios ?? []).filter((s) => !s.run),
                        )
                    : scenarios?.length
                      ? scenarios
                      : SCENARIOS.map((s) => ({
                          id: s.id,
                          label: s.id,
                          group: s.load,
                          disabled: true,
                        }))
                }
                value={
                  runner
                    ? (scenarios?.find((s) => s.id === scenarioId)?.run
                        ?.scenario ?? scenarioId)
                    : scenarioId
                }
                showMeta={
                  source.origin === 'live' && source.delivery === 'stream'
                }
                onSelect={(id) =>
                  source.selectScenario?.(
                    runner ? (latestRun(id)?.id ?? id) : id,
                  )
                }
                onRun={
                  runner &&
                  (async (id) => {
                    if (!viewer)
                      throw new Error('Not connected to the database yet.');
                    // The source follows the scenario once its new runs appear.
                    // Run plays the fixed scenario with the planner switch.
                    await runner.start(
                      id,
                      viewer,
                      planner === 'llm' && llmOk ? 'llm' : 'algorithm',
                    );
                  })
                }
                onStop={stopRunner}
                footnote={
                  runner
                    ? 'Run plays Baseline + SYNC on the engine via the runner service and follows it. Same customers (seed 5); scenarios differ by customers and drinks per order.'
                    : mode === 'live'
                      ? 'Viewing only. Connect a runner service to start scenarios.'
                      : undefined
                }
              />
              {(runner?.llmAvailable || mode === 'live') && (
                <PlannerSwitch
                  available={!!runner}
                  value={
                    runner
                      ? llmOk
                        ? planner
                        : 'algorithm'
                      : (scenarios?.find((s) => s.id === scenarioId)?.run
                          ?.planner ?? 'algorithm')
                  }
                  llmAvailable={llmOk}
                  onChange={pickPlanner}
                />
              )}
            </div>
          ) : (
            runLabel
          )
        }
        origin={source.origin}
        status={status}
        label={source.label}
        clock={externalClock ? source.clockNote : undefined}
        onStop={
          scenarios?.find((s) => s.id === scenarioId)?.canRun === false
            ? undefined
            : stopRunner && (() => void stopRunner())
        }
        mode={mode}
        onMode={onMode}
      />
      {!baseline && !sync && status.kind !== 'connecting' ? (
        <EmptyBanner hint={emptyHint} />
      ) : (
        source.origin === 'sample' && <SampleBanner note={note} />
      )}
      {source.origin === 'live' && note && (baseline || sync) && (
        // Engine data: LIVE while something drives it, SAVED when replaying a finished pair.
        <LiveBanner note={note} tag={externalClock ? 'LIVE' : 'SAVED'} />
      )}
      {status.kind === 'disconnected' && (
        <div className="state-banner critical" role="alert">
          {status.reason}
          {status.action && (
            <button className="primary" onClick={status.action.run}>
              {status.action.label}
            </button>
          )}
          <button onClick={() => source.connect()}>Retry</button>
        </div>
      )}
      {issues.length > 0 && (
        <details className="state-banner warning" role="alert">
          <summary>
            Data does not match the dashboard contract ({issues.length})
          </summary>
          <ul>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </details>
      )}
      {status.kind === 'connecting' ? (
        <main className="state-empty" aria-busy="true">
          Connecting to SYNC…
        </main>
      ) : (
        // No run yet still shows the full layout (empty shop, blank scores,
        // no decisions); the empty banner above says how to get a run.
        <main className="body">
          <div className="left">
            <div className="shops">
              <ShopCard
                policy="baseline"
                scene={scenes.baseline}
                data={baseline ?? null}
                layout={layout}
                lanes={lanes}
                timeRef={playback.timeRef}
                highlight={highlight('baseline')}
              />
              <ShopCard
                policy="sync"
                scene={scenes.sync}
                data={sync ?? null}
                layout={layout}
                lanes={lanes}
                timeRef={playback.timeRef}
                highlight={highlight('sync')}
              />
            </div>
            <Scorecard
              sync={syncScore}
              baseline={baselineScore}
              benchmark={benchmark}
              seedLine={source.origin === 'sample'}
              service={service}
            />
          </div>
          <DecisionsPanel
            policy={policy}
            onPolicy={onPolicy}
            decisions={panelRun?.decisions ?? NONE}
            agents={panelRun?.layout.agents ?? NONE}
            resources={panelRun?.layout.resources ?? NONE}
            t={decisionT}
            filter={filter}
            onFilter={setFilter}
            selectedId={selected?.id}
            // Selecting a decision only opens its detail; time keeps going
            // (no jump back, so the list does not shrink).
            onSelect={setSelected}
          />
        </main>
      )}
      <Timeline
        t={t}
        end={end}
        T={sync?.run.objective.T ?? baseline?.run.objective.T ?? 0}
        playing={live ? playback.following : playback.playing}
        live={live}
        controls={!externalClock}
        speed={playback.speed}
        markers={markers}
        onToggle={playback.toggle}
        onStep={() => {
          playback.pause();
          playback.seek(t + 5);
        }}
        onSeek={playback.seek}
        // Speed is local for replay; for live it is also sent to the source.
        onSpeed={(s) => {
          playback.setSpeed(s);
          void source.commands?.setSpeed(s);
        }}
      />
    </div>
  );
}
