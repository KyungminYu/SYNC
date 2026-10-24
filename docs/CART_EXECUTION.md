# Cart execution and external workers

SYNC owns scheduling, admission and shared context in SpacetimeDB. The agent service supervises real Node child processes, one per enabled worker. There are seven physical slots (2 cashier, 2 barista, 2 server, 1 cleaner), with four enabled initially. Worker processes and physical station capacity are separate constraints. This is a local process supervisor, not an AWS provisioning integration.

## Orders and shared work

Use `enqueue_cart` for atomic checkout. Its `items` array contains recipe keys and quantities; five coffees produce five distinct order IDs. Repeating the same cart key and payload is idempotent; a conflicting payload fails. A submitted cart is sealed. The legacy `enqueue_order` remains for existing clients but does not provide atomic cart decomposition.

`ui_orders.recipe_key` contains the stable recipe identifier (`latte` or `black_coffee`). Recipe definitions are shared; they are not copied per drink. `sync_task_items` maps a task to every order it serves. `ui_tasks.order_ids` exposes that membership; `order_id` remains the lead order for compatibility. The dashboard attaches shared tasks to every affected customer and consumes actual DAG edges.

Checkout, payment, pickup, delivery and tray cleanup are cart-wide. Preparation and cup setup remain drink work. The primal-dual policy batches pairs of compatible, untouched ready preparation tasks across carts. It joins every component before cart pickup; no cart is delivered partially. A batch is capped at two drinks, with illustrative duration `ceil(single_duration * 1.4)`. Running or attempted tasks are never rewritten.

Two reusable milk pitchers cycle clean -> held -> dirty -> washing -> clean. Washing is a separate task. Trays stay attached to a cart through delivery/customer use/cleanup. The planner never treats a dirty pitcher or a customer-held tray as immediately available.

## External process execution

Publish the current module first. A complete opt-in smoke run is:

```powershell
pnpm agents:demo --cancel-once --viewer <dashboard-identity>
```

This creates a private external run, grants the service identity access, starts a supervisor and its real worker processes, enqueues three carts, requests one mid-task cancellation, and waits for completion. It explicitly selects the **demo adapter**, which models coffee work with cancellable timers. No model calls, real payments, coffee hardware, AWS instances, or measured provider charges are implied. The dashboard shows an authorized run under **External workers**. The usual nine scenario buttons continue to drive deterministic paired database benchmarks.

Do not run another supervisor on the same port/identity while running this command. To use your own execution adapter, export `adapter.execute(job, signal)` from a local TS/JS module matching `apps/agent-service/src/adapter.ts`, then configure root `.env` or process environment:

```dotenv
SYNC_AGENT_RUN_ID=123
SYNC_AGENT_ADAPTER=adapters/my-agent.ts
PORT=3001
```

Run `pnpm dev:agents`. The run must use the existing wire mode `claude` (now means external execution, regardless of adapter provider). Grant the identity printed by the supervisor the `service` permission using the run owner's `grant_member` reducer. A service identity cannot self-grant or control other runs. `/health` includes identity/process count; `/ready` returns 200 only after configuration, connection, subscription and authorized run visibility.

Application identity tokens live in ignored `.local/agents`, scoped to URI/database. They are separate from your publishing token. An exclusive supervisor lock prevents a second local process from replaying the same identity's jobs. After a hard crash, verify the old supervisor and children have stopped before removing its stale `.lock`; do not delete identity tokens.

Each process receives an immutable task observation with the attempt, recipe key, cart keys and all order IDs. It reports one of:

- `completed`: the action actually completed. The database validates ownership and attempt before committing completion.
- `stopped`: cancellation was acknowledged, no effect was committed, and physical inputs are reusable. An AbortSignal alone is not enough to make this claim.
- `uncertain`: side effects may have occurred; retain ownership and reservations for reconciliation.

