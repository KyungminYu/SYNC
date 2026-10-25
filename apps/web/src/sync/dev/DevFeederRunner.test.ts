import { it, expect, vi, afterEach } from 'vitest';
import { DevFeederRunner } from './DevFeederRunner';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('uses the remote endpoint and never sends the operator code on public status reads', async () => {
  const prompt = vi.fn(() => 'operator-code');
  vi.stubGlobal('window', { prompt });
  const fetcher = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ llmAvailable: true }),
    });
  vi.stubGlobal('fetch', fetcher);
  const runner = new DevFeederRunner('https://runner.example/feed', true);
  expect(await runner.llmAvailable()).toBe(true);
  expect(prompt).not.toHaveBeenCalled();
  await runner.stop();
  expect(fetcher.mock.calls[1][0]).toBe('https://runner.example/feed');
  expect(fetcher.mock.calls[1][1].headers.authorization).toBe(
    'Bearer operator-code',
  );
  expect(fetcher.mock.calls[0][1].headers.authorization).toBeUndefined();
});
it('surfaces an asynchronous feeder failure to the scenario picker', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ jobId: 1 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jobId: 1,
          state: 'failed',
          lastLine: 'Schema mismatch',
        }),
      }),
  );
  const result = new DevFeederRunner().start('Low-3', 'a'.repeat(64));
  const assertion = expect(result).rejects.toThrow('Schema mismatch');
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
});
it('finishes after the feeder reports successful completion', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ jobId: 2 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jobId: 2, state: 'completed' }),
      }),
  );
  const result = new DevFeederRunner().start('Low-3', 'a'.repeat(64));
  await vi.advanceTimersByTimeAsync(1000);
  await expect(result).resolves.toBeUndefined();
});
