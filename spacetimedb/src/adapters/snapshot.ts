import type { Policy, TaskState } from '@sync/core';
export function taskState(value: string): TaskState {
  if (
    value === 'blocked' ||
    value === 'ready' ||
    value === 'assigned' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed'
  )
    return value;
  throw new Error(`Invalid stored task state: ${value}`);
}
export function policyId(value: string): Policy {
  if (value === 'fcfs' || value === 'resource-aware') return value;
  throw new Error(`Invalid stored scheduling policy: ${value}`);
}