External tasks **never finish merely because their predicted finish tick elapsed**. An owner/operator calls `request_job_cancellation`; claimed/running tasks retain reservations until the worker acknowledges. Completed-vs-cancel races accept the actual completed outcome. Cancelled started attempts are charged their full modeled cost conservatively. Stale completions cannot finish a replacement attempt. If no clean pitchers remain and a wash task is ready, SYNC requests interruption of active tray cleaning to prioritize recycling.

A crash, adapter exception, restart with previously claimed work, or unknown outcome is not an automatic safe retry. `reconcile_job` remains owner-only. Use `retry_safe` only after verifying no external effect; `resume` means the owner has reconciled the existing action and a service can report its actual outcome. Network loss makes readiness fail; stop/restart the supervisor after restoring connectivity. Unacknowledged shutdown work remains reserved. Production adapters must provide their own idempotency keys and durable effect reconciliation; a database cannot guarantee exactly-once external side effects.

## Planning and reward

The bounded rolling planner considers the **revealed full DAG**, including blocked successors. A forecast successor is feasible only after a selected/running predecessor's predicted finish; actual admission still requires every real predecessor to have succeeded. Unknown future arrivals are never read. The horizon is 24 ticks, candidate cap 4096, and price iterations 16. Worker-time, station-time, modeled budget, available trays and clean pitchers are separate knapsack dimensions. Conservative pitcher/tray forecasts do not assume future recycling capacity will appear.

Projected capacity prices and feasible repair produce a heuristic schedule, not an exact optimal solution or a competitive-ratio guarantee. The planning utility uses downstream order value, aging, lateness pressure, recycling urgency and a bounded cost penalty. This is a progress surrogate; it is not the measured terminal reward. Only starts due now are admitted; forecasts are invalidated by state changes or bounded timer wakeups.

Staffing activates extra slots when near-term role demand exceeds one worker. Idle spare workers deactivate as demand falls. Compatible idle servers/cashiers can help other roles; role station capacity still applies. Checkout receives backpressure when preparation is congested. Busy or uncertain workers cannot be silently removed to free capacity.

`domain/reward.ts` defines explicit terminal-cart reward minus waiting, lateness, modeled execution, cancelled attempts, active-worker-time and planning-time penalties. The coefficients are illustrative and should be calibrated to project economics. UI execution dollars are labeled **modeled**. Live planning time stays unmeasured unless supplied by instrumentation; RPC round-trip time is not reported as optimizer time.

```powershell
pnpm benchmark --scenario Low-3 --seeds '5,17,29'
# all nine scenarios, three seeds:
pnpm benchmark
```

Output: `.local/benchmarks/latest.json`. It records local optimizer wall time (total/p95), optimizer overhead fraction, total simulation wall time, execution cost, terminal reward/penalties and completion ticks. Both policies get identical arrivals/resources and four initial workers; SYNC may use its three extra slots, whose active time is charged explicitly. Thus this evaluates the combined scheduling/scaling policy, not an equal-worker-count comparison. Timings are local-engine measurements, not Maincloud performance or cloud invoices.

## References and scope

The supplied PDF's separation of advisory forecasting, authoritative admission, terminal outcomes and fenced attempts informs this implementation. Its initial nonpreemption assumption is extended here with the explicitly requested external cancellation handshake.

The supplied repositories provide related ideas, not a drop-in theorem for this problem:

- https://github.com/LucCote/MSM-Primal-Dual — primal-dual methods for submodular maximization under cardinality constraints.
- https://github.com/marcosd3souza/fast-ai-alloc — multi-resource allocation and comparative performance evaluation.
- https://github.com/seanrsinclair/Online-Resource-Allocation — online allocation under limited resources and uncertain future demand.

Their objective and feasibility assumptions differ from this DAG/cancellation system. No approximation guarantee is transferred to SYNC. Finite instances permit bounded practical heuristics; they do not make NP-hard optimization polynomial-time tractable.
