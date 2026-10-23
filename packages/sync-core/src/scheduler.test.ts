import { describe, it, expect } from 'vitest';
import { demoFixture } from '../../test-fixtures/src';
import {
  plan,
  validateProposal,
  eligible,
  completionDisposition,
} from './index';
describe.each(['fcfs', 'resource-aware'] as const)('%s', (policy) => {
  it('is deterministic and respects capacities and compatibility across seeds', () => {
    for (let seed = 0; seed < 100; seed++) {
      const s = demoFixture(seed);
      const p = plan(s, { policy });
      expect(plan(s, { policy })).toEqual(p);
      expect(() => validateProposal(s, p)).not.toThrow();
      expect(p.assignments).toHaveLength(2);
    }
  });
  it('rejects duplicate tasks and workers', () => {
    const s = demoFixture(42),
      p = plan(s, { policy });
    expect(() =>
      validateProposal(s, {
        assignments: [p.assignments[0], p.assignments[0]],
      }),
    ).toThrow();
    expect(() =>
      validateProposal(s, {
        assignments: [
          p.assignments[0],
          { ...p.assignments[1], workerId: p.assignments[0].workerId },
        ],
      }),
    ).toThrow();
  });
  it('rejects incompatible workers and over-capacity admission', () => {
    const s = demoFixture(42);
    s.workers[0].capabilities = [];
    expect(() =>
      validateProposal(s, {
        assignments: [{ taskId: 1n, workerId: 1n, reason: 'FCFS_FEASIBLE' }],
      }),
    ).toThrow();
    s.resources[0].capacity = 0;
    expect(plan(s, { policy }).assignments).toHaveLength(0);
  });
  it('keeps downstream work blocked until success', () => {
    const s = demoFixture(42);
    s.tick = 20;
    expect(eligible(s.tasks[3], s)).toBe(false);
    s.tasks[0].state = 'succeeded';
    expect(eligible(s.tasks[3], s)).toBe(true);
  });
});
it('completion is idempotent and rejects stale attempts', () => {
  const t = demoFixture(42).tasks[0];
  t.state = 'succeeded';
  t.attempt = 2;
  expect(completionDisposition(t, 2)).toBe('duplicate');
  expect(() => completionDisposition(t, 1)).toThrow('Stale attempt');
});
