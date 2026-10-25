import { expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createRunnerServer } from './runnerServer';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

it('serves the dashboard, runtime database settings and runner status from one server', async () => {
  const webRoot = await mkdtemp(join(tmpdir(), 'sync-server-'));
  await mkdir(join(webRoot, 'assets'));
  await writeFile(join(webRoot, 'index.html'), '<html>SYNC dashboard</html>');
  await writeFile(
    join(webRoot, 'assets/app.js'),
    'globalThis.appLoaded = true;',
  );
  const token = 'private-operator-code-'.repeat(3);
  const runner = createRunnerServer(
    { uri: 'https://db.example', database: 'runtime-database' },
    token,
    'https://sync.example',
    { webRoot },
  );
  await new Promise<void>((resolve) =>
    runner.server.listen(0, '127.0.0.1', resolve),
  );
  const base = `http://127.0.0.1:${(runner.server.address() as AddressInfo).port}`;
  try {
    expect(await (await fetch(base)).text()).toContain('SYNC dashboard');
    const config = await fetch(`${base}/sync-config.js`);
    expect(config.headers.get('content-type')).toContain('javascript');
    expect(config.headers.get('cache-control')).toBe('no-store');
    const body = await config.text();
    expect(body).toContain('runtime-database');
    expect(body).toContain('https://db.example');
    expect(body).not.toContain(token);
    expect(await (await fetch(`${base}/health`)).json()).toEqual({
      status: 'ok',
      runtime: 'sync-container',
    });
    expect((await fetch(`${base}/feed`)).status).toBe(200);
    expect(
      (await fetch(`${base}/assets/app.js`)).headers.get('content-type'),
    ).toContain('javascript');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect(await (await fetch(`${base}/a-client-route`)).text()).toContain(
      'SYNC dashboard',
    );
    expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(400);
  } finally {
    runner.close();
    await rm(webRoot, { recursive: true, force: true });
  }
});
