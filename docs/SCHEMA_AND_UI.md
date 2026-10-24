# SYNC database schema and UI contract

Current cart/external-worker changes supersede the earlier placeholder/frontier-only descriptions below. See [Cart execution](CART_EXECUTION.md) for the current contract and migration notes.
This document describes the source bundle, not a generic future schema. Its authoritative definitions are `spacetimedb/src/tables.ts`, `domain/model.ts`, `runtime/reducers.ts`, and `runtime/views.ts`.

The supplied _Problem_Formulation_and_Solution.pdf_ grounds the generic requirements: dynamically revealed tasks, compatibility, dependencies, shared capacity, online scheduling, atomic admission, attempt fencing, and honest coordination-cost evaluation. The coffee recipes, serving-tray lifecycle, illustrative durations, and seven-worker demo configuration are domain-adapter decisions from the project discussion; they are not claims extracted from that generic PDF.

## Implementation boundaries

- **15 private base tables**: one run table, thirteen run-scoped child tables, and one schedule table.
- **10 sender-filtered UI views**, **1 static anonymous UI policy-catalog view**, plus **1 public service-only view**.
- Public means the view is callable, not that it returns all users' data. An unrelated identity receives no run rows.
- The module is integrated in this workspace. Canonical generated bindings are in packages/bindings/src; the React application and agent service are integration placeholders.
- Regenerate bindings with the CLI version that matches your server and installed `spacetimedb` SDK. The generated SDK is the final TypeScript client naming/type contract.
- The base-table schema uses camelCase field names. UI view row definitions deliberately use snake_case SQL columns. Do not guess generated accessor names; inspect the generated bindings. They may normalize names such as `run_id` to `runId`.

## Worker and resource interpretation

The initialized demo has seven concrete worker rows: cashier 1/2, barista 1/2, server 1/2, and cleaner 1. Each concrete worker has one active task at most. There are four station resources with capacities **2/2/2/1**. A cashier task needs an idle cashier and one cashier-station unit; these are simultaneous constraints, not multiplicative capacity. There are never four cashiers merely because two worker rows and two station slots both exist.

Every admitted task reserves its role's station resource. Trays are a distinct reusable, order-owned resource: pickup acquires a clean tray; customer use and cleanup retain it; return releases it. Trays are not released when an individual intermediate task finishes.

## Identity, key, and time conventions

- `sync_run.id` is a database-generated `u64`, represented by JavaScript `bigint`.
- Every child `id` is allocated from that run's shared counter. Child IDs can repeat in another run.
- Child primary keys are string `key = runId + ':' + id`, for example `12:37`. Use this composite key as a stable React row key.
- All foreign references are **logical run-local references**. For example, `(runId, taskId)` identifies a task. Never resolve a task solely by its local numeric ID across runs.
- SpacetimeDB table types do not declare SQL foreign keys here. Reducers, domain construction, admission checks, and invariants enforce relationships.
- Identity strings are obtained from `ctx.sender.toHexString()` or a validated `Identity` reducer argument. A client cannot claim an identity by sending a plain arbitrary string.
- `u64` and `i64` stay `bigint`. Serialize them to decimal strings at HTTP/JSON boundaries. Do not call `Number(id)` on arbitrary IDs.
- `u32` ticks are explicit logical simulation time. A 200 ms scheduled callback advances one logical tick; wall-clock delay does not change order durations.
- `t.option(...)` means absent/unset, represented as the SDK's optional value. Treat zero as a valid tick, not as a missing value.

## Table dictionary

All rows below are private. The column **Optional** describes schema optionality. B-tree indexes shown here support real reducer/view reads. String-backed enums are narrowed and validated by domain/reducer code; `t.string()` itself does not enforce a database enum.

### `sync_run` — `run` accessor

| Field                | Type   | Optional | Key / index        | Meaning                                                                                                                                     |
| -------------------- | ------ | -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| id                   | u64    | No       | PK, auto-increment | Global database-assigned run ID for sync_run; otherwise run-local entity ID.                                                                |
| ownerIdentityHex     | string | No       | B-tree index       | Authenticated run creator identity, stored as its SDK hex representation.                                                                   |
| name                 | string | No       | -                  | Human-readable run name.                                                                                                                    |
| seed                 | u32    | No       | -                  | Recorded benchmark seed. Current recipe durations are configured constants; recording a seed alone does not generate a randomized workload. |
| tick                 | u32    | No       | -                  | Authoritative logical simulation tick.                                                                                                      |
| status               | string | No       | -                  | paused, running, or completed.                                                                                                              |
| arrivalsClosed       | bool   | No       | -                  | Whether new external orders are prohibited. An open run remains available across idle periods.                                              |
| mode                 | string | No       | -                  | Execution provider mode: deterministic or claude.                                                                                           |
| version              | u64    | No       | -                  | Monotonic state revision used for decision provenance; not a replacement for task attempt fencing.                                          |
| nextId               | u64    | No       | -                  | Next run-local entity identifier; shared across all child-table allocations.                                                                |
| eventSequence        | u64    | No       | -                  | Next sequence source for the combined decision/event chronology. Individual feeds may have gaps.                                            |
| policyJson           | string | No       | -                  | Validated scheduler configuration serialized as JSON.                                                                                       |
| maxOrders            | u32    | No       | -                  | Per-run order cap; current constructor sets 100.                                                                                            |
| budgetMicrousd       | u64    | Yes      | -                  | Optional cap on modeled execution spending plus active reservations. Not an Anthropic account spending limit.                               |
| modeledSpentMicrousd | u64    | No       | -                  | Settled illustrative simulator execution cost.                                                                                              |
| reservedMicrousd     | u64    | No       | -                  | Modeled execution cost reserved for currently admitted attempts.                                                                            |

