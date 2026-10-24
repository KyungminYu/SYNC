import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = readdirSync('spacetimedb/tests')
  .filter((name) => name.endsWith('.node.test.ts'))
  .map((name) => 'spacetimedb/tests/' + name);
// tsx supports Node 22 and 24 without requiring native TypeScript stripping.
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
