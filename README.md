# SYNC — database integration handoff

The authoritative coffee-shop module is in `spacetimedb/src`. The previous kitchen demo, seeded UI, Phaser scene, deterministic/Claude service workers, duplicate shared scheduler/contracts, fixture package, and old benchmark have been removed. React and the agent service are **integration placeholders**, not completed applications.

## Start here

- [Live scenario repair and Maincloud migration](docs/LIVE_SCENARIO_REPAIR.md): Windows launcher fix, shared environment configuration, scenario validation, and publication commands.

- [Integration handoff](docs/INTEGRATION_HANDOFF.md): generated names, subscription flow, service responsibilities, and outstanding work.
- [Schema and UI contract](docs/SCHEMA_AND_UI.md): fields, identity rules, keys, and UI view semantics.
- [Primal-dual engine](docs/PRIMAL_DUAL.md): rolling execution, dynamic constraints, and the planner subscription contract.
- [Policies and recovery](docs/POLICIES.md): baseline policies, invariants, permissions, budgets, and reconciliation.
- [Local validation](docs/VALIDATION.md): checks actually performed against this workspace.

## Setup

Node 22.22.3 or Node 24 LTS, pnpm 11.25.0, and SpacetimeDB CLI/server/SDK 2.13.0. The existing Windows binaries in ignored `.tools/spacetime` are supported; otherwise install the official CLI or set `SPACETIME_CLI`. TypeScript is pinned to 5.9.3. Exact dependency resolutions are in `pnpm-lock.yaml`.

```sh
pnpm install --frozen-lockfile
pnpm db:start
```

Keep the database terminal running, then in another terminal:

```sh
pnpm db:publish
pnpm db:generate
pnpm dev
```

The target is **sync-coffee-dev** at `http://127.0.0.1:3000`. It is a fresh schema, not an automatic migration of `sync-local`. Publish never deletes data. Existing demo databases and ignored tokens are untouched. Update any existing application `.env` files that still name the old database.

Web: `http://127.0.0.1:5173`. It only shows connection/subscription status and integration instructions. It creates no runs or orders. The browser persists its identity in localStorage per URI/database.

Agent placeholder: `http://127.0.0.1:3001/health` returns liveness; `/ready` deliberately returns **503** because database/job/Claude integration is not implemented. It does not read old service tokens, claim work, call a model, or submit fake results. Only `PORT` is currently consumed from its `.env`.

## Database responsibilities

The module owns private execution and planner tables, caller-filtered UI views, a static policy catalog, and a service-only job view. It models black-coffee/latte DAGs, seven workers, station capacities 2/2/2/1, order-owned trays, budgets, job claims, attempts, and retained events. Scheduled callbacks advance logical ticks every 200 ms while running.

Policies: `fcfs`, `earliest_finish`, `minimum_slack`, `critical_path`, `sync_greedy`, `bounded_joint`, `primal_dual`. There are no automatic seeded orders or invented performance metrics. Deterministic mode is the new module's actual execution mode, not a removed client mock. Recipe durations and costs remain illustrative modeled values as documented in the supplied module.

## Developer commands

```sh
pnpm db:build          # compile the actual module, no publish
pnpm db:generate       # canonical bindings in packages/bindings/src
pnpm db:publish        # explicit local publish, never delete/reset
pnpm db:logs
pnpm build             # generate, strict typecheck, build UI placeholder
pnpm typecheck
pnpm lint
pnpm format
pnpm format:check
pnpm test              # domain tests + real SDK transaction/view harness
pnpm test:domain
pnpm test:module
pnpm test:integration  # explicit real-host test; requires published database
pnpm dev:web
pnpm dev:agents
```

Tests retain small test-only inputs/doubles; none are loaded by either application. The opt-in host integration test creates a private verification run, enqueues two orders, and exercises real scheduled execution and subscriptions. `dev`, `build`, and publication do not insert test orders. The old benchmark command was removed with the fixture implementation.

No Git commits or pushes are made by the setup workflow. The remaining teammate work is implementing the real UI and the authorized Claude service against the generated API.
