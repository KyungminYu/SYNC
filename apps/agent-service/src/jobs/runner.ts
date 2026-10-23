import { DbConnection } from '@sync/bindings';
import { actionSchema, observationSchema, serializeId } from '@sync/contracts';
import type { WorkerProvider } from '../workers/deterministic-worker';
import type { Logger } from 'pino';
export function createRunner(
  connection: DbConnection,
  provider: WorkerProvider,
  limit: number,
  logger: Logger,
) {
  const active = new Set<bigint>();
  const seenClaims = new Set<bigint>();
  let stopped = false;
  async function processJob(jobId: bigint) {
    const started = Date.now();
    try {
      await connection.reducers.claimAgentJob({ jobId });
      const j = connection.db.agentJob.id.find(jobId);
      if (
        !j ||
        j.state !== 'claimed' ||
        !j.claimant?.isEqual(connection.identity!)
      )
        return;
      seenClaims.add(jobId);
      const task = connection.db.task.id.find(j.taskId);
      if (!task) throw new Error('Task missing');
      const result = await provider.propose(
        observationSchema.parse({
          jobId: serializeId(jobId),
          taskId: serializeId(task.id),
          attempt: j.attempt,
          capabilities: task.capabilities,
          duration: task.duration,
        }),
      );
      const action = actionSchema.parse(result.action);
      if (
        action.taskId !== serializeId(task.id) ||
        action.attempt !== j.attempt
      )
        throw new Error('Invalid proposal target');
      await connection.reducers.submitAgentAction({
        jobId,
        taskId: task.id,
        attempt: j.attempt,
        action: action.type,
      });
      logger.info(
        {
          jobId: serializeId(jobId),
          attempt: j.attempt,
          durationMs: Date.now() - started,
          usage: result.usage,
        },
        'Action accepted',
      );
    } catch (error) {
      const j = connection.db.agentJob.id.find(jobId);
      if (j?.state === 'claimed' && j.claimant?.isEqual(connection.identity!))
        await connection.reducers.markJobUncertain({ jobId }).catch(() => {});
      logger.warn(
        {
          jobId: serializeId(jobId),
          error: error instanceof Error ? error.message : 'Job error',
        },
        'Job not completed; inspect state',
      );
    } finally {
      active.delete(jobId);
    }
  }
  return {
    pump() {
      if (stopped) return;
      for (const id of seenClaims) {
        if (connection.db.agentJob.id.find(id)?.state !== 'claimed')
          seenClaims.delete(id);
      }
      for (const j of connection.db.agentJob.iter()) {
        if (
          j.state === 'claimed' &&
          j.claimant?.isEqual(connection.identity!) &&
          !active.has(j.id) &&
          !seenClaims.has(j.id)
        ) {
          seenClaims.add(j.id);
          void connection.reducers
            .markJobUncertain({ jobId: j.id })
            .catch(() => {});
        }
        if (active.size >= limit) break;
        if (
          j.state !== 'pending' ||
          active.has(j.id) ||
          connection.db.run.id.find(j.runId)?.status !== 'running'
        )
          continue;
        active.add(j.id);
        void processJob(j.id);
      }
    },
    stop() {
      stopped = true;
    },
    get active() {
      return active.size;
    },
  };
}
