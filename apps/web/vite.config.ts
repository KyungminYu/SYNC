import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { devFeederPlugin } from './devFeederPlugin';
export default defineConfig(({ mode }) => {
  // Same database the dashboard reads (apps/web/.env.local).
  const env = loadEnv(mode, __dirname);
  return {
    plugins: [
      react(),
      tailwind(),
      // Dev only: the dashboard's "Start new scenario" runs the test feeder.
      devFeederPlugin(env.VITE_SPACETIMEDB_DATABASE ?? 'sync-coffee-dev'),
    ],
    server: { port: 5173, strictPort: true },
    build: { chunkSizeWarningLimit: 1600 },
  };
});
