import type { ExecutionAdapter } from './adapter.ts';
/** Explicit demo adapter; real subprocess execution, modeled coffee operations. */
export const adapter: ExecutionAdapter = {
  execute(job, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve('stopped');
        return;
      }
      const ms = Math.min(
        60000,
        Math.max(1, Number(job.observation.durationTicks) || 1) * 200,
      );
      const stop = () => {
        clearTimeout(timer);
        resolve('stopped');
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', stop);
        resolve('completed');
      }, ms);
      signal.addEventListener('abort', stop, { once: true });
    });
  },
};
