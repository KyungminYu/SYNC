import { it, expect } from 'vitest';
import { createApp } from './app';
it('separates process liveness from database readiness', async () => {
  const server = createApp(() => false, 'deterministic').listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  try {
    expect(
      (await fetch(`http://127.0.0.1:${address.port}/health`)).status,
    ).toBe(200);
    expect((await fetch(`http://127.0.0.1:${address.port}/ready`)).status).toBe(
      503,
    );
  } finally {
    server.close();
  }
});
