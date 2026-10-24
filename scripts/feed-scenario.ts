/**
 * Scenario feeder (test data source; the dashboard only reads the database).
 * Plays one fixed scenario (apps/web/src/sync/scenarioCatalog.ts) into the
 * local SpacetimeDB engine as runs "{id} · Baseline" (fcfs) and "{id} · SYNC"
 * (sync_greedy). Design: design/LIVE_SPACETIMEDB_DESIGN.md §7.
 *
 *   corepack pnpm feed --scenario Mid-2 [--viewer <identity hex>]
 *                      [--db sync-coffee-live] [--trays 12] [--ms 200]
 *
 * Every scenario uses the mock's customers (seed 5) and turns up one lever:
 * -1 faster arrivals, -2 more drinks, -3 arrivals in groups.
 *
 * Runs are private to their owner (this script). --viewer grants a dashboard
 * identity viewer access; viewers are remembered in .local/feeder-viewers so
 * later runs share with them automatically. The engine allows 10 runs per
 * owner: when the next pair would not fit, the feeder starts over as a new
 * identity (older runs and their viewer grants stay).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { DbConnection } from '../packages/bindings/src';
import { simulate } from '../apps/web/src/sync/mock/scenario';
import { applyScenario, scenarioById, SCENARIOS } from '../apps/web/src/sync/scenarioCatalog';
import { driveScenario } from './lib/driveScenario';

/** --name value flags with defaults. */
function flag(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
/** Base customers: the mock scenario's seed. */
const SEED = 5;
const trays = Number(flag('trays', '12'));
/** Wall-clock ms per tick: 200 ms = 5× real time (same as the engine clock). */
const tickMs = Number(flag('ms', '200'));
const uri = flag('uri', process.env.VITE_SPACETIMEDB_URI ?? 'http://127.0.0.1:3000');
const database = flag('db', process.env.VITE_SPACETIMEDB_DATABASE ?? 'sync-coffee-live');
const scenario = scenarioById(flag('scenario', ''));
if (!scenario)
  throw new Error(`--scenario must be one of ${SCENARIOS.map((s) => s.id).join(', ')}`);

mkdirSync('.local', { recursive: true });
const TOKEN_FILE = '.local/feeder-token';
const VIEWERS_FILE = '.local/feeder-viewers';
const viewers = new Set(
  existsSync(VIEWERS_FILE)
    ? readFileSync(VIEWERS_FILE, 'utf8').split('\n').filter(Boolean)
    : [],
);
const newViewer = flag('viewer', '');
if (newViewer) {
  viewers.add(newViewer.toLowerCase());
  writeFileSync(VIEWERS_FILE, [...viewers].join('\n') + '\n');
}

/** Connects with the stored feeder identity and subscribes to the runs view. */
function connect() {
  return new Promise<DbConnection>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer from ${uri}`)), 10000);
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(database)
      .withToken(existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8') : undefined)
      .onConnect((conn, _identity, token) => {
        writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timer);
            resolve(conn);
          })
          .onError((ctx) => reject(ctx.event))
          .subscribe(['SELECT * FROM ui_runs']);
      })
      .onConnectError((_ctx, error) => {
        clearTimeout(timer);
        reject(error);
      })
      .build();
  });
}

/** Runs one owner may have (engine `create_run` limit). */
const OWNER_RUN_LIMIT = 10;
let conn = await connect();
// Two more runs must fit under the owner limit; otherwise start as a new identity.
if ([...conn.db.uiRuns.iter()].filter((r) => r.canControl).length + 2 > OWNER_RUN_LIMIT) {
  console.log('feeder identity owns 10 runs: switching to a new identity');
  conn.disconnect();
  rmSync(TOKEN_FILE, { force: true });
  conn = await connect();
}
console.log(`feeder identity ${conn.identity!.toHexString()}`);

if (!viewers.size)
  console.log('no --viewer given: only this feeder identity can see the runs');
// The scenario's customers: the mock's (same seed) with its lever applied.
const customers = applyScenario(
  scenario,
  simulate('baseline', { seed: SEED }).jobs.map((job) => ({
    id: job.id,
    arrival: job.arrival,
    items: job.items,
  })),
);
console.log(
  `${scenario.id} (${scenario.description}): ${customers.length} customers, ${customers.reduce((k, c) => k + c.items.length, 0)} drinks`,
);
const ids = await driveScenario(conn, {
  seed: SEED,
  load: scenario.load,
  n: scenario.n,
  customers,
  trays,
  tickMs,
  viewers: [...viewers],
  log: console.log,
});
console.log(`done: ${scenario.id} runs ${ids?.baseline} and ${ids?.sync} completed`);
conn.disconnect();
process.exit(0);
