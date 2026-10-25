# Tick performance

Runs start paused and now acquire a 200 ms scheduled clock only when started.
Pausing or completing a run removes its clock. A queued callback from an old
clock cannot advance a resumed run. After publishing, existing clocks belonging
to paused or completed runs remove themselves on their next callback, before
loading child tables. No schema migration or data reset is needed.

Previously every saved paused run continued invoking the reducer five times per
second and loading its full state. For example, 25 paused runs could produce 125
callbacks per second even with no active scenario. With this change, scheduled
tick traffic should settle to approximately five calls per second per running
run, plus other reducers and any transient old callbacks. A running baseline/SYNC
pair therefore still produces approximately ten scheduled calls per second.

Persistence now compares primitive fields and arrays directly, reads existing
child rows once per table, and writes only changed rows (including the run row).
Order views aggregate task counts once per task, and task views reuse downstream
DAG estimates within each evaluation. Private tables and membership checks are
unchanged. Active ticks still load full state and views still depend on run state;
these changes reduce work but do not bypass SpacetimeDB view reevaluation.

## Publish and measure

Confirm the configured database target, then run:

```sh
pnpm db:publish
pnpm db:logs
```

Publish uses `--delete-data=never`. There are no new schema fields or client
bindings. This module-only change does not require rebuilding the dashboard.

Compare the same scenario, connected clients, and number of running runs before
and after publishing. First verify that paused runs stop producing sustained
reducer traffic. Then inspect `[perf] tick_run run=<id>` timings for `load`,
`advance`, `save`, and `total`. Manual steps use the same labels under `step_run`.
Timers close on failure, so a timing line alone does not mean a tick committed.

These host timers measure reducer code, including diagnostic overhead. They do
not measure subsequent transaction commit, view evaluation, network delivery, or
browser rendering. Compare them with server compute and observed tick delivery
latency. If reducer timings improve but delivery still stalls, capture server
view/subscription timings before choosing a further projection-table redesign.
No production speedup is asserted by the local tests.
