# Local integration validation — 2026-10-24

This record replaces the source bundle's unverified deployment notes. Checks use the actual workspace and SpacetimeDB CLI/server/module/client SDK 2.13.0.

- 45 domain/policy/access/persistence tests pass with the Node test runner via tsx.
- Three real SDK harness tests pass: identity-filtered views, full deterministic reducer lifecycle and resource release, and rollback.
- CLI module build and canonical binding generation succeed; private base tables are excluded from bindings.
- Fresh local publication to `sync-coffee-dev` succeeds. The existing `sync-local` database is not reset or migrated.
- Real network integration passes: six policy catalog entries; unrelated identity sees no runs; viewer grant reveals rows but still rejects control; black coffee and latte reach cleaned state via scheduled reducers; resource reservations reach zero; revoking viewer access removes subscribed run/order rows.

The integration test is opt-in and inserts only its own private verification data. No application startup auto-seeds orders. Test doubles in domain tests do not stand in for the separately executed host/subscription test.

UI workflow and Claude service integration are intentionally pending. The web app is a connection-status placeholder; the service reports not ready. Live Anthropic requests, billing, and a completed teammate UI have not been verified. Database-mode deterministic simulation remains authoritative functionality, with illustrative durations/costs, not real café measurements.

See the root README for build, typecheck, lint, formatting, and test commands. Full service reconnect/race/usage integration should be added when that service is implemented.
