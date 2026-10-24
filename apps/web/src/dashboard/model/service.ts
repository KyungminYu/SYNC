/**
 * Service speed at the playhead (Figma Scorecard › "Not scored · service
 * speed"): when the last customer so far was served and how long served
 * customers waited. Shown beside objective (20) but never part of it, so a
 * run that finishes the same orders sooner still shows the difference.
 * Pure function of the delivered rows; no React.
 */
import type { RunData } from '../../sync/contract';

export interface ServiceSpeed {
  /** Time the last customer served so far was served; null = nobody yet. */
  lastDone: number | null;
  /** Mean arrival → served time of customers served so far; null = nobody yet. */
  meanWait: number | null;
  /** Customers served so far. */
  served: number;
}

export function serviceAt(data: RunData, t: number): ServiceSpeed {
  const arrival = new Map(data.jobs.map((j) => [j.id, j.arrival]));
  // One completion per customer (the first, if rows were delivered twice).
  const done = new Map<string, number>();
  for (const e of data.events)
    if (e.type === 'job.completed' && e.jobId && e.t <= t && !done.has(e.jobId))
      done.set(e.jobId, e.t);
  if (!done.size) return { lastDone: null, meanWait: null, served: 0 };
  let last = 0,
    wait = 0;
  for (const [job, at] of done) {
    last = Math.max(last, at);
    wait += at - (arrival.get(job) ?? at);
  }
  return { lastDone: last, meanWait: wait / done.size, served: done.size };
}
