/// <reference types="vite/client" />
import { z } from 'zod';
const runtime = (
  globalThis as typeof globalThis & {
    __SYNC_CONFIG__?: { spacetimeUri: string; database: string };
  }
).__SYNC_CONFIG__;
export const env = z
  .object({
    VITE_SPACETIMEDB_URI: z.url().default('http://127.0.0.1:3000'),
    VITE_SPACETIMEDB_DATABASE: z.string().min(1).default('sync-coffee-dev'),
  })
  .parse({
    ...import.meta.env,
    ...(runtime
      ? {
          VITE_SPACETIMEDB_URI: runtime.spacetimeUri,
          VITE_SPACETIMEDB_DATABASE: runtime.database,
        }
      : {}),
  });
