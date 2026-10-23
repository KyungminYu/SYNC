import type { AgentObservation, JobResult } from '@sync/contracts';
export interface WorkerProvider {
  propose(observation: AgentObservation): Promise<JobResult>;
}
export class DeterministicWorker implements WorkerProvider {
  async propose(o: AgentObservation): Promise<JobResult> {
    return {
      action: { type: 'start_operation', taskId: o.taskId, attempt: o.attempt },
    };
  }
}
