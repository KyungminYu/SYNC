import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY_CONFIG,
  plan,
  validatePolicyConfig,
  type Snapshot,
  type TaskCandidate,
  type WorkerCandidate,
} from '../src/policies/scheduler.ts';

const task = (
  id: bigint,
  extra: Partial<TaskCandidate> = {},
): TaskCandidate => ({
  id,
  orderId: id,
  releaseTick: 0,
  priority: 1,
  value: 1,
  remainingPathTicks: 0,
  requiredCapabilities: ['brew'],
  requirements: [],
  trayMode: 'none',
  ...extra,
});
const worker = (
  id: bigint,
  tasks: bigint[],
  extra: Partial<WorkerCandidate> = {},
): WorkerCandidate => ({
  id,
  capabilities: ['brew'],
  estimates: tasks.map((taskId) => ({
    taskId,
    durationTicks: 5,
    costMicrousd: 0n,
  })),
  ...extra,
});
const snapshot = (
  tasks: TaskCandidate[],
  workers: WorkerCandidate[],
  extra: Partial<Snapshot> = {},
): Snapshot => ({
  tick: 10,
  tasks,
  workers,
  resources: [],
  freeTrayIds: [],
  ...extra,
});

describe('SYNC immediate-dispatch policies', () => {
  it('enforces role compatibility, task uniqueness, and one task per worker', () => {
    const input = snapshot(
      [task(1n), task(2n), task(3n, { requiredCapabilities: ['clean'] })],
      [worker(1n, [1n, 2n, 3n]), worker(2n, [1n, 2n, 3n])],
    );
    const output = plan(input);
    assert.equal(output.length, 2);
    assert.equal(new Set(output.map((item) => item.taskId)).size, 2);
    assert.equal(new Set(output.map((item) => item.workerId)).size, 2);
    assert.equal(
      output.some((item) => item.taskId === 3n),
      false,
    );
  });

  it('aggregates duplicate resource requirements and never oversubscribes', () => {
    const tasks = [
      task(1n, {
        requirements: [
          { resourceId: 9n, units: 1 },
          { resourceId: 9n, units: 1 },
        ],
      }),
      task(2n, { requirements: [{ resourceId: 9n, units: 1 }] }),
    ];
    const input = snapshot(
      tasks,
      [worker(1n, [1n, 2n]), worker(2n, [1n, 2n])],
      {
        resources: [{ id: 9n, freeUnits: 2 }],
      },
    );
    for (const policy of [
      'fcfs',
      'earliest_finish',
      'minimum_slack',
      'critical_path',
      'sync_greedy',
      'bounded_joint',
    ] as const) {
      const output = plan(input, { policy });
      const reserved = output.reduce(
        (sum, assignment) =>
          sum +
          tasks
            .find((item) => item.id === assignment.taskId)!
            .requirements.reduce((s, req) => s + req.units, 0),
        0,
      );
      assert.ok(reserved <= 2);
    }
  });

  it('assigns distinct trays and does not count a pending return as available', () => {
    const tasks = [
      task(1n, { trayMode: 'acquire' }),
      task(2n, { trayMode: 'acquire' }),
      task(3n, { trayMode: 'release' }),
    ];
    const workers = [
      worker(1n, [1n, 2n, 3n]),
      worker(2n, [1n, 2n, 3n]),
      worker(3n, [1n, 2n, 3n]),
    ];
    for (const policy of ['fcfs', 'bounded_joint'] as const) {
      const output = plan(snapshot(tasks, workers, { freeTrayIds: [8n] }), {
        policy,
      });
      assert.equal(
        output.filter((item) => item.trayId !== undefined).length,
        1,
      );
      assert.equal(
        output.find((item) => item.trayId !== undefined)!.trayId,
        8n,
      );
      assert.equal(output.length, 2);
    }
  });

  it('uses a stable order and does not mutate its snapshot', () => {
    const input = snapshot(
      [task(2n), task(1n)],
      [worker(2n, [1n, 2n]), worker(1n, [1n, 2n])],
    );
    const before = structuredClone(input);
    assert.deepEqual(plan(input), plan(input));
    assert.deepEqual(input, before);
    assert.equal(plan(input)[0]!.taskId, 1n);
    assert.equal(plan(input)[0]!.workerId, 1n);
  });

  it('joint allocation preserves a specialist opportunity missed by greedy pairing', () => {
    const tasks = [task(1n), task(2n, { requiredCapabilities: ['milk'] })];
    const workers = [
      worker(1n, [1n, 2n], {
        capabilities: ['brew', 'milk'],
        estimates: [
          { taskId: 1n, durationTicks: 3, costMicrousd: 0n },
          { taskId: 2n, durationTicks: 4, costMicrousd: 0n },
        ],
      }),
      worker(2n, [1n], {
        estimates: [{ taskId: 1n, durationTicks: 5, costMicrousd: 0n }],
      }),
    ];
    const input = snapshot(tasks, workers);
    assert.equal(plan(input, { policy: 'earliest_finish' }).length, 1);
    const joint = plan(input, {
      policy: 'bounded_joint',
      criticalityWeight: 0,
    });
    assert.equal(joint.length, 2);
    assert.equal(joint.find((item) => item.workerId === 1n)!.taskId, 2n);
    assert.equal(joint.find((item) => item.workerId === 2n)!.taskId, 1n);
  });

  it('orders deadlines by slack and handles absent deadlines', () => {
    const input = snapshot(
      [
        task(1n),
        task(2n, { deadlineTick: 15 }),
        task(3n, { deadlineTick: 14 }),
      ],
      [worker(1n, [1n, 2n, 3n])],
    );
    assert.equal(plan(input, { policy: 'minimum_slack' })[0]!.taskId, 3n);
  });

  it('filters unreleased tasks and pairs with missing estimates', () => {
    const input = snapshot(
      [task(1n, { releaseTick: 11 }), task(2n)],
      [worker(1n, [1n])],
    );
    assert.deepEqual(plan(input), []);
  });

  it('returns a feasible deterministic incumbent when its joint search budget ends', () => {
    const input = snapshot(
      [task(1n), task(2n)],
      [worker(1n, [1n, 2n]), worker(2n, [1n, 2n])],
    );
    const output = plan(input, { policy: 'bounded_joint', maxBranches: 1 });
    assert.equal(output.length, 2);
    assert.ok(output[0]!.reasonCodes.includes('search_budget_reached'));
    assert.deepEqual(
      output,
      plan(input, { policy: 'bounded_joint', maxBranches: 1 }),
    );
  });

  it('default configuration round-trips through JSON without loss', () => {
    const decoded = JSON.parse(JSON.stringify(DEFAULT_POLICY_CONFIG));
    validatePolicyConfig(decoded);
    assert.deepEqual(decoded, DEFAULT_POLICY_CONFIG);
  });

  it('enforces cumulative modeled budget across every policy and worker', () => {
    const tasks = [task(1n), task(2n), task(3n)];
    const workers = [1n, 2n, 3n].map((id) =>
      worker(id, [1n, 2n, 3n], {
        estimates: tasks.map((t) => ({
          taskId: t.id,
          durationTicks: 5,
          costMicrousd: 6n,
        })),
      }),
    );
    const input = snapshot(tasks, workers, { budgetRemainingMicrousd: 10n });
    for (const policy of [
      'fcfs',
      'earliest_finish',
      'minimum_slack',
      'critical_path',
      'sync_greedy',
      'bounded_joint',
    ] as const) {
      const output = plan(input, { policy });
      assert.equal(
        output.length,
        1,
        `${policy} must not spend 12 when only 10 remains`,
      );
      assert.ok(
        output.reduce((sum, item) => sum + item.costMicrousd, 0n) <= 10n,
      );
    }
    assert.equal(input.budgetRemainingMicrousd, 10n);
  });

  it('skips unaffordable work and can schedule several affordable alternatives', () => {
    const tasks = [task(1n), task(2n), task(3n)];
    const workers = [1n, 2n, 3n].map((id) =>
      worker(id, [1n, 2n, 3n], {
        estimates: tasks.map((t) => ({
          taskId: t.id,
          durationTicks: 5,
          costMicrousd: t.id === 1n ? 11n : t.id === 2n ? 4n : 5n,
        })),
      }),
    );
    for (const policy of ['fcfs', 'sync_greedy', 'bounded_joint'] as const) {
      const output = plan(
        snapshot(tasks, workers, { budgetRemainingMicrousd: 10n }),
        { policy },
      );
      assert.equal(output.length, 2);
      assert.equal(
        output.reduce((sum, item) => sum + item.costMicrousd, 0n),
        9n,
      );
      assert.equal(
        output.some((item) => item.taskId === 1n),
        false,
      );
    }
  });

  it('allows zero-cost work with zero budget and rejects a negative budget', () => {
    const input = snapshot([task(1n)], [worker(1n, [1n])], {
      budgetRemainingMicrousd: 0n,
    });
    assert.equal(plan(input).length, 1);
    assert.equal(plan(input, { policy: 'bounded_joint' }).length, 1);
    assert.throws(
      () => plan({ ...input, budgetRemainingMicrousd: -1n }),
      /budgetRemainingMicrousd/,
    );
  });

  it('rejects malformed configuration and inconsistent snapshots', () => {
    assert.throws(() =>
      validatePolicyConfig({
        ...DEFAULT_POLICY_CONFIG,
        urgencyWeight: Number.NaN,
      }),
    );
    assert.throws(() =>
      validatePolicyConfig({ ...DEFAULT_POLICY_CONFIG, maxBranches: 0 }),
    );
    assert.throws(
      () => plan(snapshot([task(1n), task(1n)], [])),
      /Duplicate task/,
    );
    assert.throws(
      () =>
        plan(
          snapshot(
            [task(1n)],
            [
              worker(1n, [1n], {
                estimates: [{ taskId: 1n, durationTicks: 0, costMicrousd: 0n }],
              }),
            ],
          ),
        ),
      /durationTicks/,
    );
  });
});