### `sync_members` — `members` accessor

| Field       | Type   | Optional | Key / index  | Meaning                                                                          |
| ----------- | ------ | -------- | ------------ | -------------------------------------------------------------------------------- |
| key         | string | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                          |
| id          | u64    | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID.     |
| runId       | u64    | No       | B-tree index | Owning run; all logical relationships must resolve within this run.              |
| identityHex | string | No       | B-tree index | Authenticated identity granted a run membership.                                 |
| permission  | string | No       | -            | Membership role: viewer, operator, or service.                                   |
| enabled     | bool   | No       | -            | Whether this membership or concrete worker can be used for new access/admission. |

### `sync_orders` — `orders` accessor

| Field                | Type   | Optional | Key / index  | Meaning                                                                                              |
| -------------------- | ------ | -------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| key                  | string | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                                              |
| id                   | u64    | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID.                         |
| runId                | u64    | No       | B-tree index | Owning run; all logical relationships must resolve within this run.                                  |
| externalKey          | string | No       | -            | Caller-supplied idempotency key, scoped to the run.                                                  |
| recipe               | string | No       | -            | Validated recipe identifier: black_coffee or latte.                                                  |
| arrivalTick          | u32    | No       | -            | Tick at which the order became visible to the scheduler.                                             |
| deadlineTick         | u32    | No       | -            | Delivery deadline. Task-level deadline is absent for cleanup work.                                   |
| value                | u32    | No       | -            | Nonnegative completion value. On task rows only delivery earns the order value.                      |
| priority             | u32    | No       | -            | Scheduling preference inherited from the order.                                                      |
| customerUseTicks     | u32    | No       | -            | Configured customer-use delay between delivery and tray release.                                     |
| status               | string | No       | -            | open, delivered, or cleaned.                                                                         |
| deliveredTick        | u32    | Yes      | -            | Committed delivery tick; present exactly after delivery success.                                     |
| customerReleaseTick  | u32    | Yes      | -            | Tick at which the customer is modeled to release the tray, set on delivery.                          |
| cleanupCompletedTick | u32    | Yes      | -            | Committed tray-return tick; independent of customer delivery completion.                             |
| trayId               | u64    | Yes      | -            | Run-local tray assigned to this order, retained across delivery and cleanup; cleared on tray return. |

### `sync_tasks` — `tasks` accessor

| Field                 | Type     | Optional | Key / index  | Meaning                                                                                                    |
| --------------------- | -------- | -------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| key                   | string   | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                                                    |
| id                    | u64      | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID.                               |
| runId                 | u64      | No       | B-tree index | Owning run; all logical relationships must resolve within this run.                                        |
| orderId               | u64      | No       | B-tree index | Run-local owning order ID; optional on an unowned clean tray or an event without an order.                 |
| kind                  | string   | No       | -            | Validated coffee task kind; see task decomposition below.                                                  |
| role                  | string   | No       | -            | Required worker role or station role label.                                                                |
| status                | string   | No       | -            | blocked, ready, assigned, running, succeeded, failed, or uncertain.                                        |
| releaseTick           | u32      | No       | -            | Earliest task eligibility tick.                                                                            |
| deadlineTick          | u32      | Yes      | -            | Delivery deadline. Task-level deadline is absent for cleanup work.                                         |
| durationTicks         | u32      | No       | -            | Base estimated task duration before worker speed adjustment.                                               |
| priority              | u32      | No       | -            | Scheduling preference inherited from the order.                                                            |
| value                 | u32      | No       | -            | Nonnegative completion value. On task rows only delivery earns the order value.                            |
| requiredCapabilities  | string[] | No       | -            | All listed capabilities must be present on the selected worker.                                            |
| estimatedCostMicrousd | u64      | No       | -            | Configured modeled cost reserved at task admission.                                                        |
| attempt               | u32      | No       | -            | Monotonically increasing task execution attempt, used to reject stale results.                             |
| workerId              | u64      | Yes      | -            | Run-local assigned or associated concrete worker ID.                                                       |
| startedTick           | u32      | Yes      | -            | Tick the current attempt entered simulated execution.                                                      |
| finishedTick          | u32      | Yes      | -            | Tick the task successfully completed.                                                                      |
| finishAtTick          | u32      | Yes      | -            | Authoritative simulated completion tick, computed when the attempt starts.                                 |
| customerReleaseGuard  | bool     | No       | -            | Requires the owning order customerReleaseTick to have been reached.                                        |
| trayMode              | string   | No       | -            | Task resource effect: none, acquire, or release. A tray is owned by the order rather than by a task lease. |
| errorCode             | string   | Yes      | -            | Optional failure or diagnostic code; reserved for explicit recovery extensions.                            |

