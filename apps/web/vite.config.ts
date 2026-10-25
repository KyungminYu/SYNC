import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { devFeederPlugin } from './devFeederPlugin.ts';
import { databaseConfig } from '../../scripts/lib/databaseConfig.mjs';
export default defineConfig(({ mode }) => {
  if (process.env.VERCEL)
    throw new Error(
      'SYNC requires a persistent Docker host for its scenario and worker processes. Deploy the Dockerfile with pnpm start:runner; the static Vercel build cannot run this application.',
    );
  const config = databaseConfig(mode);
  return {
    // Only these public values reach the browser; server credentials stay private.
    define: {
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
