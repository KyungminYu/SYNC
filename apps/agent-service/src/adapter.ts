/** Adapter contract: stopped means no committed effect and reusable inputs.
 * An AbortSignal is a request, never proof of a safe stop. */
export interface ExecutionJob {
  id: string;
  runId: string;
  workerId: string;
  taskId: string;
  attempt: number;
  action: string;
  observation: Record<string, unknown>;
}
export type ExecutionOutcome = 'completed' | 'stopped' | 'uncertain';
export interface ExecutionAdapter {
  execute(job: ExecutionJob, signal: AbortSignal): Promise<ExecutionOutcome>;
}
