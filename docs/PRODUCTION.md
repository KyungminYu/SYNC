# Production deployment

SYNC has three separate runtimes: the static dashboard on Vercel, the published
SpacetimeDB module, and persistent Node processes for scenario feeding / external
agents. Publishing the database does not start the Node processes. The Vite
development middleware (`/__dev/feed`) is not part of a production build.

## Vercel dashboard

Set the project Root Directory to the repository root (not `apps/web`). The
checked-in `vercel.json` sets:

- Install: `pnpm install --frozen-lockfile`
- Build: `pnpm typecheck:source && pnpm build:web`
- Output: `apps/web/dist`
- Development: `pnpm dev:web` (used for local development, not a production service)

Do not add `pnpm run dev` after the build. Vercel serves the output directory.
Use Node 22 matching package.json's minimum version or Node 24.

Set these public build-time variables in Vercel's Production environment (and
Preview separately if needed), then redeploy:

```text
VITE_SPACETIMEDB_URI=https://maincloud.spacetimedb.com
VITE_SPACETIMEDB_DATABASE=<the exact database published locally>
VITE_SYNC_RUNNER_URL=https://<persistent-runner-host>/feed
```

The runner URL is optional for a viewing-only deployment. Without it, controls
remain visible with a viewing-only explanation. Environment changes require a
new frontend build. Never give an API key or publisher token a `VITE_` prefix.
The frontend does not need ANTHROPIC_API_KEY, SYNC_RUNNER_TOKEN, or a database
publisher token. Remove those from Vercel unless another server feature uses them.

## Persistent scenario runner

Deploy the same repository revision to a persistent Node host (a VM or container
service), with HTTPS termination, one instance, and writable persistent storage
mounted at `.local`. Install all dependencies with `pnpm install --frozen-lockfile`
(the runner uses the tsx dependency). Start with `pnpm start:runner`.

Configure its server environment:

```text
SPACETIME_URI=https://maincloud.spacetimedb.com
SPACETIMEDB_DATABASE=<same database as the dashboard>
SYNC_RUNNER_ORIGIN=https://<exact-vercel-dashboard-domain>
SYNC_RUNNER_TOKEN=<random operator access code, at least 32 characters>
ANTHROPIC_API_KEY=<server-only key, needed only for the LLM planner>
PORT=3003
```

Use a single stable dashboard domain. Preview origins are not automatically
authorized. Route HTTPS traffic to the runner port. Do not put the runner token
in a frontend environment variable. The dashboard asks operators for it on the
first Run or Stop action and retains it only in memory until reload. Status is
public; start and stop require the code. Rotate the code by restarting the service
with a new value. This is an operator console, not a multi-user permission system.

The runner permits one scenario at a time and rejects overlapping starts. Stop
before starting another. Restarting the service interrupts an active feeder;
unfinished runs remain in the database. Use a process manager for restart, and
retain `.local` to preserve feeder identities and access to prior runs. Do not
deploy this process as a Vercel function or start a detached child during a build.

For actual external-agent execution, host `pnpm dev:agents` separately with the
configuration described in CART_EXECUTION.md. The scenario runner plays the
existing benchmark scenarios; it does not provision cloud worker machines.

## Database release and checks

Continue publishing from your local machine before deploying the matching code:

```powershell
pnpm db:generate
pnpm typecheck:source
pnpm db:publish --break-clients
pnpm db:describe
```

Review the publish output; do not reset production data to fix a schema mismatch.
Commit regenerated bindings together with module changes before pushing. The
Vercel build deliberately does not generate bindings or publish the database.

Check `/feed` on the runner: it should return JSON, not an HTML page. Open the
deployed dashboard, run a small scenario using the operator code, and verify
ticks and both result panels advance. LLM availability comes from the runner's
key configuration, not Vercel's environment. An existing key alone does not prove
the configured model is available to the account; API failures appear as run errors.

Browser identities are origin-specific. A production browser does not inherit
localhost's viewer grants. Starting through the runner grants the current viewer
access to the new runs. For previously saved runs, grant that production viewer
access from their owner; matching database names alone does not grant visibility.