### `sync_dependencies` — `dependencies` accessor

| Field         | Type   | Optional | Key / index  | Meaning                                                                                    |
| ------------- | ------ | -------- | ------------ | ------------------------------------------------------------------------------------------ |
| key           | string | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                                    |
| id            | u64    | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID.               |
| runId         | u64    | No       | B-tree index | Owning run; all logical relationships must resolve within this run.                        |
| orderId       | u64    | No       | B-tree index | Run-local owning order ID; optional on an unowned clean tray or an event without an order. |
| predecessorId | u64    | No       | -            | Task that must have succeeded before the successor can start.                              |
| successorId   | u64    | No       | B-tree index | Task whose eligibility depends on the predecessor.                                         |

### `sync_workers` — `workers` accessor

| Field          | Type     | Optional | Key / index  | Meaning                                                                                                        |
| -------------- | -------- | -------- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| key            | string   | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                                                        |
| id             | u64      | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID.                                   |
| runId          | u64      | No       | B-tree index | Owning run; all logical relationships must resolve within this run.                                            |
| label          | string   | No       | -            | Display label for worker or resource.                                                                          |
| role           | string   | No       | -            | Required worker role or station role label.                                                                    |
| capabilities   | string[] | No       | -            | Worker capability tags used by compatibility checks.                                                           |
| enabled        | bool     | No       | -            | Whether this membership or concrete worker can be used for new access/admission.                               |
| speedFactor    | f64      | No       | -            | Positive modeled speed multiplier. Effective duration is ceil(base duration / speedFactor), at least one tick. |
| currentTaskId  | u64      | Yes      | -            | Active task assigned to this worker; absent when idle.                                                         |
| currentAttempt | u32      | Yes      | -            | Attempt currently owned by the worker; cleared with currentTaskId.                                             |
| x              | f64      | No       | -            | Initial display coordinate. The current engine does not perform pathfinding or movement updates.               |
| y              | f64      | No       | -            | Initial display coordinate. Client interpolation must not mutate business state.                               |

### `sync_resources` — `resources` accessor

| Field     | Type   | Optional | Key / index  | Meaning                                                                                          |
| --------- | ------ | -------- | ------------ | ------------------------------------------------------------------------------------------------ |
| key       | string | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                                          |
| id        | u64    | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID.                     |
| runId     | u64    | No       | B-tree index | Owning run; all logical relationships must resolve within this run.                              |
| label     | string | No       | -            | Display label for worker or resource.                                                            |
| role      | string | No       | -            | Required worker role or station role label.                                                      |
| capacity  | u32    | No       | -            | Total concurrent admitted units for this station resource.                                       |
| available | bool   | No       | -            | Whether new admissions may use this resource. Existing non-preemptive operations drain normally. |

### `sync_requirements` — `requirements` accessor

| Field      | Type   | Optional | Key / index  | Meaning                                                                      |
| ---------- | ------ | -------- | ------------ | ---------------------------------------------------------------------------- |
| key        | string | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                      |
| id         | u64    | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID. |
| runId      | u64    | No       | B-tree index | Owning run; all logical relationships must resolve within this run.          |
| taskId     | u64    | No       | B-tree index | Application field.                                                           |
| resourceId | u64    | No       | -            | Run-local capacity resource ID.                                              |
| units      | u32    | No       | -            | Positive units required or reserved.                                         |

### `sync_reservations` — `reservations` accessor

| Field      | Type   | Optional | Key / index  | Meaning                                                                        |
| ---------- | ------ | -------- | ------------ | ------------------------------------------------------------------------------ |
| key        | string | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                        |
| id         | u64    | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID.   |
| runId      | u64    | No       | B-tree index | Owning run; all logical relationships must resolve within this run.            |
| taskId     | u64    | No       | B-tree index | Application field.                                                             |
| workerId   | u64    | No       | -            | Run-local assigned or associated concrete worker ID.                           |
| attempt    | u32    | No       | -            | Monotonically increasing task execution attempt, used to reject stale results. |
| resourceId | u64    | No       | B-tree index | Run-local capacity resource ID.                                                |
| units      | u32    | No       | -            | Positive units required or reserved.                                           |

