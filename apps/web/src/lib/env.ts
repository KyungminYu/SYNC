/// <reference types="vite/client" />
import { z } from 'zod';
export const env = z
  .object({
    VITE_SPACETIMEDB_URI: z.url().default('http://127.0.0.1:3000'),
    VITE_SPACETIMEDB_DATABASE: z.string().min(1).default('sync-local'),
  })
  .parse(import.meta.env);
