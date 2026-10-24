import { it, expect, vi, afterEach } from 'vitest';
import { databaseConfig } from '../../scripts/lib/databaseConfig.mjs';
afterEach(() => vi.unstubAllEnvs());
it('uses process overrides consistently for server and database', () => {
  vi.stubEnv('VITE_SPACETIMEDB_URI', 'https://maincloud.spacetimedb.com');
  vi.stubEnv('VITE_SPACETIMEDB_DATABASE', 'example-db');
  expect(databaseConfig()).toEqual({
    uri: 'https://maincloud.spacetimedb.com',
    httpUri: 'https://maincloud.spacetimedb.com',
    database: 'example-db',
  });
});
it('rejects a token in the URI without including the credential in the error', () => {
  const secret = 'eyJ-not-a-url-sensitive';
  vi.stubEnv('VITE_SPACETIMEDB_URI', secret);
  try {
    databaseConfig();
    throw new Error('Expected rejection');
  } catch (error) {
    expect(String(error)).toContain('server URL');
    expect(String(error)).not.toContain(secret);
  }
});
it('rejects embedded credentials in URLs', () => {
  vi.stubEnv('VITE_SPACETIMEDB_URI', 'https://user:secret@example.test');
  expect(() => databaseConfig()).toThrow('without credentials');
});