### `sync_trays` — `trays` accessor

| Field   | Type   | Optional | Key / index  | Meaning                                                                                    |
| ------- | ------ | -------- | ------------ | ------------------------------------------------------------------------------------------ |
| key     | string | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                                    |
| id      | u64    | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID.               |
| runId   | u64    | No       | B-tree index | Owning run; all logical relationships must resolve within this run.                        |
| state   | string | No       | -            | Tray lifecycle state: clean, in_use, dirty, or cleaning.                                   |
| orderId | u64    | Yes      | -            | Run-local owning order ID; optional on an unowned clean tray or an event without an order. |

### `sync_jobs` — `jobs` accessor

| Field                | Type   | Optional | Key / index  | Meaning                                                                                   |
| -------------------- | ------ | -------- | ------------ | ----------------------------------------------------------------------------------------- |
| key                  | string | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                                   |
| id                   | u64    | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID.              |
| runId                | u64    | No       | B-tree index | Owning run; all logical relationships must resolve within this run.                       |
| taskId               | u64    | No       | B-tree index | Application field.                                                                        |
| workerId             | u64    | No       | -            | Run-local assigned or associated concrete worker ID.                                      |
| attempt              | u32    | No       | -            | Monotonically increasing task execution attempt, used to reject stale results.            |
| status               | string | No       | -            | pending, claimed, accepted, failed, or uncertain.                                         |
| claimantIdentityHex  | string | Yes      | -            | Service identity that atomically claimed the execution job.                               |
| claimedTick          | u32    | Yes      | -            | Tick at which the job claim was accepted.                                                 |
| submittedTick        | u32    | Yes      | -            | Tick at which the accepted action entered simulated execution.                            |
| expectedAction       | string | No       | -            | Exact supported task kind the service must propose for this job.                          |
| observationJson      | string | No       | -            | Small task-level observation with decimal string IDs; no API key or private conversation. |
| reservedCostMicrousd | u64    | No       | -            | Modeled amount held for this specific admitted attempt.                                   |

### `sync_decisions` — `decisions` accessor

| Field           | Type     | Optional | Key / index  | Meaning                                                                                        |
| --------------- | -------- | -------- | ------------ | ---------------------------------------------------------------------------------------------- |
| key             | string   | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                                        |
| id              | u64      | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID.                   |
| runId           | u64      | No       | B-tree index | Owning run; all logical relationships must resolve within this run.                            |
| sequence        | u64      | No       | -            | Monotonic run chronology shared with decision/event records.                                   |
| tick            | u32      | No       | -            | Authoritative logical simulation tick.                                                         |
| policy          | string   | No       | -            | Scheduler policy identifier used for this assignment.                                          |
| taskId          | u64      | No       | -            | Application field.                                                                             |
| workerId        | u64      | No       | -            | Run-local assigned or associated concrete worker ID.                                           |
| attempt         | u32      | No       | -            | Monotonically increasing task execution attempt, used to reject stale results.                 |
| score           | f64      | No       | -            | Policy score attached to the chosen assignment; scores across policies need not be comparable. |
| reasonCodes     | string[] | No       | -            | Machine-readable scheduling reasons, suitable for display or deterministic explanation.        |
| snapshotVersion | u64      | No       | -            | Run revision observed before that assignment batch was committed.                              |

### `sync_events` — `events` accessor

| Field    | Type   | Optional | Key / index  | Meaning                                                                                    |
| -------- | ------ | -------- | ------------ | ------------------------------------------------------------------------------------------ |
| key      | string | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                                    |
| id       | u64    | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID.               |
| runId    | u64    | No       | B-tree index | Owning run; all logical relationships must resolve within this run.                        |
| sequence | u64    | No       | -            | Monotonic run chronology shared with decision/event records.                               |
| tick     | u32    | No       | -            | Authoritative logical simulation tick.                                                     |
| type     | string | No       | -            | Structured execution-event identifier.                                                     |
| taskId   | u64    | Yes      | -            | Application field.                                                                         |
| orderId  | u64    | Yes      | -            | Run-local owning order ID; optional on an unowned clean tray or an event without an order. |
| workerId | u64    | Yes      | -            | Run-local assigned or associated concrete worker ID.                                       |
| attempt  | u32    | Yes      | -            | Monotonically increasing task execution attempt, used to reject stale results.             |
| detail   | string | No       | -            | Bounded application-generated description; not a private model prompt.                     |

### `sync_telemetry` — `telemetry` accessor

