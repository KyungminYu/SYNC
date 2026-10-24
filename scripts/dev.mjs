import concurrently from 'concurrently';
import { databaseConfig } from './lib/databaseConfig.mjs';
const config = databaseConfig();
try {
  const r = await fetch(
    `${config.httpUri}/v1/database/${config.database}/identity`,
    { signal: globalThis.AbortSignal.timeout(10000) },
  );
  if (!r.ok) throw new Error('Database not published');
} catch {
  console.error(
    'Configured database is unavailable. Check .env, authenticate with pnpm db:login, and publish with pnpm db:publish. For a local server first run pnpm db:start.',
  );
  process.exit(1);
}
console.log(
  'Configured database available. Starting dashboard and agent service.',
);
const { result } = concurrently(
  [
    { command: 'pnpm dev:web', name: 'web' },
    { command: 'pnpm dev:agents', name: 'agents' },
  ],
  { killOthersOn: ['failure', 'success'] },
);
try {
  await result;
} catch {
  process.exitCode = 1;
}
