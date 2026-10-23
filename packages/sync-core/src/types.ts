export type Policy = 'fcfs' | 'resource-aware';
export type TaskState =
  'blocked' | 'ready' | 'assigned' | 'running' | 'succeeded' | 'failed';
export type JobState =
  'pending' | 'claimed' | 'accepted' | 'failed' | 'uncertain';
export interface Task {
  id: bigint;
  state: TaskState;
  capabilities: string[];
  duration: number;
  release: number;
  deadline?: number;
  attempt: number;
  dependencies: bigint[];
  requirements: { resourceId: bigint; units: number }[];
  startedAt?: number;
}
export interface Worker {
  id: bigint;
  capabilities: string[];
  taskId?: bigint;
}
export interface Resource {
  id: bigint;
  capacity: number;
}
export interface Reservation {
  taskId: bigint;
  attempt: number;
  resourceId: bigint;
  units: number;
}
export interface Snapshot {
  tick: number;
  tasks: Task[];
  workers: Worker[];
  resources: Resource[];
  reservations: Reservation[];
}
export interface Assignment {
  taskId: bigint;
  workerId: bigint;
  reason: 'FCFS_FEASIBLE' | 'URGENCY_AGE_DURATION';
}
export interface ScheduleProposal {
  assignments: Assignment[];
}
