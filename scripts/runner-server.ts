import { databaseConfig } from './lib/databaseConfig.mjs';
import { createRunnerServer } from './lib/runnerServer';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './lib/databaseConfig.mjs';

for (const name of ['.env.local', '.env']) {
  const path = resolve(repoRoot, name);
  if (existsSync(path)) loadEnvFile(path);
}
if (
  !(
    process.env.SPACETIME_URI ||
    process.env.SPACETIMEDB_URI ||
    process.env.VITE_SPACETIMEDB_URI
  ) ||
  !(process.env.SPACETIMEDB_DATABASE || process.env.VITE_SPACETIMEDB_DATABASE)
)
  throw new Error(
    'Configure SPACETIME_URI and SPACETIMEDB_DATABASE in the container runtime environment.',
  );
const port = Number(process.env.PORT ?? 3003);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer between 1 and 65535.');
if (!existsSync(resolve(repoRoot, 'apps/web/dist/index.html')))
  throw new Error(
    'Dashboard build missing. Run pnpm build:web before pnpm start:runner.',
  );
if (!!process.env.SYNC_AGENT_ADAPTER !== !!process.env.SYNC_AGENT_RUN_ID)
  throw new Error(
    'External workers require both SYNC_AGENT_ADAPTER and SYNC_AGENT_RUN_ID.',
  );

// One persistent instance behind HTTPS, with persistent .local storage.
const runner = createRunnerServer(
  databaseConfig('production'),
  process.env.SYNC_RUNNER_TOKEN ?? '',
  // Render provides the service's public URL; an explicit origin wins.
  process.env.SYNC_RUNNER_ORIGIN || process.env.RENDER_EXTERNAL_URL || '',
);
runner.server.listen(port, '0.0.0.0', () => {
  console.log(
    `SYNC application listening on port ${port}. Dashboard, /feed and /health share this server.`,
  );
});
const agents = process.env.SYNC_AGENT_ADAPTER
  ? spawn(
      process.execPath,
      ['--import', 'tsx', resolve(repoRoot, 'apps/agent-service/src/main.ts')],
      {
        cwd: repoRoot,
        env: { ...process.env, PORT: port === 3001 ? '3002' : '3001' },
        stdio: 'inherit',
        windowsHide: true,
      },
    )
  : undefined;
let stopping = false;
function close() {
  if (stopping) return;
  stopping = true;
  agents?.kill();
  runner.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 10000).unref();
}
agents?.once('error', (error) => {
  console.error('Could not start external worker supervisor:', error.message);
  process.exitCode = 1;
  close();
});
agents?.once('exit', (code) => {
  if (!stopping) {
    console.error(
      `External worker supervisor exited (${code}). Restarting the application is required.`,
    );
    process.exitCode = 1;
    close();
  }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, close);