| Field                | Type   | Optional | Key / index  | Meaning                                                                                              |
| -------------------- | ------ | -------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| key                  | string | No       | PK           | Globally unique primary key formed as `${runId}:${id}`.                                              |
| id                   | u64    | No       | -            | Global database-assigned run ID for sync_run; otherwise run-local entity ID.                         |
| runId                | u64    | No       | B-tree index | Owning run; all logical relationships must resolve within this run.                                  |
| externalKey          | string | No       | -            | Caller-supplied idempotency key, scoped to the run.                                                  |
| taskId               | u64    | Yes      | -            | Application field.                                                                                   |
| attempt              | u32    | Yes      | -            | Monotonically increasing task execution attempt, used to reject stale results.                       |
| source               | string | No       | -            | Telemetry category: anthropic or coordinator.                                                        |
| inputTokens          | u64    | No       | -            | Reported Anthropic input-token count; not a predicted count.                                         |
| outputTokens         | u64    | No       | -            | Reported Anthropic output-token count.                                                               |
| reportedCostMicrousd | u64    | No       | -            | Cost reported by the trusted service, kept separate from modeled simulator cost.                     |
| wallMilliseconds     | f64    | No       | -            | Externally measured duration reported by a trusted service. The reducer does not invent host timing. |
| reporterIdentityHex  | string | No       | -            | Authenticated identity that submitted the telemetry row.                                             |

### `sync_clock` — `clock` accessor

| Field       | Type       | Optional | Key / index        | Meaning                                                             |
| ----------- | ---------- | -------- | ------------------ | ------------------------------------------------------------------- |
| scheduledId | u64        | No       | PK, auto-increment | Database-assigned primary key of a scheduled callback.              |
| scheduledAt | scheduleAt | No       | -                  | SpacetimeDB ScheduleAt value for the periodic tick callback.        |
| runId       | u64        | No       | unique             | Owning run; all logical relationships must resolve within this run. |

## Relationships and lifecycle rules

| Relationship               | Meaning and enforcement                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Run → child rows           | Every row's `runId` equals its loaded run, and `key` matches the run/local ID pair.                                            |
| Order → tasks              | Materialization creates only the chosen recipe's nodes. Task order references cannot cross runs.                               |
| Dependency → tasks         | Both endpoints exist in that run and belong to the recorded order. Success, not mere termination, unlocks the successor.       |
| Task → requirements        | Every task requires one station unit for its role in this adapter. Generic scheduling supports multiple resource requirements. |
| Task attempt → reservation | Each reservation belongs to exactly the current task attempt and assigned worker.                                              |
| Worker → task attempt      | A concrete worker has at most one active task and must carry its current attempt.                                              |
| Order ↔ tray               | At most one tray is owned by an order; each occupied tray points back to that same order.                                      |
| Job → task attempt         | Claim/action validation rejects a job from an older attempt or a different claimant.                                           |
| Decision/event → run       | Combined `sequence` orders committed chronology; sort explicitly in the UI.                                                    |
| Clock → run                | Unique `runId` prevents duplicate periodic schedules for a run. Completed-run schedules are removed.                           |

The `run.version` field records state revision/provenance. Task `attempt` is the fencing check for asynchronous actions. Do not substitute a global version equality check for current task ownership: unrelated task progress can legitimately change the version while an agent is working.

## Coffee-shop DAG

| Task kind      | Role    | Prerequisites                          | Special condition/effect                                       |
| -------------- | ------- | -------------------------------------- | -------------------------------------------------------------- |
| capture_order  | cashier | None                                   | Order is newly visible.                                        |
| take_payment   | cashier | capture_order                          | Simulated payment only.                                        |
| prepare_coffee | barista | take_payment                           | Produces coffee base.                                          |
| prepare_milk   | barista | take_payment                           | Exists only for latte.                                         |
| assemble_drink | barista | prepare_coffee; prepare_milk for latte | Join requires every materialized prerequisite to succeed.      |
| pick_up_drink  | server  | assemble_drink                         | Acquire one clean tray if the order has none.                  |
| deliver_order  | server  | pick_up_drink                          | Commit delivery and customer-release tick.                     |
| collect_tray   | cleaner | deliver_order                          | Wait for customer release; this wait occupies no cleaner slot. |
| clean_tray     | cleaner | collect_tray                           | Mark tray cleaning while operation runs.                       |
| return_tray    | cleaner | clean_tray                             | Release tray to clean inventory and mark cleanup complete.     |

Black coffee has 9 nodes; latte has 10. The checklist for each kind is in `domain/recipes.ts` and is exposed on `ui_tasks.steps`. Durations and modeled costs are illustrative configuration, not measurements of real coffee operations or model prices.

## UI-facing view contracts

All views below are declared with **no arguments**. Their sender-dependent handlers use indexed reads. They return only runs readable by the current caller. The `ui_` views are for owners, enabled viewers, and enabled operators; service membership alone does not reveal these views.

Optional fields retain their optional schema type. Unless specified otherwise, ID columns are `u64`/`bigint`, tick/count columns are `u32`/number, and display labels/statuses are strings.

