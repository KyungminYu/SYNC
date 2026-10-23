import type { Snapshot } from '@sync/core';
/** Seeded fixture, not measured production traffic. */
export function demoFixture(seed: number): Snapshot {
  let n = seed >>> 0;
  const random = () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n / 4294967296;
  };
  return {
    tick: 0,
    workers: Array.from({ length: 4 }, (_, i) => ({
      id: BigInt(i + 1),
      capabilities: i % 2 ? ['prepare', 'finish'] : ['prepare', 'heat'],
    })),
    resources: [
      { id: 1n, capacity: 2 },
      { id: 2n, capacity: 1 },
    ],
    reservations: [],
    tasks: Array.from({ length: 8 }, (_, i) => ({
      id: BigInt(i + 1),
      state: i < 3 ? 'ready' : 'blocked',
      capabilities: [i < 3 ? 'prepare' : i < 6 ? 'heat' : 'finish'],
      duration: 2 + Math.floor(random() * 4),
      release: i < 3 ? 0 : i,
      deadline: 12 + i * 3,
      attempt: 0,
      dependencies: i < 3 ? [] : [BigInt(i - 2)],
      requirements: [{ resourceId: i < 3 ? 1n : 2n, units: 1 }],
    })),
  };
}
