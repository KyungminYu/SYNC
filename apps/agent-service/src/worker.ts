import type { ExecutionAdapter, ExecutionJob } from './adapter.ts';
// Loaded only from an operator-configured local module, never from DB job content.
const moduleUrl = process.env.SYNC_AGENT_ADAPTER_URL;
if (!moduleUrl) throw new Error('SYNC_AGENT_ADAPTER_URL required');
const { adapter } = (await import(moduleUrl)) as { adapter: ExecutionAdapter };
if (typeof adapter?.execute !== 'function')
  throw new Error('Adapter must export adapter.execute');
let current: { id: string; abort: AbortController } | undefined;
process.on(
  'message',
  async (message: { type: string; job?: ExecutionJob; jobId?: string }) => {
    if (message.type === 'cancel' && current && current.id === message.jobId) {
      current.abort.abort();
      return;
    }
    if (message.type !== 'execute' || !message.job || current) return;
    const job = message.job;
    const abort = new AbortController();
    current = { id: job.id, abort };
    let outcome: string = 'uncertain';
    try {
      outcome = await adapter.execute(job, abort.signal);
    } catch {
      /* Unknown side effects must retain claims. */
    }
    if (outcome === 'stopped' && !abort.signal.aborted) outcome = 'uncertain';
    if (!['completed', 'stopped', 'uncertain'].includes(outcome))
      outcome = 'uncertain';
    current = undefined;
    if (process.connected)
      process.send?.(
        { type: 'result', jobId: job.id, attempt: job.attempt, outcome },
        () => {
          /* Parent loss leaves the database attempt uncertain. */
        },
      );
  },
);
process.on('disconnect', () => {
  current?.abort.abort();
  setTimeout(() => process.exit(1), 1000).unref();
});
if (process.connected) process.send?.({ type: 'ready' }, () => {});
