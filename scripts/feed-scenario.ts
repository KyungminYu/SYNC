import { createHash } from 'node:crypto';
import { databaseConfig } from './lib/databaseConfig.mjs';
/**
 * Scenario feeder (test data source; the dashboard only reads the database).
 * Plays one fixed scenario (apps/web/src/sync/scenarioCatalog.ts) into the
 * local SpacetimeDB engine as runs "{id} · Baseline" (fcfs) and "{id} · SYNC"
 * (primal_dual). Design: design/LIVE_SPACETIMEDB_DESIGN.md §7.
 *
 *   corepack pnpm feed --scenario Mid-2 [--viewer <identity hex>]
 *                      [--db sync-coffee-live] [--trays 12] [--ms 200]
 *                      [--planner algorithm|llm]
 *
 * --planner llm: an LLM (scripts/lib/llmPlanner.ts) tunes the SYNC planner's
 * objective weights (β lateness, γ execution, δ coordination) every 10–30
 * ticks; needs ANTHROPIC_API_KEY (environment, or the repo root .env /
 * .env.local).
 *
 * Scenarios differ by customers (12 / 16 / 20) and order size (1, 1–2, 1–3
 * drinks), ranked by total drinks; arrivals keep the mock's pace (seed 5).
 *
 * Runs are private to their owner (this script). --viewer grants a dashboard
 * identity viewer access; viewers are remembered in .local/feeder-viewers so
 * later runs share with them automatically. The engine allows 10 runs per
 * owner: when the next pair would not fit, the feeder starts over as a new
 * identity (older runs and their viewer grants stay).
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { DbConnection } from '../packages/bindings/src';
import { simulate } from '../apps/web/src/sync/mock/scenario';
import {
  applyScenario,
  scenarioById,
  SCENARIOS,
  type ScenarioDef,
} from '../apps/web/src/sync/scenarioCatalog';
import { Identity } from 'spacetimedb';
import { driveScenario } from './lib/driveScenario';
import { LlmPlanner } from './lib/llmPlanner';

/** --name value flags with defaults. */
function flag(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
/** Base customers: the mock scenario's seed. */
const SEED = 5;
const trays = Number(flag('trays', '12'));
/** Wall-clock ms per tick: 200 ms = 5× real time (same as the engine clock). */
// Global clock: one scenario second per 2 s of wall time. The engine needs
// ~1.2 s per tick on average and more when customers bunch up, so it keeps
// up; 180 ticks take about 6 minutes.
const tickMs = Number(flag('ms', '2000'));
const config = databaseConfig();
const uri = flag('uri', config.uri);
const database = flag('db', config.database);
if (!Number.isInteger(trays) || trays < 1 || trays > 20)
  throw new Error('--trays must be 1�20');
if (!Number.isInteger(tickMs) || tickMs < 0 || tickMs > 60000)
  throw new Error('--ms must be 0–60000');
const picked = scenarioById(flag('scenario', ''));
if (!picked)
  throw new Error(
    `--scenario must be one of ${SCENARIOS.map((s) => s.id).join(', ')}`,
  );
// Bound once checked: narrowing does not reach into the functions below.
const scenario: ScenarioDef = picked;
const planner = flag('planner', 'algorithm');
if (planner !== 'algorithm' && planner !== 'llm')
  throw new Error('--planner must be algorithm or llm');
// The API key may live in the repo root .env files (never committed).
for (const file of ['.env.local', '.env'])
  if (existsSync(file)) process.loadEnvFile(file);
if (planner === 'llm' && !process.env.ANTHROPIC_API_KEY)
  throw new Error(
    '--planner llm needs ANTHROPIC_API_KEY (repo root .env.local)',
  );

mkdirSync('.local', { recursive: true });
// One scenario at a time: a new feeder ends any feeder still running (from
// the dashboard, a terminal or an earlier run) and takes over the pid file.
const PID_FILE = '.local/feeder.pid';
if (existsSync(PID_FILE)) {
  const previous = Number(readFileSync(PID_FILE, 'utf8'));
  if (previous && previous !== process.pid) {
    try {
      process.kill(previous, 'SIGTERM');
      console.log(`stopped the previous feeder (pid ${previous})`);
    } catch {
      // Already gone.
    }
  }
}
writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => {
  // Leave the file to a newer feeder that took over.
  if (
    existsSync(PID_FILE) &&
    Number(readFileSync(PID_FILE, 'utf8')) === process.pid
  )
    rmSync(PID_FILE, { force: true });
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => process.exit(1));
const scope = createHash('sha256')
  .update(`${uri}/${database}`)
  .digest('hex')
  .slice(0, 24);
const TOKEN_FILE = `.local/feeder-${scope}-token`;
/** Separate identity for the LLM planner: usage reports need a service member. */
const PLANNER_TOKEN_FILE = `.local/feeder-${scope}-planner-token`;
/** Views the LLM planner reads (the run's score and its waiting tasks). */
const PLANNER_QUERIES = ['SELECT * FROM ui_metrics', 'SELECT * FROM ui_tasks'];
const VIEWERS_FILE = `.local/feeder-${scope}-viewers`;
const viewers = new Set(
  existsSync(VIEWERS_FILE)
    ? readFileSync(VIEWERS_FILE, 'utf8').split('\n').filter(Boolean)
    : [],
);
const newViewer = flag('viewer', '');
if (newViewer && !/^[0-9a-f]{64}$/i.test(newViewer))
  throw new Error('Invalid viewer identity');
if (newViewer) {
  viewers.add(newViewer.toLowerCase());
  writeFileSync(VIEWERS_FILE, [...viewers].join('\n') + '\n');
}

/** Connects with a stored identity and subscribes to the runs view (plus `extra`). */
function connect(tokenFile = TOKEN_FILE, extra: string[] = []) {
  return new Promise<DbConnection>((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.disconnect();
      reject(new Error('Database connection timed out'));
    }, 10000);
    const connection = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(database)
      .withToken(
        existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8') : undefined,
      )
      .onConnect((conn, _identity, token) => {
        writeFileSync(tokenFile, token, { mode: 0o600 });
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timer);
            resolve(conn);
          })
          .onError((ctx) => {
            clearTimeout(timer);
            conn.disconnect();
            reject(ctx.event);
          })
          .subscribe([
            'SELECT * FROM ui_runs',
            'SELECT * FROM ui_policy_catalog',
            ...extra,
          ]);
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
async function main(scenario: NonNullable<ReturnType<typeof scenarioById>>) {
  const extra = planner === 'llm' ? PLANNER_QUERIES : [];
  let conn = await connect(TOKEN_FILE, extra);
  if (
    ![...conn.db.uiPolicyCatalog.iter()].some((p) => p.name === 'primal_dual')
  ) {
    conn.disconnect();
    throw new Error(
      'Database module is out of date: publish the current module with primal_dual before starting scenarios.',
    );
  }
  // Two more runs must fit under the owner limit; otherwise start as a new identity.
  if (
    [...conn.db.uiRuns.iter()].filter((r) => r.canControl).length + 2 >
    OWNER_RUN_LIMIT
  ) {
    console.log('feeder identity owns 10 runs: switching to a new identity');
    conn.disconnect();
    rmSync(TOKEN_FILE, { force: true });
    conn = await connect(TOKEN_FILE, extra);
  }
  console.log(`feeder identity ${conn.identity!.toHexString()}`);

  if (!viewers.size)
    console.log(
      'no --viewer given: only this feeder identity can see the runs',
    );
  // The scenario's customers: the mock's first ones (same seed, same arrival
  // pace), each ordering the scenario's share of drinks.
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
  // LLM planner: its own service identity reports usage; the feeder (run
  // owner) writes the priorities and grants that identity once the runs exist.
  const reporter =
    planner === 'llm' ? await connect(PLANNER_TOKEN_FILE) : undefined;
  let llm: LlmPlanner | undefined;
  try {
    const ids = await driveScenario(conn, {
      seed: SEED,
      load: scenario.load,
      n: scenario.n,
      customers,
      trays,
      tickMs,
      viewers: [...viewers],
      log: console.log,
      planner: planner === 'llm' ? 'llm' : 'algorithm',
      onRuns: reporter
        ? ({ sync }) => {
            const granted = conn.reducers.grantMember({
              runId: sync,
              identity: Identity.fromString(reporter.identity!.toHexString()),
              permission: 'service',
              enabled: true,
            });
            llm = new LlmPlanner({
              conn,
              runId: sync,
              log: console.log,
              report: async (u) => {
                await granted;
                await reporter.reducers.reportUsage({
                  runId: sync,
                  externalKey: u.key,
                  taskId: undefined,
                  attempt: undefined,
                  source: 'coordinator',
                  inputTokens: BigInt(u.inputTokens),
                  outputTokens: BigInt(u.outputTokens),
                  reportedCostMicrousd: BigInt(u.costMicrousd),
                  wallMilliseconds: u.ms,
                });
              },
            });
            console.log(`llm planner: on for run ${sync}`);
          }
        : undefined,
      beforeStep: (tick) => llm?.beforeStep(tick),
    });
    console.log(
      `done: ${scenario.id} runs ${ids?.baseline} and ${ids?.sync} completed`,
    );
  } catch (error) {
    console.error(
      `Scenario failed: ${error instanceof Error ? error.message : 'Database operation failed'}. Check pnpm db:logs and publish the latest module.`,
    );
    process.exitCode = 1;
  } finally {
    conn.disconnect();
    reporter?.disconnect();
  }
}
main(scenario).catch(() => {
  console.error(
    'Scenario failed: cannot connect or subscribe to the configured database. Check the server URL and publish the current module (ui_runs and ui_policy_catalog are required).',
  );
  process.exitCode = 1;
});
