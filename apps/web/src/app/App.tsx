import { useEffect, useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { DbConnection, tables } from '@sync/bindings';
import { Identity } from 'spacetimedb';
import { runConfiguration } from '@sync/contracts';
import { Activity, ArrowRight, Play, Pause, RotateCcw } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer } from 'recharts';
import { PhaserGame } from '../game/PhaserGame';
import { Metric } from '../components/Metric';
const byId = (a: { id: bigint }, b: { id: bigint }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export function App() {
  const state = useSpacetimeDB();
  const connection = state.getConnection() as DbConnection | null;
  const [runs, runsReady] = useTable(tables.run),
    [allTasks, tasksReady] = useTable(tables.task),
    [allWorkers, workersReady] = useTable(tables.worker),
    [allResources, resourcesReady] = useTable(tables.resource),
    [allReservations, reservationsReady] = useTable(tables.reservation),
    [allDecisions, decisionsReady] = useTable(tables.decision);
  const [seed, setSeed] = useState('42'),
    [policy, setPolicy] = useState('resource-aware'),
    [selected, setSelected] = useState(''),
    [service, setService] = useState(''),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [subscriptionError, setSubscriptionError] = useState('');
  useEffect(() => {
    if (!connection || !state.isActive) return;
    setSubscriptionError('');
    const subscription = connection
      .subscriptionBuilder()
      .onError((ctx) => setSubscriptionError(String(ctx.event)))
      .subscribe('SELECT * FROM run');
    return () => subscription.unsubscribe();
  }, [connection, state.isActive]);
  const ready =
    state.isActive &&
    runsReady &&
    tasksReady &&
    workersReady &&
    resourcesReady &&
    reservationsReady &&
    decisionsReady &&
    !subscriptionError;
  const ownRuns = runs
    .filter(
      (r) =>
        state.identity &&
        r.controller.isEqual(state.identity) &&
        r.status !== 'retired',
    )
    .sort(byId);
  const run =
    ownRuns.find((r) => r.id.toString() === selected) ?? ownRuns.at(-1);
  const tasks = allTasks.filter((t) => t.runId === run?.id).sort(byId),
    workers = allWorkers.filter((w) => w.runId === run?.id).sort(byId),
    resources = allResources.filter((r) => r.runId === run?.id).sort(byId),
    reservations = allReservations.filter((r) => r.runId === run?.id),
    decisions = allDecisions
      .filter((d) => d.runId === run?.id)
      .sort(byId)
      .slice(-12)
      .reverse();
  const completed = tasks.filter((t) => t.state === 'succeeded').length;
  async function command(action: () => Promise<void>) {
    setError('');
    setPending(true);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  const disabled = !ready || pending;
  return (
    <main>
      <header>
        <a className="brand" href="/">
          <Activity size={27} /> SYNC<span>WORKFLOW LABORATORY</span>
        </a>
        <div className={`connection ${ready ? 'online' : ''}`}>
          ● {ready ? 'Live · SpacetimeDB' : 'Connecting / subscribing'}
          {!state.isActive && (
            <button onClick={() => location.reload()}>Reconnect</button>
          )}
        </div>
      </header>
      <section className="intro">
        <div>
          <p className="eyebrow">RESOURCE-AWARE MULTI-AGENT SCHEDULING</p>
          <h1>
            Shared resources.
            <br />
            <em>Coordinated work.</em>
          </h1>
          <p>
            Watch four workers turn a dependency graph into a completed
            workflow.
          </p>
        </div>
        <div className="fixture">
          <span>EXPERIMENT 01</span>
          <strong>The kitchen</strong>
          <small>Seeded demonstration · deterministic simulation</small>
        </div>
      </section>
      {(error || state.connectionError || subscriptionError) && (
        <div role="alert" className="error">
          {error || subscriptionError || String(state.connectionError)}{' '}
          <button onClick={() => location.reload()}>Reconnect</button>
        </div>
      )}
      <section className="controls panel">
        <label>
          Seed
          <input
            aria-label="Seed"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
          />
        </label>
        <label>
          Scheduling policy
          <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
            <option value="resource-aware">SYNC · Resource-aware greedy</option>
            <option value="fcfs">Baseline · FCFS feasible</option>
          </select>
        </label>
        <button
          className="primary"
          disabled={disabled}
          onClick={() =>
            void command(async () => {
              const config = runConfiguration.parse({
                seed: Number(seed),
                policy,
              });
              await connection!.reducers.createDemoRun(config);
              setSelected('');
            })
          }
        >
          Create run <ArrowRight size={16} />
        </button>
        <div className="divider" />
        <label>
          Active run
          <select
            aria-label="Active run"
            value={run?.id.toString() ?? ''}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="" disabled>
              Select a run
            </option>
            {ownRuns.map((r) => (
              <option key={String(r.id)} value={String(r.id)}>
                #{String(r.id)} · {r.status}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={disabled || !run || run.status !== 'paused'}
          onClick={() =>
            void command(() =>
              connection!.reducers.startRun({ runId: run!.id }),
            )
          }
        >
          <Play size={15} />
          Start
        </button>
        <button
          disabled={disabled || run?.status !== 'running'}
          onClick={() =>
            void command(() =>
              connection!.reducers.pauseRun({ runId: run!.id }),
            )
          }
        >
          <Pause size={15} />
          Pause
        </button>
        <button
          title="Retire this run and create a fresh run"
          disabled={disabled || !run}
          onClick={() =>
            void command(async () => {
              await connection!.reducers.resetRun({ runId: run!.id });
              setSelected('');
            })
          }
        >
          <RotateCcw size={15} />
          Reset
        </button>
      </section>
      <div className="metrics">
        <Metric
          label="COMPLETED TASKS"
          value={`${completed} / ${tasks.length}`}
        />
        <Metric label="LOGICAL TICK" value={run?.tick ?? 0} />
        <Metric
          label="ACTIVE WORKERS"
          value={workers.filter((w) => w.taskId !== undefined).length}
        />
        <Metric
          label="RESERVED UNITS"
          value={reservations.reduce((n, r) => n + r.units, 0)}
        />
      </div>
      <div className="columns">
        <section className="panel">
          <div className="section-title">
            <h2>Execution floor</h2>
            <span>{run?.status ?? 'No run'}</span>
          </div>
          <PhaserGame
            workers={workers.map((w) => ({
              id: String(w.id),
              label: w.label,
              active: w.taskId !== undefined,
              activity:
                w.taskId === undefined
                  ? 'Idle'
                  : (tasks.find((t) => t.id === w.taskId)?.state ?? 'Waiting'),
            }))}
          />
          <div className="workers">
            {workers.map((w) => (
              <article key={String(w.id)}>
                <span className="dot" />
                <strong>{w.label}</strong>
                <small>{w.capabilities.join(' / ')}</small>
                <p>
                  {w.taskId === undefined
                    ? 'Available'
                    : tasks.find((t) => t.id === w.taskId)?.label +
                      ' · ' +
                      tasks.find((t) => t.id === w.taskId)?.state}
                </p>
              </article>
            ))}
          </div>
          {!run && (
            <p className="empty">Create a seeded run to populate the floor.</p>
          )}
        </section>
        <section className="panel">
          <div className="section-title">
            <h2>Resource occupancy</h2>
            <span>Live reservations</span>
          </div>
          {resources.map((r) => {
            const usage = reservations
              .filter((q) => q.resourceId === r.id)
              .reduce((n, q) => n + q.units, 0);
            return (
              <div className="resource" key={String(r.id)}>
                <div>
                  <strong>{r.label}</strong>
                  <span>
                    {usage} / {r.capacity}
                  </span>
                </div>
                <progress value={usage} max={r.capacity} />
              </div>
            );
          })}
          <div className="chart">
            <ResponsiveContainer width="100%" height={150}>
              <BarChart
                data={[
                  'blocked',
                  'ready',
                  'assigned',
                  'running',
                  'succeeded',
                ].map((status) => ({
                  status,
                  count: tasks.filter((t) => t.state === status).length,
                }))}
              >
                <XAxis
                  dataKey="status"
                  tick={{ fontSize: 10, fill: '#a6b6af' }}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: '#a6b6af' }}
                  width={22}
                />
                <Bar dataKey="count" fill="#b8eb80" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="muted">
            Observed task states. No projected performance gains.
          </p>
        </section>
      </div>
      <div className="columns">
        <section className="panel">
          <div className="section-title">
            <h2>Task graph</h2>
            <span>{tasks.length} tasks</span>
          </div>
          {tasks.map((t) => (
            <div className="task" key={String(t.id)}>
              <strong>
                {t.label}
                <small>
                  {t.capabilities.join(', ')} · {t.duration} ticks · release{' '}
                  {t.release}
                </small>
              </strong>
              <span className={`badge ${t.state}`}>{t.state}</span>
              <small>attempt {t.attempt}</small>
            </div>
          ))}
          {!tasks.length && (
            <p className="empty">Tasks appear after run creation.</p>
          )}
        </section>
        <section className="panel">
          <div className="section-title">
            <h2>Decision trace</h2>
            <span>Committed assignments</span>
          </div>
          {decisions.map((d) => (
            <div className="decision" key={String(d.id)}>
              <span className="tick">T{d.tick}</span>
              <div>
                <strong>
                  {tasks.find((t) => t.id === d.taskId)?.label} →{' '}
                  {workers.find((w) => w.id === d.workerId)?.label}
                </strong>
                <small>
                  {d.reason === 'FCFS_FEASIBLE'
                    ? 'Release order · feasible resources'
                    : 'Deadline urgency + age − duration'}
                </small>
              </div>
            </div>
          ))}
          {!decisions.length && (
            <p className="empty">No scheduling decisions yet.</p>
          )}
        </section>
      </div>
      <section className="panel registration">
        <div>
          <h2>Authorize agent service</h2>
          <p>
            Paste the identity printed by the local agent service. Only this
            run’s controller can register it.
          </p>
        </div>
        <input
          aria-label="Service identity"
          placeholder="Service identity (hex)"
          value={service}
          onChange={(e) => setService(e.target.value)}
        />
        <button
          disabled={disabled || !run || !service}
          onClick={() =>
            void command(() => {
              if (!/^[a-fA-F0-9]{64}$/.test(service))
                throw new Error(
                  'Identity must contain 64 hexadecimal characters',
                );
              return connection!.reducers.registerService({
                runId: run!.id,
                identity: Identity.fromString(service),
              });
            })
          }
        >
          Authorize
        </button>
      </section>
      <footer>
        SYNC / FOUNDATION{' '}
        <span>Model proposes · Database admits · Simulation executes</span>
      </footer>
    </main>
  );
}
