import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';
if (existsSync('.env')) loadEnvFile('.env');
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
  SPACETIMEDB_URI: z.url().default('http://127.0.0.1:3000'),
  SPACETIMEDB_DATABASE: z.string().min(1).default('sync-local'),
  SPACETIMEDB_TOKEN: z.string().optional(),
  AGENT_MODE: z.enum(['deterministic', 'claude']).default('deterministic'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  AGENT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(4),
  AGENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(30000),
});
export const config = schema.parse(process.env);
if (config.AGENT_MODE === 'claude' && !config.ANTHROPIC_API_KEY)
  throw new Error('Claude mode requires ANTHROPIC_API_KEY');
