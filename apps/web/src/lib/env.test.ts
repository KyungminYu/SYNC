import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('uses the running container database configuration before creating browser connections', async () => {
  vi.stubGlobal('__SYNC_CONFIG__', {
    spacetimeUri: 'https://runtime.example',
    database: 'runtime-db',
  });
  const { env } = await import('./env');
  expect(env.VITE_SPACETIMEDB_URI).toBe('https://runtime.example');
  expect(env.VITE_SPACETIMEDB_DATABASE).toBe('runtime-db');
});
