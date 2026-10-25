import { databaseConfig } from './lib/databaseConfig.mjs';
import { createRunnerServer } from './lib/runnerServer';

// One persistent instance behind HTTPS, with persistent .local storage.
const runner = createRunnerServer(
  databaseConfig('production'),
  process.env.SYNC_RUNNER_TOKEN ?? '',
  process.env.SYNC_RUNNER_ORIGIN ?? '',
);
runner.server.listen(Number(process.env.PORT ?? 3003), '0.0.0.0', () => {
  console.log(
    'SYNC runner listening. Use this service’s HTTPS /feed URL in the dashboard.',
  );
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => runner.close());
