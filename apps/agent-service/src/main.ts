import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DbConnection } from '@sync/bindings';
import pino from 'pino';
import { config } from './config/env';
import { createApp } from './http/app';
import { DeterministicWorker } from './workers/deterministic-worker';
import { ClaudeWorker } from './workers/claude-worker';
import { createRunner } from './jobs/runner';
const logger = pino({ level: config.LOG_LEVEL });
const directory = fileURLToPath(new URL('../../../.local/', import.meta.url));
mkdirSync(directory, { recursive: true });
const tokenPath = directory + 'agent-token';
let ready = false,
  stopping = false,
  connection: DbConnection | undefined,
  runner: ReturnType<typeof createRunner> | undefined,
  retry: ReturnType<typeof setTimeout> | undefined;
const provider =
  config.AGENT_MODE === 'claude'
    ? new ClaudeWorker(
        config.ANTHROPIC_MODEL,
        config.ANTHROPIC_API_KEY!,
        config.AGENT_TIMEOUT_MS,
      )
    : new DeterministicWorker();
function connect() {
  connection = DbConnection.builder()
    .withUri(config.SPACETIMEDB_URI)
    .withDatabaseName(config.SPACETIMEDB_DATABASE)
    .withToken(
      config.SPACETIMEDB_TOKEN ||
        (existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8') : undefined),
    )
    .onConnect((conn, identity, token) => {
      writeFileSync(tokenPath, token, { mode: 0o600 });
      writeFileSync(directory + 'agent-identity', identity.toHexString());
      logger.info(
        { identity: identity.toHexString() },
        'Register this service identity using the controller dashboard',
      );
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          ready = true;
          runner = createRunner(
            conn,
            provider,
            config.AGENT_MAX_CONCURRENCY,
            logger,
          );
        })
        .onError((ctx) => {
          logger.error({ error: String(ctx.event) }, 'Subscription failed');
          conn.disconnect();
        })
        .subscribeToAllTables();
    })
    .onConnectError((_ctx, error) => {
      logger.warn({ error: String(error) }, 'Database connection failed');
      reconnect();
    })
    .onDisconnect(() => reconnect())
    .build();
}
function reconnect() {
  ready = false;
  runner?.stop();
  if (!stopping && !retry)
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, 2000);
}
connect();
const timer = setInterval(() => {
  if (ready) runner?.pump();
}, 500);
const server = createApp(() => ready, config.AGENT_MODE).listen(
  config.PORT,
  '127.0.0.1',
  () => logger.info({ port: config.PORT }, 'Agent service listening'),
);
async function shutdown() {
  if (stopping) return;
  stopping = true;
  ready = false;
  clearInterval(timer);
  clearTimeout(retry);
  runner?.stop();
  const end = Date.now() + config.AGENT_TIMEOUT_MS + 1000;
  while (runner?.active && Date.now() < end)
    await new Promise((r) => setTimeout(r, 50));
  connection?.disconnect();
  server.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
