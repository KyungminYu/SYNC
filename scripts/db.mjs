import { databaseConfig } from './lib/databaseConfig.mjs';
const needsTarget = ['publish', 'logs', 'describe'].includes(process.argv[2]);
const config = needsTarget ? databaseConfig() : { database: '', httpUri: '' };
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const local =
  process.platform === 'win32' &&
  existsSync('.tools/spacetime/spacetimedb-cli.exe');
const cli =
  process.env.SPACETIME_CLI ||
  (local ? resolve('.tools/spacetime/spacetimedb-cli.exe') : 'spacetime');
mkdirSync('.local', { recursive: true });
const command = process.argv[2];
if (command === 'start' && local && !existsSync('.local/jwt-private.pem')) {
  const keys = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync('.local/jwt-private.pem', keys.privateKey, { mode: 0o600 });
  writeFileSync('.local/jwt-public.pem', keys.publicKey);
}
const args = {
  build: ['build', '--module-path', 'spacetimedb'],
  generate: [
    'generate',
    '--lang',
    'typescript',
    '--out-dir',
    'packages/bindings/src',
    '--module-path',
    'spacetimedb',
    '--yes',
  ],
  publish: [
    'publish',
    config.database,
    '--server',
    config.httpUri,
    '--module-path',
    'spacetimedb',
    '--yes=skip-login',
    '--delete-data=never',
  ],
  logs: ['logs', config.database, '--server', config.httpUri],
  login: ['login'],
  describe: [
    'describe',
    config.database,
    '--server',
    config.httpUri,
    '--anonymous',
    '--json',
  ],
  start: [
    'start',
    '--listen-addr',
    '127.0.0.1:3000',
    '--data-dir',
    resolve('.local/database'),
    '--non-interactive',
  ],
}[command];
if (!args) throw new Error('Unknown database command');
if (command === 'publish' && process.argv.includes('--break-clients'))
  args.push('--break-clients');
if (['publish', 'logs', 'describe'].includes(command))
  console.error(`Database target: ${config.httpUri} / ${config.database}`);
const executable =
  command === 'start' && local
    ? resolve('.tools/spacetime/spacetimedb-standalone.exe')
    : cli;
if (command === 'start' && local)
  args.push(
    '--jwt-priv-key-path',
    resolve('.local/jwt-private.pem'),
    '--jwt-pub-key-path',
    resolve('.local/jwt-public.pem'),
  );
const result = spawnSync(
  executable,
  command === 'start'
    ? args
    : ['--root-dir', resolve('.local/spacetime'), ...args],
  { stdio: 'inherit', env: process.env },
);
if (result.error)
  console.error(
    'Install SpacetimeDB 2.13.0 or set SPACETIME_CLI.',
    result.error.message,
  );
process.exit(result.status ?? 1);
