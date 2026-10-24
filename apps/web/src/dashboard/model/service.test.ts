/** Service speed (not scored): last customer served and mean wait at the playhead. */
import { expect, it } from 'vitest';
import { simulate } from '../../sync/mock/scenario';
import { serviceAt } from './service';

const run = simulate('sync', { seed: 5 });

it('is empty before anyone is served and grows with the playhead', () => {
  expect(serviceAt(run, 0)).toEqual({ lastDone: null, meanWait: null, served: 0 });
  const end = serviceAt(run, run.run.simTime);
  const done = run.events.filter((e) => e.type === 'job.completed');
  expect(end.served).toBe(new Set(done.map((e) => e.jobId)).size);
  expect(end.lastDone).toBe(Math.max(...done.map((e) => e.t)));
  expect(end.meanWait).toBeGreaterThan(0);
});

it('measures wait from arrival to being served', () => {
  const data = {
    ...run,
    jobs: [
      { ...run.jobs[0], id: 'a', arrival: 10 },
      { ...run.jobs[0], id: 'b', arrival: 20 },
    ],
    events: [
      { seq: 1, t: 40, type: 'job.completed' as const, jobId: 'a' },
      { seq: 2, t: 50, type: 'job.completed' as const, jobId: 'b' },
      // A duplicated delivery must not count twice.
      { seq: 3, t: 55, type: 'job.completed' as const, jobId: 'b' },
    ],
  };
  expect(serviceAt(data, 45)).toEqual({ lastDone: 40, meanWait: 30, served: 1 });
  expect(serviceAt(data, 60)).toEqual({ lastDone: 50, meanWait: 30, served: 2 });
});
