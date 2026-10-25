import { defineConfig } from 'vitest/config';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';
export default defineConfig({
  plugins: [spacetimedbModuleTestPlugin()],
  test: {
    include: [
      'packages/**/*.test.ts',
      'spacetimedb/tests/*.module.test.ts',
      'apps/**/*.test.{ts,tsx}',
      'scripts/lib/runnerServer.test.ts',
    ],
    environment: 'node',
  },
});