### `ui_runs`

One row per readable run:

`id`, `name`, `seed`, `tick`, `status`, `mode`, `version`, `policy_json`, `can_control`, `arrivals_closed`.

Use it for the run selector, start/pause controls, policy settings, and version display. `can_control` is a UI hint; reducers independently authorize every write. There is no owner identity disclosure in this projection.

### Common child-view identity

Except `ui_runs` and `ui_metrics`, UI child rows carry `key`, `id`, and `run_id`. DAG references use local task IDs within that `run_id`. `ui_metrics` has one row per run and therefore uses `run_id` directly.

### `ui_orders`

`key`, `id`, `run_id`, `recipe`, `status`, `arrival_tick`, `deadline_tick`, `value`, `priority`, `delivered_tick?`, `customer_release_tick?`, `cleanup_completed_tick?`, `tray_id?`, `ready_tasks`, `active_tasks`, `delivery_late`.

- `ready_tasks` counts dependency/guard-eligible tasks, not necessarily tasks that can get a worker/resource immediately.
- `active_tasks` includes assigned, running, and uncertain tasks.
- `delivery_late` uses actual delivery time if delivered, otherwise current tick. It becomes true only after the deadline, so completion exactly at deadline is on time.
- Use separate indicators for customer delivery and operational cleanup.

### `ui_tasks`

`key`, `id`, `run_id`, `order_id`, `kind`, `role`, `status`, `block_reason`, `resource_blocked`, `release_tick`, `deadline_tick?`, `duration_ticks`, `attempt`, `worker_id?`, `started_tick?`, `finished_tick?`, `finish_at_tick?`, `required_capabilities`, `steps`, `error_code?`, `estimated_slack_ticks?`.

- `estimated_slack_ticks` is signed `i64`/bigint and may be negative. It estimates deadline minus current tick, base duration, and remaining dependency tail. It is an estimate, not a guarantee or an authoritative countdown for a running task.
- `block_reason` can be `release_time`, `dependencies`, `customer_using_tray`, `eligible`, `no_compatible_idle_worker`, `modeled_budget`, `resource_or_tray`, or the task's nonqueue lifecycle status.
- `resource_blocked` concerns ready tasks whose resource/tray requirements cannot currently be met.
- Render `steps` as the task checklist, but do not offer a client-side “mark complete” operation. Completion belongs to the authoritative simulation.

### `ui_dag_edges`

`key`, `id`, `run_id`, `order_id`, `from_task_id`, `to_task_id`.

Build graph nodes from `ui_tasks`, edges from this view. Pair every local task ID with `run_id`. For black coffee there is no milk node or phantom edge.

### `ui_workers`

`key`, `id`, `run_id`, `label`, `role`, `enabled`, `status`, `capabilities`, `current_task_id?`, `current_attempt?`, `speed_factor`, `x`, `y`.

`status` is `busy`, `idle`, or `disabled`; an admitted uncertain task keeps its worker busy. The current adapter initializes coordinates but does not implement movement/pathfinding. Phaser can animate presentation, but UI motion never declares task success.

### `ui_resources`

`key`, `id`, `run_id`, `label`, `role`, `capacity`, `reserved_units`, `free_units`, `available`.

`reserved_units` is derived from reservations. `free_units` is zero for an unavailable resource even if no reservation exists. Therefore `capacity - reserved_units` and `free_units` can intentionally differ during a disruption. Existing admitted work drains; availability blocks new admission.

### `ui_trays`

`key`, `id`, `run_id`, `state`, `order_id?`.

Do not infer a free tray from a completed delivery. Only `state = clean` with no owning order denotes availability.

### `ui_decisions`

`key`, `id`, `run_id`, `sequence`, `tick`, `policy`, `task_id`, `worker_id`, `attempt`, `score`, `reason_codes`, `snapshot_version`.

Returns at most the **latest 200 decisions per readable run**. Sort by `sequence` in the client as well; SQL/subscription caches do not promise server-returned row ordering. The private table retains the full run history. This is a bounded live feed, not a pagination API.

### `ui_events`

`key`, `id`, `run_id`, `sequence`, `tick`, `event_type`, `detail`, `task_id?`, `order_id?`, `worker_id?`, `attempt?`.

Returns at most the **latest 400 execution events per readable run**. The private table retains history. Handle removals when an old row falls out of the visible window. Use explicit sorting. Decision/event sequences share one source and can have gaps within either feed.

### `ui_metrics`

One row per readable run:

