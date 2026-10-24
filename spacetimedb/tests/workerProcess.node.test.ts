import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const workerPath = fileURLToPath(
  new URL('../../apps/agent-service/src/worker.ts', import.meta.url),
);
const adapterUrl = new URL(
  '../../apps/agent-service/src/demoAdapter.ts',
  import.meta.url,
).href;
test('real child process acknowledges mid-task abort without an unhandled IPC error', async () => {
  const child = fork(workerPath, [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, SYNC_AGENT_ADAPTER_URL: adapterUrl },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let errors = '';
  child.stderr?.on('data', (chunk) => (errors += String(chunk)));
  try {
    const result = await new Promise<{ outcome: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Worker timeout')),
        10000,
      );
      child.on('error', reject);
      child.on('message', (message: { type: string; outcome: string }) => {
        if (message.type === 'ready') {
          child.send({
            type: 'execute',
            job: {
              id: '1',
              runId: '1',
              workerId: '2',
              taskId: '3',
              attempt: 1,
              action: 'prepare_coffee',
              observation: { durationTicks: 50 },
            },
          });
          setTimeout(() => child.send({ type: 'cancel', jobId: '1' }), 30);
        }
        if (message.type === 'result') {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    assert.equal(result.outcome, 'stopped');
    child.disconnect();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    assert.equal(errors, '');
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
