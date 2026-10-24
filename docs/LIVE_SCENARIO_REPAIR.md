# Live scenarios: fixes and Maincloud migration

## What was wrong

The dev plugin spawned `node_modules/.bin/tsx` as an executable. On Windows that path is not a native executable, so spawn emitted ENOENT. Without an error listener, Node terminated Vite and the shared dev runner stopped everything.

The plugin now starts the current Node executable with `--import tsx`. It waits for the spawn event, handles both launch and later process failures, reports status to the dashboard, prevents concurrent feeders, and terminates its child when the dev server closes. The picker displays failures and permits retry, including after a previous incomplete run. Unrun options no longer mark their Run buttons disabled for accessibility tools.

The root `.env` had an authentication token in `SPACETIME_URI`. It has been moved to the ignored server-only `SPACETIMEDB_TOKEN` variable and the URI set to Maincloud as requested. That token is not used as a browser identity or automatically imported into the CLI. Use the interactive CLI login below to replace its stale local credentials. Connection settings are now shared by Vite, the feeder, dev startup, and publish/log/describe commands. Only URI and database name enter the browser bundle.

Configuration precedence: root env files, then apps/web env files, then process environment. Within each directory: `.env`, `.env.local`, mode-specific env, mode-specific local env. `VITE_SPACETIMEDB_*` aliases override their non-VITE counterpart within a layer. Remove stale app-specific overrides when using root configuration.

SYNC scenario runs now select `primal_dual`; Baseline selects `fcfs`. All nine scenarios use identical arrivals for both policies. Inputs are validated before creating runs. Tokens/viewer lists are isolated per server/database. Each pair gets a shared batch identifier so reruns never compare with an older counterpart. Completed pairs remain replayable while a newer pair is incomplete.

## Hosted schema actually inspected

Maincloud database `sync-16o06` currently exposes the legacy demo schema (`run`, `task`, `worker`, `create_demo_run`) rather than the current coffee schema (`sync_*` tables and `ui_*` views). The legacy public `run` table had zero rows at inspection. This does not prove every other table is empty. The old module cannot satisfy the current dashboard subscriptions.

The local CLI profile initially returned `Invalid token: InvalidSignature`. Public schema inspection succeeded anonymously. No hosted schema or data has been modified by this repair.

## Apply the current module from PowerShell

From `A:\Projects\SYNC`:

```powershell
pnpm db:login
pnpm build
pnpm db:publish --break-clients
pnpm db:describe
pnpm run dev
```

`db:login` uses the same workspace CLI profile as publish. Complete the browser sign-in with the account that owns `sync-16o06`. The publish command reads your root `.env` and targets Maincloud / `sync-16o06`. It always supplies `--delete-data=never`. `--break-clients` permits replacing the legacy API without authorizing deletion of stored data. The CLI can ask you to confirm remote publication. Restart clients after publishing; the build regenerates current bindings.

SpacetimeDB migrations are applied by republishing the module, not by pasting CREATE TABLE statements into the dashboard. Compatible additions migrate automatically. Removing nonempty tables or changing existing column layouts is not automatically data-preserving. Official guidance: https://spacetimedb.com/docs/databases/automatic-migrations/ and https://spacetimedb.com/docs/cli-reference/.

If publish reports nonempty legacy tables or an unsupported schema change, stop there. Do not change the command to delete data. For this demo-to-coffee schema replacement, use a separate database and retain the old one:

```powershell
$env:SPACETIMEDB_DATABASE = 'sync-coffee-v2'
pnpm db:publish
pnpm run dev
```

Choose an available database name if that name is taken. After successful publication, set `SPACETIMEDB_DATABASE=sync-coffee-v2` in root `.env` for future terminals and remove the temporary shell override with `Remove-Item Env:SPACETIMEDB_DATABASE`. Retaining the same database identity with populated legacy tables instead requires a separate staged data-migration design; old demo tasks are not automatically convertible to customer carts and recipes.

## Verify from the UI

Open `http://127.0.0.1:5173`, choose Live, open the scenario menu, and run Low-3. Baseline and SYNC should appear and advance together. The feeder uses its own application identity and grants the browser viewer access. A publishing/admin token is not needed in the browser. These scenario buttons execute authoritative deterministic database tasks. For real worker processes and cancellation, see [Cart execution](CART_EXECUTION.md).

A CLI equivalent is `pnpm feed --scenario Low-3 --viewer <browser-identity>`; copy the identity from the dashboard's empty-state command. `--ms 0` removes pacing for verification; default feeder pacing is 1500 ms per logical tick. Sample mode retains the explicitly labeled sample dataset and completed real scenarios.

Live scenario creation remains a local-dev feature. A production static Vite build has no feeder endpoint or Run buttons; it can read/replay authorized runs. Deploying a production scenario-runner service is separate work.

## Verification

All nine scenario definitions (40 through 88 drinks per shop) complete under both policies in domain tests, with capacity and completion invariants checked. Regression tests cover Windows-safe launching, launch failure, asynchronous failure, concurrency, shutdown, cross-origin rejection, credential-safe configuration errors, pair selection, and status propagation. A real local Low-3 feeder run completed 24 customers / 40 drinks in each shop through SpacetimeDB subscriptions. Maincloud execution awaits the publication step above.
