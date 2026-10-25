import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { devFeederPlugin } from './devFeederPlugin.ts';
import { databaseConfig, repoRoot } from '../../scripts/lib/databaseConfig.mjs';
export default defineConfig(({ mode }) => {
  const config = databaseConfig(mode);
  const runnerUrl =
    process.env.VITE_SYNC_RUNNER_URL ??
    loadEnv(mode, repoRoot, 'VITE_').VITE_SYNC_RUNNER_URL ??
    '';
  if (runnerUrl) {
    const url = runnerUrl.startsWith('/') ? undefined : new URL(runnerUrl);
    if (
      (url &&
        (!['https:', ...(mode === 'development' ? ['http:'] : [])].includes(
          url.protocol,
        ) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash)) ||
      runnerUrl.startsWith('//')
    )
      throw new Error(
        'VITE_SYNC_RUNNER_URL must be an HTTPS endpoint without credentials or query parameters.',
      );
  }
  if (
    process.env.VERCEL &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.uri).hostname)
  )
    throw new Error(
      'Vercel requires a hosted SpacetimeDB URI. Configure VITE_SPACETIMEDB_URI and VITE_SPACETIMEDB_DATABASE.',
    );
  return {
    // Only these public values reach the browser; server credentials stay private.
    define: {
      'import.meta.env.VITE_SYNC_RUNNER_URL': JSON.stringify(runnerUrl),
      'import.meta.env.VITE_SPACETIMEDB_URI': JSON.stringify(config.uri),
      'import.meta.env.VITE_SPACETIMEDB_DATABASE': JSON.stringify(
        config.database,
      ),
    },
    plugins: [react(), tailwind(), devFeederPlugin(config)],
    server: { port: 5173, strictPort: true },
    build: { chunkSizeWarningLimit: 1600 },
  };
});
