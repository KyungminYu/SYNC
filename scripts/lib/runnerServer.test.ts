import { expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createRunnerServer } from './runnerServer';

it('protects mutations and restricts cross-origin requests without starting a feeder', async () => {
  const token = 'test-operator-code-'.repeat(3);
  const runner = createRunnerServer(
    { uri: 'http://127.0.0.1:3000', database: 'test' },
    token,
    'https://sync.example',
  );
  await new Promise<void>((resolve) =>
    runner.server.listen(0, '127.0.0.1', resolve),
  );
  const url = `http://127.0.0.1:${(runner.server.address() as AddressInfo).port}/feed`;
  try {
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(401);
    expect(
      (await fetch(url, { headers: { origin: 'https://other.example' } }))
        .status,
    ).toBe(403);
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { origin: 'https://sync.example' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(
      'https://sync.example',
    );
    expect(
      (
        await fetch(url, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: '{}',
        })
      ).status,
    ).toBe(400);
  } finally {
    runner.close();
  }
});
