import { z } from 'zod';
export const decimalId = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((v) => BigInt(v) <= 18446744073709551615n, 'u64 overflow');
export const serializeId = (value: bigint) => decimalId.parse(value.toString());
export const parseId = (value: unknown) => BigInt(decimalId.parse(value));
export const policySchema = z.enum(['fcfs', 'resource-aware']);
export const runConfiguration = z.object({
  seed: z.number().int().min(0).max(4294967295),
  policy: policySchema,
});
export const capabilities = z.array(z.string().min(1)).max(16);
export const actionSchema = z
  .object({
    type: z.literal('start_operation'),
    taskId: decimalId,
    attempt: z.number().int().positive(),
  })
  .strict();
export const observationSchema = z.object({
  jobId: decimalId,
  taskId: decimalId,
  attempt: z.number().int().positive(),
  capabilities,
  duration: z.number().int().positive(),
});
export type AgentObservation = z.infer<typeof observationSchema>;
export type AgentAction = z.infer<typeof actionSchema>;
export const jobResultSchema = z.object({
  action: actionSchema,
  usage: z
    .object({ inputTokens: z.number(), outputTokens: z.number() })
    .optional(),
});
export type JobResult = z.infer<typeof jobResultSchema>;
export const decisionReason = z.enum([
  'FCFS_FEASIBLE',
  'URGENCY_AGE_DURATION',
  'INITIALIZED',
  'COMPLETED',
  'UNCERTAIN',
]);
export const healthSchema = z.object({
  status: z.enum(['ok', 'not_ready']),
  database: z.boolean(),
  mode: z.enum(['deterministic', 'claude']),
});