| Column                           | Type         | Meaning                                                          |
| -------------------------------- | ------------ | ---------------------------------------------------------------- |
| run_id                           | u64          | Run identity.                                                    |
| tick                             | u32          | Logical time.                                                    |
| orders_received                  | u32          | Orders revealed so far.                                          |
| delivered_orders                 | u32          | Orders with committed delivery.                                  |
| on_time_orders                   | u32          | Delivered at or before the order deadline.                       |
| cleaned_orders                   | u32          | Orders whose tray-return task succeeded.                         |
| unfinished_orders                | u32          | Received minus delivered; cleaned status is independent.         |
| late_open_orders                 | u32          | Undelivered orders currently past deadline.                      |
| latency_sum_ticks                | u64          | Sum of delivered-order flow times.                               |
| latency_count                    | u32          | Number of delivered orders included in the sum.                  |
| mean_delivery_ticks              | optional f64 | Sum divided by count; absent before any delivery.                |
| completed_value                  | u64          | Value of all delivered orders.                                   |
| on_time_value                    | u64          | Value of orders delivered by deadline.                           |
| completed_tasks                  | u32          | Succeeded task count; not the primary business reward.           |
| ready_tasks                      | u32          | Tasks whose dependencies and environment guards allow execution. |
| busy_workers                     | u32          | Workers holding an active task, including unresolved attempts.   |
| total_workers                    | u32          | Seven in the default demo.                                       |
| dirty_or_in_use_trays            | u32          | Trays not currently clean.                                       |
| modeled_spent_microusd           | u64          | Settled illustrative simulator execution cost.                   |
| reserved_microusd                | u64          | Modeled cost held for active attempts.                           |
| modeled_budget_microusd          | optional u64 | Configured modeled cap.                                          |
| reported_anthropic_cost_microusd | u64          | Sum of trusted-service-reported Anthropic cost.                  |
| input_tokens                     | u64          | Sum of reported Anthropic input tokens.                          |
| output_tokens                    | u64          | Sum of reported Anthropic output tokens.                         |
| reported_coordinator_ms          | f64          | Sum of externally measured coordinator telemetry.                |
| coordinator_sample_count         | u32          | Number of coordinator timing samples.                            |
| assignment_count                 | u32          | Committed decision/assignment row count.                         |

A zero reported timing with zero samples means “not measured”, not “zero overhead.” Show an unmeasured state in the UI. Mean delivery latency includes only delivered orders; always show unfinished and late-open orders alongside it so censored unfinished work is visible. No percentage improvement is fabricated by the module.

### `service_jobs`

`key`, `id`, `run_id`, `task_id`, `worker_id`, `attempt`, `status`, `mine`, `expected_action`, `observation_json`.

This view is public in API visibility but **service-only in returned data**. An enabled service member sees pending jobs for its authorized runs and jobs it has claimed. It does not see jobs claimed by other services. The normal UI should not subscribe to this view.

Claim a job through `claim_agent_job`, wait for the authoritative response/cache to confirm `mine = true`, call Claude, then submit `expected_action` through `submit_agent_action`. An accepted action starts simulation; a model response never directly proves task completion. A service reconnect must reconcile already claimed jobs before issuing duplicate model calls.

## SQL subscriptions and client selection

These are no-argument views, so use ordinary subscriptions and optional SQL row filters. Example subscriptions for run 1:

```sql
SELECT * FROM ui_runs WHERE id = 1;
SELECT * FROM ui_orders WHERE run_id = 1;
SELECT * FROM ui_tasks WHERE run_id = 1;
SELECT * FROM ui_dag_edges WHERE run_id = 1;
SELECT * FROM ui_workers WHERE run_id = 1;
SELECT * FROM ui_resources WHERE run_id = 1;
SELECT * FROM ui_trays WHERE run_id = 1;
SELECT * FROM ui_decisions WHERE run_id = 1;
SELECT * FROM ui_events WHERE run_id = 1;
SELECT * FROM ui_metrics WHERE run_id = 1;
```

A run selector can subscribe to `SELECT * FROM ui_runs`. A trusted service can subscribe to `SELECT * FROM service_jobs WHERE run_id = 1`.

For a dynamically selected ID, first validate/retain it as a nonnegative bigint and render its decimal `toString()` into a numeric SQL literal. Never interpolate a name, prompt, or unchecked arbitrary string into SQL. Prefer generated typed query builders when available for the generated view types.

The SQL filter narrows the UI selection; it is **not authorization**. The view already checks the authenticated sender before returning any rows. An identity with no membership cannot bypass this by omitting the `WHERE` clause or selecting another run ID.

Before showing the run as loaded, wait for all required subscriptions to apply. The client cache can contain more than one subscribed run, so filter displayed rows by the selected `run_id` even when reusing one connection. Unsubscribe unused run-specific subscriptions and remove callbacks on component cleanup. Confirm all generated accessor names after regeneration.

## Commands behind the UI

