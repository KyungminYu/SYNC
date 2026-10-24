# SYNC execution, scheduling, and access policies

This document describes the behavior implemented by this source bundle. The
coffee-shop adapter uses generic tasks, capabilities, worker slots, resource
requirements, and assignment proposals. All database writes occur through
reducers. The pure scheduler does not own database state or execute external
actions.

## Roles and capacity

The initial shop contains **seven concrete workers**, each with concurrency one:

| Role    | Worker slots | Station capacity |
| ------- | -----------: | ---------------: |
| Cashier |            2 |                2 |
| Barista |            2 |                2 |
| Server  |            2 |                2 |
| Cleaner |            1 |                1 |

These are four role types, not four workers. A task consumes one compatible
worker slot and its declared station capacity. Station capacities are an
additional admission constraint, not a multiplier that creates more workers.

Workers are compatible when they contain every required task capability. The
demo supplies one capability per role. The pure scheduler can represent more
general capability sets and worker-specific duration and cost estimates.

## Order decomposition

Black coffee has the following chain:

`capture_order -> take_payment -> prepare_coffee -> assemble_drink -> pick_up_drink -> deliver_order -> collect_tray -> clean_tray -> return_tray`

A latte introduces a fork after `take_payment`: `prepare_coffee` and
`prepare_milk` may run concurrently, and both must succeed before
`assemble_drink` can start. Black coffee contains no milk task. The checklists
and task durations are defined in `domain/recipes.ts`.

An order creates its currently known recipe tasks and edges when enqueued.
New orders may arrive while the run is executing. This bundle does not yet
provide an API for adding arbitrary tasks or conditional branches to an
already-materialized order.

Customer release of a tray is an environment condition. Delivery schedules its
logical release tick using the order's `customerUseTicks`; no worker is occupied
by that wait. Collection requires both successful delivery and customer release.

The order's delivery deadline applies to the service chain through delivery.
Cleanup tasks have no delivery deadline. Successful delivery earns order value
once; cleanup completion is recorded separately. Late work continues: deadlines
are soft in the current engine, and orders are not automatically discarded.

## Task and job lifecycle

Normal deterministic execution follows:

`blocked -> ready -> assigned -> running -> succeeded`

An assigned task is a current authoritative claim. It owns a worker slot and all
declared resource reservations. In deterministic mode its execution job is
accepted immediately. In Claude mode its job remains `pending` until an
authorized service claims it and submits the exact supported action.

Live jobs follow:

`pending -> claimed -> accepted`

Acceptance starts a deterministic simulated operation with an authoritative
finish tick. A model response is an action proposal, not proof that execution
finished. Only the simulation completion path commits success and frees
attempt-scoped resources.

There is no public reducer for arbitrary task completion. Failed prerequisites
do not unlock downstream tasks. The `failed` state is represented, but generic
failure propagation and automatic retry backoff are deferred.

Task readiness requires:

1. Its release tick has arrived.
2. Every prerequisite task has committed success.
3. Any environment guard is satisfied.

Resource availability is then checked for admission. Therefore a `ready` task
can still be waiting for a worker, station capacity, a tray, or sufficient
modeled budget. UI task rows expose resource blocking separately from dependency
blocking.

## Atomic admission

A scheduling reducer loads a coherent run state, calls the pure policy, and
rechecks each proposed assignment before committing:

1. The task is eligible and unclaimed.
2. The worker is enabled, idle, and compatible.
3. Required station capacity is available.
4. Any new order-owned tray is clean and unassigned.
5. The modeled cost fits within the remaining budget.
6. The worker claim, task attempt, resource reservations, and execution job are
   created together.

Proposal selection updates tentative capacity as it chooses assignments. Final
admission enforces current capacity again. No client may implement a separate
check-then-reserve protocol.

Each admitted attempt increments the task's attempt number. Job ownership,
submission, completion, and resource release must reference the current attempt.
Duplicate completion of the same successful attempt is a no-op. A stale attempt
cannot complete the current task or release its current reservations.

## Tray ownership

Trays are reusable order-owned resources, distinct from attempt-scoped station
reservations:

1. `pick_up_drink` admission acquires a clean tray for the order.
2. Ownership persists through pickup, delivery, customer waiting, and cleaning.
3. Collection marks the tray dirty; cleaning marks it cleaning.
4. Successful `return_tray` restores the clean state and clears order ownership.

The tray remains reserved between worker tasks. It is not released merely
because a server or cleaner becomes idle. The finite clean-tray pool connects
cleanup to future delivery capacity without adding artificial cross-order DAG
edges.

Safe retry of pickup reuses the order's existing tray. Failed or superseded
attempts never return the tray to inventory. Downstream admission requiring a
tray verifies that the order already owns one.

## Scheduling policies

