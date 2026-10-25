import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve, dirname } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
/** Public connection settings only. Tokens are never returned or bundled. */
export function databaseConfig(mode = 'development') {
  let uri = 'http://127.0.0.1:3000';
  let database = 'sync-coffee-dev';
  const layers = [];
  for (const dir of [repoRoot, resolve(repoRoot, 'apps/web')])
    for (const name of [
      '.env',
      '.env.local',
      `.env.${mode}`,
      `.env.${mode}.local`,
    ]) {
      const path = resolve(dir, name);
      if (existsSync(path)) layers.push(parseEnv(readFileSync(path, 'utf8')));
    }
  layers.push(process.env);
  for (const env of layers) {
    // Also the *_HOST / *_DB_NAME names (as in the hosting dashboards' env).
    uri =
      env.VITE_SPACETIMEDB_URI ??
      env.VITE_SPACETIMEDB_HOST ??
      env.SPACETIMEDB_URI ??
      env.SPACETIMEDB_HOST ??
      env.SPACETIME_URI ??
      uri;
    database =
      env.VITE_SPACETIMEDB_DATABASE ??
      env.VITE_SPACETIMEDB_DB_NAME ??
      env.SPACETIMEDB_DATABASE ??
      env.SPACETIMEDB_DB_NAME ??
      database;
  }
  let url;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(
      'SPACETIME_URI must be a server URL, not an authentication token. Set it to your local or hosted SpacetimeDB endpoint.',
    );
  }
  if (
    !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'SpacetimeDB URI must be an HTTP(S)/WS(S) server URL without credentials or query parameters.',
    );
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(database))
    throw new Error('Invalid SpacetimeDB database name or identity.');
  const httpUri = uri
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')
    .replace(/\/$/, '');
  return { uri: uri.replace(/\/$/, ''), httpUri, database };
}
