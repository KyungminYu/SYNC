import concurrently from 'concurrently';
try {
  const r = await fetch(
    'http://127.0.0.1:3000/v1/database/sync-coffee-dev/identity',
  );
  if (!r.ok) throw new Error('Database not published');
} catch {
  console.error(
    'Start SpacetimeDB in another terminal: pnpm db:start\nThen publish once: pnpm db:publish\nThen retry pnpm dev.',
  );
  process.exit(1);
}
console.log(
  'Database available. UI and agent integration placeholders are starting.',
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
