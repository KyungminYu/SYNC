import { randomUUID } from 'node:crypto';
import { Identity } from 'spacetimedb';
import type { DbConnection } from '../../packages/bindings/src';
import type { ScenarioCustomer } from '../../apps/web/src/sync/scenarioCatalog';
import { cartKeyFor, menuByName } from '../../apps/web/src/sync/menu';
import { WALK_IN } from '../../apps/web/src/sync/shopLayout';
import { runName, type Load } from '../../apps/web/src/sync/live/scenarioNames';

/**
 * Plays a scenario into the SpacetimeDB engine (LIVE_SPACETIMEDB_DESIGN.md §3).
 * Used by scripts/feed-scenario.ts; the dashboard itself never writes.
 *
 * Creates two deterministic runs with the same customers — "Baseline" on fcfs
 * and "SYNC" on primal_dual — and owns their clock: both runs stay paused and
 * are stepped one tick (= one scenario second) at a time, so every customer
 * reaches both shops at exactly the same tick. Each drink is one engine order;
 * a customer's drinks share a cart key ("c7:latte+black_coffee").
 */

export type { ScenarioCustomer };

export interface DriveOptions {
  seed: number;
  /** Scenario id parts: runs are named "{load}-{n} · Baseline/SYNC". */
  load: Load;
  n: number;
  customers: ScenarioCustomer[];
  /** Serving trays per run (enough not to be a bottleneck). */
  trays?: number;
  /** Wall-clock ms per tick; 200 = 5× real time. */
  tickMs?: number;
  /** Identities (hex) granted viewer access to the new runs. */
  viewers?: string[];
  /** Stops stepping (runs stay paused where they are). */
  signal?: AbortSignal;
  /** Called once both runs exist. */
  onRuns?(ids: { baseline: bigint; sync: bigint }): void;
  log?(line: string): void;
}

/** Customer deadline: 90 s after walking in; orders are enqueued WALK_IN s later. */
const DEADLINE_FROM_DOOR = 90;
/** Runs one identity may own (engine `create_run` limit). */
const OWNER_RUN_LIMIT = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `read` returns a value from the client cache. */
async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const end = Date.now() + 15000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * Runs the scenario to completion (or until aborted). `conn` must already be
 * subscribed to `ui_runs`. Returns the two run ids.
 */
export async function driveScenario(conn: DbConnection, o: DriveOptions) {
  const { seed, signal, log = () => {} } = o;
  const batch = randomUUID();
  const runs = [
    { name: runName(o.load, o.n, 'baseline', batch), policy: 'fcfs' },
    { name: runName(o.load, o.n, 'sync', batch), policy: 'primal_dual' },
  ] as const;
  // The engine allows 10 runs per owner and only reports a generic error when
  // the limit is hit, so check first. Runs this identity controls = owned runs.
  const owned = [...conn.db.uiRuns.iter()].filter((r) => r.canControl).length;
  if (owned + runs.length > OWNER_RUN_LIMIT)
    throw new Error(
      `this browser identity already owns ${owned} of the engine's ${OWNER_RUN_LIMIT} runs, so a new Baseline/SYNC pair cannot be created. Use Sample mode to replay saved runs.`,
    );
  const drinks = o.customers.reduce((n, c) => n + c.items.length, 0);
  if (!drinks || drinks > 100)
    throw new Error('Scenario must contain 1�100 drinks per shop.');
  if (
    o.customers.some(
      (c) =>
        !Number.isFinite(c.arrival) ||
        c.arrival < 0 ||
        !c.items.length ||
        c.items.some((i) => !menuByName(i.name)),
    )
  )
    throw new Error('Invalid scenario customer or menu item.');
  if (new Set(o.customers.map((c) => c.id)).size !== o.customers.length)
    throw new Error('Duplicate scenario customer id.');
  const ids: bigint[] = [];
  for (const r of runs) {
    if (signal?.aborted) return;
    const before = new Set([...conn.db.uiRuns.iter()].map((x) => x.id));
    await conn.reducers.createRun({
      name: r.name,
      seed,
      trayCount: o.trays ?? 12,
      mode: 'deterministic',
      budgetMicrousd: undefined,
    });
    const run = await until(
      () =>
        [...conn.db.uiRuns.iter()].find(
          (x) => !before.has(x.id) && x.name === r.name,
        ),
      `run "${r.name}"`,
    );
    await conn.reducers.setPolicy({
      runId: run.id,
      configJson: JSON.stringify({ policy: r.policy }),
    });
    for (const hex of o.viewers ?? [])
      await conn.reducers.grantMember({
        runId: run.id,
        identity: Identity.fromString(hex),
        permission: 'viewer',
        enabled: true,
      });
    ids.push(run.id);
    log(`run ${run.id}: ${r.name}`);
  }
  o.onRuns?.({ baseline: ids[0], sync: ids[1] });

  // Customers reach the counter WALK_IN s after the door; that is when they order.
  const arrivals = o.customers.map((c) => ({
    ...c,
    tick: Math.round(c.arrival) + WALK_IN,
  }));
  const lastArrival = Math.max(...arrivals.map((c) => c.tick));
  const status = (id: bigint) =>
    [...conn.db.uiRuns.iter()].find((r) => r.id === id);
  let closed = false;
  for (let tick = 0; !signal?.aborted; tick++) {
    const started = Date.now();
    for (const c of arrivals.filter((c) => c.tick === tick))
      for (const runId of ids)
        for (const [k, item] of c.items.entries()) {
          const entry = menuByName(item.name);
          if (!entry) throw new Error(`No engine recipe for "${item.name}"`);
          await conn.reducers.enqueueOrder({
            runId,
            externalKey: `${c.id}-${k + 1}`,
            cartKey: cartKeyFor(c.id, c.items),
            recipe: entry.recipe,
            deadlineInTicks: DEADLINE_FROM_DOOR - WALK_IN,
            value: 1,
            priority: 0,
            // The customer leaves with the drinks at once; the tray is free right away.
            customerUseTicks: 0,
          });
        }
    if (!closed && tick >= lastArrival) {
      for (const runId of ids) await conn.reducers.closeArrivals({ runId });
      closed = true;
    }
    const open = ids.filter((id) => status(id)?.status !== 'completed');
    if (!open.length) break;
    for (const runId of open) await conn.reducers.stepRun({ runId });
    await until(
      () =>
        open.every((id) => {
          const r = status(id);
          return r && (r.status === 'completed' || r.tick >= tick + 1);
        })
          ? true
          : undefined,
      'scenario tick',
    );
    if (tick > lastArrival + 10000)
      throw new Error(
        'Scenario stalled: inspect resource availability, budget, and task states.',
      );
    if (tick % 30 === 0)
      log(
        `tick ${tick}: ${ids.map((id) => `${id}=${status(id)?.status}`).join(' ')}`,
      );
    await sleep(Math.max(0, (o.tickMs ?? 200) - (Date.now() - started)));
  }
  return { baseline: ids[0], sync: ids[1] };
}