All policies consume the same eligible frontier and idle workers, respect the
same capacity and tray constraints, and use deterministic tie-breaking. None
sees future arrivals. They dispatch immediate work; they do not reserve future
station time.

| Exact policy name | Selection rule                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fcfs`            | Earliest release tick, then stable task ID; shorter compatible duration resolves placement ties.                                                      |
| `earliest_finish` | Lowest estimated duration among immediately feasible task-worker pairs. Because all selected work starts now, this is also earliest estimated finish. |
| `minimum_slack`   | Lowest `deadline - current_tick - duration - downstream_tail`; no-deadline tasks sort after finite-slack tasks.                                       |
| `critical_path`   | Largest estimated duration plus downstream tail.                                                                                                      |
| `sync_greedy`     | Highest normalized composite score, greedily accepting feasible pairs.                                                                                |
| `bounded_joint`   | Search feasible sets of immediate assignments from per-worker shortlists, including idle options, under a deterministic branch budget.                |

The composite score is:

`1 + urgencyWeight*urgency + criticalityWeight*criticality + ageWeight*age + priorityWeight*priority + valueWeight*value - durationWeight*duration - costWeight*cost`

The implementation defines bounded dimensionless transforms in
`policies/scheduler.ts`. Urgency increases as slack decreases; tasks without a
deadline have zero urgency. Age is capped. Priority and value are squashed to
bounded values. Cost conversion is capped before conversion from bigint. The
base one favors productive dispatch under the default weights.

`bounded_joint` is **not** rolling-horizon planning, model-predictive control, or
a Monte Carlo rollout. It does not simulate future completions. Its search
optimizes the sum of the current pair scores within the considered shortlist,
subject to its branch limit. It preserves a feasible greedy incumbent, can
select an idle option, and emits whether its deterministic search budget was
reached. It makes no global optimality claim and does not guarantee improvement
on every workload.

The current engine computes downstream tails from the known order graph, ending
the service chain at delivery and the cleanup chain at tray return. Estimates
are illustrative configuration; learning estimates from execution history is
deferred. Aging reduces starvation pressure but is not a formal progress
guarantee under unlimited arrivals or unavailable resources.

Policy changes affect subsequent decisions. They do not migrate or interrupt
running non-preemptive operations. `set_policy` merges a submitted patch with
the documented defaults, so the UI should send the complete desired
configuration when preserving customized weights across updates.

## Run control, disruptions, and reconciliation

Runs begin paused. Starting schedules eligible work. Pausing freezes logical
time and rejects new live claims and new action submissions. Resuming continues
the same tasks. Manual stepping is paused-only, preventing a browser from
accelerating a running scheduled clock.

Arrivals remain open by default. Finishing every currently known order does not
complete a run while arrivals are open: the shop may be idle and receive another
order later. An owner or operator calls `close_arrivals` when the workload is
fully revealed. Closing arrivals rejects new order keys and permits the run to
complete once all admitted orders are cleaned. Closing an already idle running
run completes it immediately. Existing identical idempotency-key replays still
return the previously created order; they do not create new work.

Disabling a station blocks new admissions. Already admitted non-preemptive
operations retain their reservations and drain normally. This is a controlled
availability disruption, not a simulated physical destruction of running work.

Only a **claimed** live request may be marked `uncertain`. This retains its
worker, station reservations, modeled budget reservation, and any order tray.
The engine does not automatically time out or reassign uncertain work.

Accepted simulated operations are deterministic and can safely finish at their
authoritative finish ticks. They are not marked uncertain through this API.
Integrating real irreversible tools requires additional outcome reconciliation.

Only the owner may reconcile uncertain work:

- `resume`: accept the original supported simulated action and start it. The run
  must be running.
- `retry_safe`: the owner **attests that retry is safe**, fails the old job,
  releases its attempt-scoped claims and modeled cost reservation, and makes
  the task eligible for another attempt. Order-tray ownership is retained.

This manual attestation is not proof of exactly-once external execution. A real
tool integration needs destination-side idempotency or fencing and an explicit
method for checking uncertain external outcomes. Releasing a modeled reservation
does not establish that an unknown API request incurred no real cost.

An enabled service cannot be disabled or demoted while it owns claimed or
uncertain jobs. Reconcile them first. A service cannot grant itself membership.

## Access policy

Base tables are private. Public views perform sender-dependent authorization
and project only data needed by the UI or service. Every entity is scoped to one
run. Entity IDs are local to a run; database keys include both run ID and local
entity ID. UI components must use that composite key rather than a bare ID.

| Operation                                                             | Owner | Operator | Viewer | Service | Unrelated identity |
| --------------------------------------------------------------------- | ----- | -------- | ------ | ------- | ------------------ |
| Read authorized UI views                                              | Yes   | Yes      | Yes    | No      | No                 |
| Control run, enqueue orders, set policy, change resource availability | Yes   | Yes      | No     | No      | No                 |
| Close future arrivals                                                 | Yes   | Yes      | No     | No      | No                 |
| Grant, change, or revoke membership                                   | Yes   | No       | No     | No      | No                 |
| Read service jobs and claim/submit them                               | No*   | No       | No     | Yes     | No                 |
| Mark claimed jobs uncertain                                           | Yes   | Yes      | No     | No      | No                 |
| Reconcile uncertain jobs                                              | Yes   | No       | No     | No      | No                 |
| Report service usage                                                  | No*   | No       | No     | Yes     | No                 |

`*` Owner authority deliberately does not impersonate a service. Register a
separate service identity for worker execution.

Run filtering in the client is a UI selection rule, not authorization. A caller
querying an entire view must still receive only authorized rows. Service views
show available pending jobs and the caller's own jobs for service-authorized
runs, not another service's claimed observation payloads.

Clients never write tables directly. UI permission indicators such as
`can_control` improve usability; reducers remain the enforcement boundary.

## Budgets and telemetry

All modeled amounts use integer micro-USD (`bigint`). One USD equals 1,000,000
micro-USD. The recipe's fixed modeled costs are simulator parameters, not
Anthropic prices or measured monetary savings.

Admission requires:

`modeled_spent + reserved_modeled_cost + next_attempt_cost <= modeled_budget`

Completion moves reserved modeled cost into modeled spending exactly once.
Invariant checks independently enforce the budget cap and reconcile the
reservation ledger with active attempts. An exhausted budget leaves work
queued; it does not imply the run completed. A budget can prevent cleanup after
delivery, so callers should provision sufficient budget for the full lifecycle
or report the unfinished cleanup explicitly.

Reported Anthropic token counts/costs and coordinator wall-clock samples are a
separate telemetry stream submitted by authorized services. They are not
automatically verified against an invoice and do not decrement the modeled
simulation budget. Do not add the modeled and reported totals as though they
were two distinct real charges, and do not label reported samples as exhaustive
if some calls were not reported.

Logical tick latency and wall-clock overhead are separate units. UI averages
must derive from sums and counts and display an empty state when no sample
exists. Order delivery, on-time delivery, and cleanup completion are distinct
metrics. Unfinished orders remain visible instead of disappearing from latency
claims.

## State invariants

`assertInvariants` checks these structural and execution properties:

- Every row belongs to its run and has a matching composite key.
- Dependency endpoints exist and belong to the same order.
- Each worker owns at most one active task, with a matching current attempt.
- Active tasks have succeeded prerequisites and valid order/worker references.
- Resource reservations stay within capacity.
- Reservations belong to current active attempts and satisfy requirements.
- Tray ownership agrees between tray and order records.
- Reserved modeled cost matches active-job reservations and remains nonnegative.
- Modeled settled plus reserved spending does not exceed the configured cap.

The pure engine is an in-memory transition library. Transaction rollback and
isolation are supplied by the SpacetimeDB reducer boundary. External callers
should invoke reducers rather than mutate a state object directly.

## Supported and deferred scope

Supported now:

- Seven role-compatible worker slots and finite station/tray capacity.
- Dynamic order arrivals with two materialized recipe DAGs.
- Six immediate-dispatch scheduling policies.
- Non-preemptive deterministic simulation with logical ticks.
- Claude job claim/action handoff contracts, without embedding an API key.
- Run membership, private tables, authorized UI/service views.
- Attempts, idempotent completion, stale-result rejection, manual reconciliation.
- Modeled cost reservation and separate reported usage.

Deferred:

- Full rolling-horizon lookahead or learned scheduling.
- Arbitrary mid-workflow graph edits and generic cancellation propagation.
- Real payment processing, physical hardware control, or external exactly-once effects.
- Automatic unknown-outcome retries or lease expiry reclamation.
- Resource rate limits, general consumable-inventory management, and real API budget enforcement.
- Cross-run shared-resource optimization, multi-scheduler leadership, and production-scale persistence tuning.
- Real-time pathfinding/collisions; worker positions are presentation fields.

Compare policies on identical arrivals, recipes, capacities, durations,
deadlines, customer waits, and modeled costs. Keep any future arrival stream
outside scheduler snapshots until revealed. Report scheduling overhead and
multiple workload outcomes rather than presuming that a policy named SYNC must
win every case.

## Static policy catalog

`ui_policy_catalog` is an anonymous public view containing only names, labels,
descriptions and default configuration for the six policies. It has no run data.
All other UI views are identity-filtered; service_jobs requires a service grant.
The scheduler also enforces the remaining modeled budget cumulatively across
each proposed assignment batch, and admission independently rechecks it.
