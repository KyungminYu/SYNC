import { it, expect, vi, afterEach } from 'vitest';
import { DevFeederRunner } from './DevFeederRunner';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
