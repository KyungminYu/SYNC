# SYNC

SYNC coordinates finite worker, station and reusable-resource capacity through an authoritative SpacetimeDB execution engine. The dashboard shows actual subscribed runs and explicitly labeled sample scenarios.

- [Cart decomposition, external workers, cancellation and benchmarking](docs/CART_EXECUTION.md)
- [Maincloud publication and environment repair](docs/LIVE_SCENARIO_REPAIR.md)
- [Single-container and Vercel deployment](docs/PRODUCTION.md)
- [Primal-dual planner](docs/PRIMAL_DUAL.md)

## Setup

Use Node 22.22.3 or Node 24, pnpm 11.25.0 and SpacetimeDB 2.13.0. Root `.env` supplies `SPACETIME_URI` (a server URL) and `SPACETIMEDB_DATABASE`. Never put tokens in `VITE_*` variables. Existing ignored Windows binaries in `.tools/spacetime` are supported.

```powershell
pnpm install --frozen-lockfile
pnpm db:login
pnpm build
pnpm db:publish --break-clients
pnpm dev
```

Publish targets the configured server/database and always uses `--delete-data=never`. See the migration guide before replacing a legacy schema. For local development, start `pnpm db:start` separately and point the URI to `http://127.0.0.1:3000`.

The dashboard runs at `http://127.0.0.1:5173`. Its nine scenario buttons create paired deterministic database runs with identical arrivals. These are distinct from externally executed runs.

## Real worker processes

```powershell
pnpm agents:demo --cancel-once --viewer <dashboard-identity>
```

This opt-in smoke test starts real worker subprocesses using an explicitly simulated coffee adapter. It exercises scale-up, task execution and cancellation. Stop another agent service on port 3001 first, or set `PORT` to a different port. For real tools/models, provide `SYNC_AGENT_ADAPTER` and `SYNC_AGENT_RUN_ID`, grant service membership and run `pnpm dev:agents`; see the adapter contract and recovery instructions in the cart execution guide. No AWS or model-provider integration is implied by the demo adapter.

## Validation and benchmarks

```powershell
pnpm test
pnpm build
pnpm lint
pnpm benchmark --scenario Low-3 --seeds '5,17,29'
```

Benchmarks record measured local planning time and optimizer overhead separately from modeled execution dollars, terminal reward, lateness and staffing penalties. The planner is a bounded primal-dual heuristic over the revealed DAG; it does not claim exact optimality. Output is saved in `.local/benchmarks/latest.json`.

The system starts with four enabled workers and may scale to seven slots (cashier 2, barista 2, server 2, cleaner 1). Duplicate drinks remain distinct order instances; shared preparation is mapped back to each cart before delivery. External outcomes require fenced worker acknowledgements. Cancellation and uncertain effects never silently release physical capacity.
