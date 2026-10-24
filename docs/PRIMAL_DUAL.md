# Online primal-dual scheduling in SYNC

Select the backend policy with `set_policy({ runId, configJson: '{"policy":"primal_dual"}' })` (generated TypeScript: `connection.reducers.setPolicy`). The six existing policies remain available for comparisons. The default remains `sync_greedy`; the dashboard and its source adapter are unchanged.

## Packing model

At each planning event, an alternative is a ready task, compatible worker, and integer start tick. Binary choices select at most one alternative per task. Each choice consumes multiple dimensions simultaneously:

- Worker occupancy in each covered tick.
- Every required resource's units in each covered tick, including duplicate requirements aggregated together.
- A clean tray permit, held conservatively for the entire horizon. A predicted return does not supply a new permit.
- Modeled cost against the remaining cumulative budget. Completion transfers reserved cost to spent cost; it does not replenish budget.

For choice c, utility is `(1 + value + priority + 0.05 * cappedAge + 0.1 * cappedLateness) / (1 + 0.05 * startDelay)`. Age is capped at 300 and lateness at 30 ticks. This rewards urgent ready work and discourages delay; it is a task-level objective, not realized order revenue.

The packing objective is maximize `sum utility[c] * x[c]`, subject to one choice per task and `sum demand[c,k] * x[c] <= residualCapacity[k]` for every dimension k.

Prices use projected subgradient updates:

`price[k] = clamp(price[k] + 2/sqrt(iteration+1) * (relaxedLoad[k]-capacity[k])/max(1,capacity[k]), 0, 100)`.

The relaxed primal chooses one positive reduced-utility alternative per task. Reduced utility subtracts the sum of price times normalized demand. Each iteration repairs choices against exact remaining capacities. The highest-utility repaired plan wins, with an unpriced feasible incumbent to avoid price-induced idling. Feasibility and monetary arithmetic use bigint; floating point is confined to scoring and prices. No competitive ratio or global optimality is claimed.

## Rolling execution

`domain/rollingHorizonEngine.ts` uses a 24-tick horizon, 16 dual iterations, at most 4,096 alternatives, and an 8-tick safety refresh. Start-time-first enumeration prioritizes immediate alternatives under the cap. These fixed settings are exported as `ROLLING_CONFIG`; the older policy weight fields do not tune this policy.

Only the currently ready frontier is forecast. Dependencies, release guards, and customer-use waits are resolved by the authoritative engine before a task enters that frontier. This implementation does not forecast the full unready DAG. A task longer than the horizon occupies every remaining horizon slot and retains its true finish estimate.

Running work supplies predicted capacity only at its expected finish; unconfirmed, uncertain, and overdue work holds capacity across the horizon. Predictions never remove actual reservations. Only choices whose start equals the current tick pass through the existing transactional admission checks. Future choices are replanned, never blindly dispatched from stored JSON.

Replanning occurs when the decision-relevant state changes (arrivals, readiness/completion, resource availability/capacity, budget, worker state, policy, ownership) or when the next planned start/safety refresh becomes due. Clock ticks alone do not invoke optimization. Paused/completed runs do not dispatch. The fingerprint is captured after immediate admission to avoid triggering on the planner's own writes.

## Database and frontend handoff

The additive private `sync_planner` table stores one row per planned run: last/next planning tick, replan count, source snapshot version, trigger, objective, candidate count/cap flag, warm prices, forecast, and internal fingerprint. State persists in the same transaction as task admission. Absolute-time prices expire when they leave the horizon; budget and tray prices remain warm.

Subscribe to `SELECT * FROM ui_planner`. This view exposes planner diagnostics only to the owner and enabled viewer/operator members. Service-only and unrelated identities cannot read it. JSON forecast IDs and costs are decimal strings, not JavaScript numbers. `plan_json` is advisory, tied to `snapshot_version` and `last_plan_tick`; render current execution from `ui_tasks`/`ui_resources`. `prices_json` holds the final dual iterate, not necessarily the prices from the winning repaired plan. The forecast is the last planning result and may include choices already dispatched or completed.

New control reducers (owner/operator only):

- `set_resource_capacity({runId, resourceId, capacity})`: rejects a reduction below active reservations; zero prevents new assignments.
- `set_modeled_budget({runId, budgetMicrousd})`: optional u64, undefined removes the limit; rejects a cap below spent plus reserved cost.

Generated bindings are in `packages/bindings/src`. No UI layout changes or live adapter wiring are included. Use the new policy catalog entry and planner view when connecting the dashboard.

## Verification and deployment

`pnpm test:domain` covers complete DAG execution, future-only forecasts, event suppression/wakeups, deterministic replay, warm prices, large exact budgets, capacity changes, and unconfirmed work. Module tests cover persisted reducer execution and planner-view identity isolation. `pnpm build` regenerates bindings and validates the frontend build.

The integration script accepts `SYNC_DATABASE` to target a separate local database and exercises the primal-dual policy over real subscriptions. Publish with `--delete-data=never`; do not clear a teammate's database to accept a schema update. The existing removal of the order recipe index is preserved as supplied by the user.

Benchmark throughput, deadline misses, and realized order value against FCFS and the existing joint policy on identical arrival streams before making USP performance claims. Large runs may hit the candidate cap; the view reports this explicitly. Global DAG lookahead, predicted tray reuse, and automatic parameter tuning are future extensions.

Validated in this workspace: 54 domain tests, 66 module/UI tests, strict type checking, lint, module compilation, and production frontend build. Real subscriptions against the separate local `sync-primal-dual-check` database completed two orders under `primal_dual` and verified identity isolation and membership revocation. The existing development database was not published or reset.