| Reducer                | Authorized caller         | Inputs and behavior                                                                                                                                           |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create_run             | Caller becomes owner      | name, seed, trayCount, mode, optional modeled budget. Creates private state and one paused tick schedule.                                                     |
| grant_member           | Owner                     | runId, identity, permission, enabled. Does not allow self-elevation by an untrusted service.                                                                  |
| set_run_status         | Owner/operator            | runId, running. Starts/resumes or pauses; does not preempt running tasks.                                                                                     |
| enqueue_order          | Owner/operator            | runId, externalKey, recipe, deadlineInTicks, value, priority, customerUseTicks. Materializes the selected DAG.                                                |
| set_policy             | Owner/operator            | runId, configJson. Validates fields and merges the patch into the current configuration; queued work changes, running ownership remains.                      |
| step_run               | Owner/operator            | runId. Requires paused status; advances one logical tick and returns to paused unless completed.                                                              |
| close_arrivals         | Owner/operator            | runId. Disallows new external orders; allows completion once all admitted orders are cleaned.                                                                 |
| set_resource_available | Owner/operator            | runId, resourceId, available. Changes future admission, not current non-preemptive ownership.                                                                 |
| mark_job_uncertain     | Owner/operator            | runId, jobId. Marks a claimed live job uncertain and retains reservations.                                                                                    |
| reconcile_job          | Owner                     | runId, jobId, resolution. Explicit recovery after checking external outcome.                                                                                  |
| claim_agent_job        | Enabled service           | runId, jobId. Single authoritative claim.                                                                                                                     |
| submit_agent_action    | Claiming enabled service  | runId, jobId, attempt, action. Exact current attempt/action required.                                                                                         |
| report_usage           | Enabled service           | Idempotency key, source, optional task/attempt, counts, reported cost and measured wall time. Anthropic samples must refer to that service's claimed attempt. |
| tick_run               | Scheduled host invocation | Uses sync_clock row; ordinary UI does not invoke it.                                                                                                          |

The controls should use the generated reducers, not direct table writes. Reducer names or SDK accessors may be normalized during generation; inspect the actual binding rather than hand-writing a fake SDK layer.

## Practical limits and extension points

- This module has two concrete recipes, illustrative durations, and task-level simulated execution. It does not implement live payments, kitchen devices, or actual external task completion.
- A run records a seed but the application must feed the same seeded arrival stream to both comparison runs; the module does not create hidden future orders automatically.
- Dynamic arrival is supported while the run is open. Idle open runs stay running; `close_arrivals` marks the end of input explicitly.
- Private base state is normalized across tables. The adapter loads a bounded run snapshot for mutations and persists changed rows; this is suitable for the demo cap, not a claim of large-scale incremental scheduling performance.
- Views use only indexed `find`/`filter` operations and read the required table groups for each projection. UI projection work is separate from the scheduler itself and should be included in end-to-end overhead measurements.
- No automatic deletion/archival, unbounded production retention policy, or full-history UI pagination is implemented.
- No rate-limit resource, real-money hard cap on Anthropic spending, preemption, arbitrary user-supplied DAG editor, or learned duration estimator is implemented in this bundle.
- Reported external usage is distinct from simulated cost. The trusted service must supply measured timing and correct API usage information.
- Regenerate and verify SDK bindings, run the real module test harness, and publish to a local database before merging into the final application. The parent delivery documents what could and could not be executed in this environment.

## Official API references

- [TypeScript quickstart](https://spacetimedb.com/docs/quickstarts/typescript/)
- [Reducers and transactions](https://spacetimedb.com/docs/functions/reducers/)
- [Views and indexed reads](https://spacetimedb.com/docs/functions/views/)
- [Schedule tables](https://spacetimedb.com/docs/tables/schedule-tables/)
- [TypeScript SDK](https://spacetimedb.com/docs/clients/typescript/)
- [Module test harness](https://spacetimedb.com/docs/how-to/unit-testing/)

## Static policy-selector view: `ui_policy_catalog`

This additional anonymous view contains only public policy metadata; it reads no
run state and requires no membership. The other ten UI views remain sender-filtered.

| Column              | Type   | Meaning                                                         |
| ------------------- | ------ | --------------------------------------------------------------- |
| name                | string | Policy ID accepted by set_policy.                               |
| label               | string | Human-readable selector label.                                  |
| description         | string | What the immediate-dispatch policy prioritizes.                 |
| baseline            | bool   | Whether this is a conventional comparison baseline.             |
| lookahead           | bool   | False for all current policies; joint search is not rollout.    |
| default_config_json | string | Validated default weight/scaling configuration for this policy. |

Subscribe with `SELECT * FROM ui_policy_catalog`. It has no `run_id`; do not apply
a run filter. For a run, changing only the policy can send `{"policy":"minimum_slack"}`;
other existing configuration values are preserved. Sending default_config_json
intentionally replaces the specified knobs with that policy's defaults.

The pure scheduler snapshot includes optional `budgetRemainingMicrousd`; greedy
and joint policies subtract assignment costs cumulatively. The reducer still
validates the modeled budget when committing each assignment.
