# Production: one persistent Docker application

The supported production deployment is a single Docker image. Its Node server
serves the dashboard, `/feed`, `/sync-config.js`, and `/health` on the same port.
The browser always calls the same-origin `/feed`; no RUNNER_URL or
VITE_SYNC_RUNNER_URL setting is required. Public database settings come from the
running container, so the same image can target different databases without a
rebuild. Secrets never enter the browser configuration.

SpacetimeDB remains the external database configured below. Publishing its module
is a separate release step; no database publication credentials are required by
the application container.

## Build and run

Set these in the root Git-ignored `.env` for Docker Compose:

```text
SPACETIME_URI=https://maincloud.spacetimedb.com
SPACETIMEDB_DATABASE=<your published database>
SYNC_RUNNER_ORIGIN=https://<your container application's public hostname>
SYNC_RUNNER_TOKEN=<random operator code of at least 32 characters>
ANTHROPIC_API_KEY=<optional server-only key for the LLM planner>
```

For a local deployment, set SYNC_RUNNER_ORIGIN to `http://localhost:3003`.
Copied homepage URLs with a trailing slash are accepted and normalized. Startup
errors identify the origin or token setting separately. The operator token must
contain at least 32 characters without leading or trailing whitespace.
For a hosted deployment use the exact HTTPS origin (without a trailing slash or
path) where users access this container. A Vercel frontend hostname does not
route requests into your Docker container simply by setting an environment variable.

From the repository root:

```powershell
docker compose up --build -d
docker compose logs -f sync
```

The application listens on port 3003. Its host should provide HTTPS and route
traffic to that port. Deploy one replica and mount a persistent volume at
`/app/.local`; the supplied Compose configuration does this with a named volume.
This stores feeder and worker identities. Back it up, and do not remove it when
upgrading. Restarting the container interrupts an active scenario; its unfinished
database runs remain accessible through the retained identities.

For a container host that builds Dockerfiles directly, select `Dockerfile`, expose
port 3003 (or set PORT to the provider's HTTP port), supply the same runtime
variables, and mount the volume. Use the image's default command. There is no
static output directory or separate frontend deployment.

To build a reusable image and run it without Compose:

```powershell
docker build -t sync:prod .
docker run -d --name sync --init --restart unless-stopped -p 3003:3003 --env-file .env -v sync-state:/app/.local sync:prod
```

The default image command is `node --import tsx scripts/runner-server.ts` (also
available as `pnpm start`). The image includes both web assets and the scenario
feeder. Operator Run/Stop actions require the access code, entered in the browser;
it is held in memory until reload. Status and public database settings are readable
without the code. The LLM key stays on the server. A configured key does not itself
prove the selected model is available to the account; check the container logs
for API errors.

## External agent processes in the same image

The application can also launch the external worker supervisor as a child
process inside this container. Set both:

```text
SYNC_AGENT_ADAPTER=path/to/your/adapter.ts
SYNC_AGENT_RUN_ID=123
```

The adapter must be included in the image and implement the contract described
in CART_EXECUTION.md. The target run must already exist in external execution
mode (`claude` on the wire). Grant the supervisor's printed identity service
membership from that run's owner. No adapter is selected silently. The supervisor
spawns the actual per-slot worker processes, and is stopped with the application.
If the supervisor fails, the application exits so the host can restart it.
The supervisor's health port 3001 is internal; the dashboard is served on PORT.
The paired scenario benchmark feeder continues to use its existing engine-driven
execution; configuring an adapter does not change those scenarios to external mode.

## Why the previous Vercel deployment showed viewing only

The old vercel.json selected a Vite static build and served `apps/web/dist`.
That pipeline did not start the Docker image's Node process. RUNNER_URL was not
read by the browser. Pointing it at the static site's own hostname could not
create the missing `/feed` service.

Vercel supports containers as stateless Functions, with function lifetime limits
and no persistent local filesystem. The current feeder runs for minutes after
POST returns, retains its process state between status requests, and stores
identities in `.local`. It therefore requires a persistent container host.
The old Vercel configuration has been removed, and Vite now rejects builds in
Vercel so an incomplete static site cannot be published as a successful release.

References:

- https://vercel.com/kb/guide/does-vercel-support-docker-deployments
- https://vercel.com/i/can-you-run-docker-compose-on-vercel

## Database releases and visibility

Publish the database from your local machine, then deploy the matching source
revision and generated bindings:

```powershell
pnpm db:generate
pnpm typecheck:source
pnpm db:publish --break-clients
pnpm db:describe
```

Do not reset production data to repair a schema mismatch. The Docker build never
publishes the database or generates bindings; commit bindings with module changes.

Each browser origin has its own database identity. Moving from localhost or
Vercel to the container domain does not transfer existing private viewer grants.
Starting a scenario through `/feed` grants its new runs to the current browser;
older private runs need a grant from their owner.

After deployment, `/health` should return JSON with `runtime: "sync-container"`,
`/sync-config.js` should contain the correct public database address/name, and
`/feed` should return JSON status. Start a small scenario and check that ticks
advance. HTML or a 404 at these endpoints means traffic is reaching a static
frontend or the wrong service.
