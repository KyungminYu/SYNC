import { it, expect } from 'vitest';
import { ConnectionId, Identity } from 'spacetimedb';
import {
  createModuleTestHarness,
  TestAuth,
} from 'spacetimedb/server/test-utils';
import database, * as reducers from './index';
const auth = (name: string) =>
  TestAuth.fromJwtPayload(
    JSON.stringify({ iss: 'sync-test', sub: name }),
    new ConnectionId(1n),
  );
function setup() {
  const h = createModuleTestHarness(database, reducers);
  const owner = auth('owner'),
    a = auth('a'),
    b = auth('b');
  h.withReducerTx(owner, (ctx) =>
    reducers.createDemoRun(ctx, { seed: 42, policy: 'fcfs' }),
  );
  const runId = [...h.db.run.iter()][0].id;
  const identity = (who: ReturnType<typeof auth>) => {
    let result = Identity.zero();
    h.withReducerTx(who, (ctx) => {
      result = ctx.sender;
    });
    return result;
  };
  const identityA = identity(a),
    identityB = identity(b);
  h.withReducerTx(owner, (ctx) => {
    reducers.registerService(ctx, { runId, identity: identityA });
    reducers.registerService(ctx, { runId, identity: identityB });
    reducers.startRun(ctx, { runId });
  });
  return { h, owner, a, b, runId };
}
it('only controller registers services; one job has one claiming owner', () => {
  const { h, a, b, runId } = setup();
  expect(() =>
    h.withReducerTx(a, (ctx) =>
      reducers.registerService(ctx, { runId, identity: ctx.sender }),
    ),
  ).toThrow('Controller');
  const job = [...h.db.agentJob.iter()][0];
  h.withReducerTx(a, (ctx) => reducers.claimAgentJob(ctx, { jobId: job.id }));
  expect(() =>
    h.withReducerTx(b, (ctx) => reducers.claimAgentJob(ctx, { jobId: job.id })),
  ).toThrow('unavailable');
  expect(() =>
    h.withReducerTx(b, (ctx) =>
      reducers.submitAgentAction(ctx, {
        jobId: job.id,
        taskId: job.taskId,
        attempt: job.attempt,
        action: 'start_operation',
      }),
    ),
  ).toThrow('owner');
});
it('stale actions and retired generations cannot mutate reservations', () => {
  const { h, a, owner, runId } = setup();
  const job = [...h.db.agentJob.iter()][0];
  h.withReducerTx(a, (ctx) => reducers.claimAgentJob(ctx, { jobId: job.id }));
  expect(() =>
    h.withReducerTx(a, (ctx) =>
      reducers.submitAgentAction(ctx, {
        jobId: job.id,
        taskId: job.taskId,
        attempt: 99,
        action: 'start_operation',
      }),
    ),
  ).toThrow('Stale');
  h.withReducerTx(owner, (ctx) => reducers.resetRun(ctx, { runId }));
  expect(() =>
    h.withReducerTx(a, (ctx) =>
      reducers.submitAgentAction(ctx, {
        jobId: job.id,
        taskId: job.taskId,
        attempt: job.attempt,
        action: 'start_operation',
      }),
    ),
  ).toThrow('Retired');
  expect([...h.db.simulationSchedule.iter()]).toHaveLength(1);
});
it('scheduled ticks complete once and release exact reservations', () => {
  const { h, a, runId } = setup();
  const job = [...h.db.agentJob.iter()][0];
  h.withReducerTx(a, (ctx) => {
    reducers.claimAgentJob(ctx, { jobId: job.id });
    reducers.submitAgentAction(ctx, {
      jobId: job.id,
      taskId: job.taskId,
      attempt: job.attempt,
      action: 'start_operation',
    });
  });
  const arg = [...h.db.simulationSchedule.iter()][0];
  for (let i = 0; i < 10; i++)
    h.withReducerTx(a, (ctx) => reducers.advanceTick(ctx, { arg }));
  expect(h.db.task.id.find(job.taskId)?.state).toBe('succeeded');
  expect([...h.db.reservation.taskId.filter(job.taskId)]).toHaveLength(0);
  expect(
    [...h.db.executionEvent.runId.filter(runId)].filter(
      (e) => e.taskId === job.taskId && e.kind === 'COMPLETED',
    ),
  ).toHaveLength(1);
});
