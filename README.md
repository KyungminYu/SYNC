# SYNC

A local foundation for resource-aware scheduling of multi-agent workflows. Four logical workers share constrained stations in a seeded kitchen demonstration. Generic scheduling remains independent of the presentation.

## Start locally

Prerequisites: Node **22.22.3** (recorded in `.node-version`; Node 24 LTS also supported), pnpm **11.25.0**, and SpacetimeDB **2.13.0**. Use the [official SpacetimeDB installer](https://spacetimedb.com/install), select 2.13.0, and check `spacetime --version`. This checkout also detects the locally downloaded Windows binaries in ignored `.tools/spacetime/`. Set `SPACETIME_CLI` to override the CLI path.

```sh
pnpm install --frozen-lockfile
pnpm db:start
```

Keep that terminal running. In a second terminal:

```sh
pnpm db:publish
pnpm db:generate
pnpm dev
```

Open http://127.0.0.1:5173. Create a run, copy the **public service identity** printed by the agent process into **Authorize agent service**, authorize it, then Start. No API key is needed. The run completes eight tasks and releases its reservations. Controls remain disabled until subscriptions apply.

`pnpm dev` preflights the separately running database and starts Vite and the long-running agent with a cross-platform process runner. It does not publish. Agent source changes require restarting the process; Vite supports hot reload. Stop processes with Ctrl+C.

## Architecture and boundaries

- `spacetimedb/`: authoritative rows, ownership checks, transactional admission, claims, reservations, and scheduled 500 ms logical ticks. Public tables contain demonstration state only. Registration and schedule tables are private. Events are ordinary retained rows.
- `packages/sync-core/`: dependency eligibility, two deterministic policies, proposal validation, timing and completion guards. No runtime dependencies or platform APIs. It is actually bundled into the module by the CLI.
- `packages/contracts/`: Zod contracts for configuration, observations, action proposals, results, IDs, reasons, and health responses. JSON u64 values are validated decimal strings; SDK/database IDs remain `bigint`.
- `packages/test-fixtures/`: explicitly labeled seeded graph, arrivals, workers, and capacities.
- `packages/bindings/`: canonical generated client bindings consumed by both applications. Never hand edit these files. `pnpm db:generate` rebuilds and regenerates them locally without publishing.
- `apps/agent-service/`: Express health endpoints, persistent SDK connection, bounded concurrent job processing, deterministic and Anthropic providers. No custom WebSocket server or secondary database.
- `apps/web/`: React SDK subscriptions, controls, honest observed metrics, Recharts state counts, and Phaser presentation. Phaser interpolates worker markers and never advances authoritative time.

The distinction matters: a **worker proposes** `start_operation`; the database **admits and reserves** the assignment transactionally before issuing the job; accepted proposals begin **simulated execution**; only the scheduled reducer commits **completion** after the authoritative duration. Model output cannot declare success.

FCFS orders ready tasks by release then ID. The greedy policy sorts by `100 / max(1, deadline - tick - duration) + 2 * waitingAge - duration` (the first term is zero without a deadline), then ID. Both choose compatible idle workers in ID order and update tentative resource availability after each assignment. Both use identical admission and completion logic. The `plan(snapshot, { policy })` proposal boundary is the extension point for later lookahead; this heuristic is not globally optimal or claimed to be novel.

## Identity and authorization

The browser persists its controller token in localStorage, scoped by URI and database. The agent persists its token in ignored `.local/agent-token`, or accepts `SPACETIMEDB_TOKEN`. Its public identity is also written to `.local/agent-identity`. Do not delete these tokens to restart; deleting a token changes the identity and loses existing ownership/authorization. Use one local service identity per checkout. Windows local database signing keys and CLI credentials also live in `.local/`; preserve them with the database directory.

Only the run controller can start, pause, reset, schedule manually, or authorize a service. An arbitrary caller cannot self-register. Claims are transactional, and results require the exact claiming identity and current task attempt. **Run-filtered subscriptions are not authorization.** This foundation deliberately exposes all non-sensitive demo rows publicly; it is not a private multi-tenant application.

Reset retires the old run, removes its schedule, and creates a new paused run ID with the same seed, policy, controller, and service registrations. Old events, jobs, reservations, and task rows remain historical and cannot affect the new run. Results targeting retired runs are rejected. Completed runs remove their schedule; paused runs retain one schedule whose callbacks do not advance logical time.

## Configuration

Defaults work without copying environment files. To customize, copy each application's `.env.example` to `.env` in the same directory. Vite loads its file; the service uses Node's native environment loading. The root workspace commands set the application working directories.

Web: `VITE_SPACETIMEDB_URI`, `VITE_SPACETIMEDB_DATABASE`. The browser does not call the agent's HTTP endpoints, so there is no agent URL or CORS middleware. Never put secrets in VITE variables.

Service: `PORT`, `LOG_LEVEL`, `SPACETIMEDB_URI`, `SPACETIMEDB_DATABASE`, optional `SPACETIMEDB_TOKEN`, `AGENT_MODE`, `AGENT_MAX_CONCURRENCY` (1–4), `AGENT_TIMEOUT_MS` (1–120 seconds), `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`.

`GET http://127.0.0.1:3001/health` is process liveness. `/ready` returns 503 until the database subscription applies and 200 afterward. Readiness does not imply controller registration for every run.

### Claude mode

Set `AGENT_MODE=claude` and a server-only `ANTHROPIC_API_KEY`, then restart the service. The configurable default is `claude-sonnet-4-6`, listed by [Anthropic's model documentation](https://platform.claude.com/docs/en/models/sonnet-4-6/overview). The official SDK sends one bounded observation and forces one constrained tool call. Zod and semantic checks validate its target; the database validates it again. Token usage is logged when returned. There are no movement-tick model calls, conversation accumulation, automatic request retries, or silent deterministic fallback. Missing credentials fail startup clearly. **Live Claude execution has not been verified because no API key was supplied.**

### Uncertain recovery

A failed proposal/submission or an owned claim discovered after reconnect is marked `uncertain` where connectivity permits. Such jobs retain reservations and are not automatically retried. If the connection failed before marking, reconnect discovers and marks the claim. Inspect database events and service logs; for this simulation, use controller Reset to create a fresh generation. There is no automatic replay of potentially unknown external effects. This scaffold does not perform external effects beyond the model request.

## Commands and checks

```sh
pnpm dev:web            # Vite only
pnpm dev:agents         # long-running Node agent only
pnpm db:logs            # local database logs
pnpm build             # generate bindings, strict typecheck, production web build
pnpm typecheck         # generate bindings, strict typecheck across workspace
pnpm lint
pnpm format
pnpm format:check
pnpm test              # pure, contract, module, HTTP, and React checks
pnpm test:integration  # requires db:start, db:publish, and dev:agents
pnpm benchmark:smoke
```

Module tests use SpacetimeDB 2.13's real in-memory transactional datastore through its Vitest plugin. Integration creates an additional retained fixture run, authorizes the running service, waits for completion, and asserts eight accepted jobs, unique completion events, free workers, and zero reservations. Its controller token is retained in `.local/`. It never deletes a database or resets unrelated runs.

The headless benchmark uses the same fixture, eligibility, proposal validator, timing rule, and completion guard. It assumes zero transport/model latency and reports measured scheduler wall-clock time separately from logical ticks. On the verified seed 42, **both** policies completed eight tasks at tick 15 with zero deadline misses. This is a functionality check, not production performance evidence or an improvement claim.

## Selected versions and compatibility

CLI, server, module SDK, client SDK, and generated binding metadata are **2.13.0**. The local module build and publish verify the V8 bundle, including workspace imports. Only the dependency-free core and fixture package enter that bundle; Anthropic, Express, Zod, and Node APIs stay outside it.

Installed versions include React/React DOM 19.3.1, Vite 8.3.5, TypeScript 5.9.3, Tailwind 4.3.3 (official Vite plugin), Phaser 4.2.1, Recharts 3.10.1, Anthropic SDK 1.1.0, Express 5.3.0, Zod 4.6.7, Vitest 5.0.5, and ESLint 10.13.0. Exact full resolution is in `pnpm-lock.yaml`. Node 22.22.3 ran checks and services; this machine's pnpm launcher itself uses Node 24.22.1.

Implementation references: [SpacetimeDB TypeScript client and React hooks](https://spacetimedb.com/docs/clients/typescript/), [reducers](https://spacetimedb.com/docs/functions/reducers/), [schedule tables](https://spacetimedb.com/docs/tables/schedule-tables/), [module tests](https://spacetimedb.com/docs/how-to/unit-testing/), [V8 modules](https://spacetimedb.com/docs/intro/language-support/), [Anthropic TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript), [Phaser React/Vite template](https://github.com/phaserjs/template-react), [Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite).

## Troubleshooting and limits

- Connection refused: keep `pnpm db:start` running, publish once, then restart `pnpm dev`. Local firewall/sandbox access must permit loopback connections.
- Tasks remain assigned: authorize the identity printed by the running service for this run. Check `/ready` and logs. An uncertain job requires inspection/reset, not automatic retry.
- Changed schema: regenerate bindings and explicitly publish. Ordinary builds never publish or delete data. Breaking schema changes intentionally require an explicit migration decision.
- Node mismatch: use `.node-version` or Node 24 LTS, then reinstall with the pinned pnpm. `allowBuilds` explicitly permits esbuild's install script.
- Lost controller token: create a new run with the new browser identity. Existing run ownership is not transferable in this foundation.
- Public demo state and event history accumulate. There is no production retention policy, tenant privacy, service revocation UI, claim lease, or recovery beyond fresh-run reset. The initial graph is fixed in size; seeds vary operation durations.
- Phaser makes the production bundle large. Asset splitting and further UI accessibility work remain follow-up tasks. There is no full game, global optimizer, cloud deployment, or production performance claim.

Next priorities: (1) audited service revocation and explicit uncertain-job recovery, (2) broader seeded workload/benchmark coverage and joint-assignment experiments, (3) private run access, retention, and richer replay visualization.
