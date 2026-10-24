# Integration handoff

Current cart/external-worker changes supersede the earlier placeholder/frontier-only descriptions below. See [Cart execution](CART_EXECUTION.md) for the current contract and migration notes.

## Entry points and ownership

`spacetimedb/src/index.ts` exports the single schema from `tables.ts`, reducers from `runtime/reducers.ts`, and views from `runtime/views.ts`. The pure engine and six policies are now owned by this module. Do not restore the old `packages/sync-core`, `contracts`, or `test-fixtures` definitions: they describe a different domain/API.

Both applications depend on **@sync/bindings**, whose sole generated source is `packages/bindings/src`. Run `pnpm db:generate` after module edits. Never edit generated files or create a second binding copy. SpacetimeDB 2.13.0 normalizes SQL snake_case names to camelCase client accessors.

The README supplied with the source bundle contained illustrative `--project-path` commands. This installed CLI uses **--module-path**; the checked-in scripts use its verified syntax. Publishing targets `sync-coffee-dev`, preserving the earlier `sync-local` database.

## UI teammate

The placeholder keeps Vite, React, Tailwind, validated URI/database configuration, persisted identity, and the official React SDK provider. Its only live data hook is `useTable(tables.uiRuns)`, used to expose subscription readiness. No metrics, orders, workers, policy controls, game scene, or automatic mutations are prepopulated.

Start with `tables.uiRuns` and `tables.uiPolicyCatalog`. The generated cache accessors are `connection.db.uiRuns`, `uiOrders`, `uiTasks`, `uiDagEdges`, `uiWorkers`, `uiResources`, `uiTrays`, `uiDecisions`, `uiEvents`, `uiMetrics`, and `uiPolicyCatalog`. Views contain camelCase client fields: SQL `run_id` becomes `runId`, `can_control` becomes `canControl`, and `reserved_units` becomes `reservedUnits`.

Create a run explicitly:

```ts
await connection.reducers.createRun({
  name: 'Coffee workflow',
  seed: 42,
  trayCount: 2,
  mode: 'deterministic',
  budgetMicrousd: undefined,
});
```

Observe its ID from `uiRuns`; reducers do not return the inserted row. `seed` records experiment metadata; it does not generate arrivals. Subscribe to the selected run's views only after validating its bigint ID, and wait for `onApplied` before rendering cached rows as ready:

```ts
if (runId <= 0n || runId > 18_446_744_073_709_551_615n)
  throw new Error('Invalid run ID');
const subscription = connection
  .subscriptionBuilder()
  .onApplied(() => {
    /* mark selected run ready */
  })
  .onError((ctx) => {
    /* clear ready state and surface ctx.event */
  })
  .subscribe([
    `SELECT * FROM ui_tasks WHERE run_id = ${runId.toString()}`,
    `SELECT * FROM ui_workers WHERE run_id = ${runId.toString()}`,
    `SELECT * FROM ui_metrics WHERE run_id = ${runId.toString()}`,
  ]);
// On run change/unmount: subscription.unsubscribe();
```

Always filter cached rows by `runId`; the cache may contain multiple subscriptions. Use the composite `key` for child rows—local `id` values can repeat across runs. Preserve bigint values; use decimal strings at JSON boundaries, never Number(id). Sort explicitly when display order matters.

Generated command names:

- `enqueueOrder({runId, externalKey, recipe, deadlineInTicks, value, priority, customerUseTicks})`: `recipe` is `black_coffee` or `latte`; provide a distinct stable idempotency key per order.
- `setRunStatus({runId, running})`: start/pause; `stepRun({runId})`: paused-only step.
- `setPolicy({runId, configJson})`: validated partial configuration. Populate the selector from `uiPolicyCatalog`; see POLICIES.md for scoring parameters.
- `closeArrivals({runId})`: end the arrival stream. Completion waits for delivery **and cleanup**; idle open runs remain available for future orders.
- `setResourceAvailable`, `grantMember`, `markJobUncertain`, `reconcileJob`: controlled operations with generated parameter definitions.

There is no old `createDemoRun`, `startRun`, `pauseRun`, `resetRun`, or `registerService`. A fresh experiment uses `createRun`; no reset reducer is supplied. Respect `canControl` in the UI but rely on reducers for enforcement. Query filtering is not authorization: the server applies identity-based access before WHERE filters.

## Agent teammate

The service is intentionally only a long-running HTTP placeholder. `/ready` must remain 503 until the real configured database subscription has applied. No automatic deterministic-worker or Claude fallback exists. Deterministic database mode requires no service at all.

For Claude mode, implement this sequence:

1. Connect with a stable, securely persisted identity/token. Ask the owner to call `grantMember({runId, identity, permission: 'service', enabled: true})`; services cannot authorize themselves.
2. Subscribe to SQL `service_jobs` (generated `tables.serviceJobs`, `connection.db.serviceJobs`). Service permission does not grant ordinary UI view access.
3. Deduplicate with `(runId, id)`/`key`, not just local job ID. Call `claimAgentJob({runId, jobId: job.id})`; verify authoritative `status` and `mine` before model invocation.
4. Supply only `observationJson` to the bounded provider context. Validate the proposal and submit `submitAgentAction({runId, jobId, attempt, action: expectedAction})`. The model never declares completion; the database executes the accepted operation.
5. Use `reportUsage({runId, externalKey, taskId, attempt, source, inputTokens, outputTokens, reportedCostMicrousd, wallMilliseconds})` for observed provider/coordinator usage. `externalKey` should be a stable request ID. Source is `anthropic` or `coordinator`; cost and tokens use bigint. Modeled budgets are not Anthropic billing caps.
6. Bound concurrency, context, request timeouts, and actual spend. Do not silently switch modes or retry unknown external effects.

Pause rejects newly submitted actions until resumed. Lost claims have no guessed expiry. Operators can mark uncertainty; only owners reconcile with `resume` or `retry_safe`. Read POLICIES.md before implementing recovery. Preserve reservations, trays, and attempts until authoritative reconciliation.

## Local compatibility adjustments

Compared with the supplied source: the run insert explicitly supplies `budgetMicrousd` (SDK optional columns require a property with undefined); post-tick completion reads persisted status to avoid TypeScript's pre-mutation narrowing; view payload type names have a `Payload` suffix to avoid SDK-generated name collisions; an unused policy comparator initialization was removed. The domain semantics and six policies are retained.

The standalone domain tests run through `node --import tsx --test` to support this workspace's Node 22 and Node 24, rather than requiring Node 24 native stripping. Test fixtures remain confined to explicit tests; no smoke benchmark or test-data creation runs with the applications.
