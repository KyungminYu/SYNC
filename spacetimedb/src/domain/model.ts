import type { PolicyConfig } from '../policies/scheduler.ts';
import type { RecipeId, TaskKind } from './recipes.ts';
// All entity IDs except run.id are local to one run. Database primary key = runId:id.
export type Base = {
  id: bigint;
  runId: bigint;
  key: string;
};
export type RunStatus = 'paused' | 'running' | 'completed';
export type TaskStatus =
  | 'blocked'
  | 'ready'
  | 'assigned'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'uncertain';
export type Run = {
  id: bigint;
  ownerIdentityHex: string;
  name: string;
  seed: number;
  tick: number;
  status: RunStatus;
  arrivalsClosed: boolean;
  mode: 'deterministic' | 'claude';
  version: bigint;
  nextId: bigint;
  eventSequence: bigint;
  policyJson: string;
  maxOrders: number;
  budgetMicrousd?: bigint;
  modeledSpentMicrousd: bigint;
  reservedMicrousd: bigint;
};
export type Member = Base & {
  identityHex: string;
  permission: 'viewer' | 'operator' | 'service';
  enabled: boolean;
};
export type Order = Base & {
  externalKey: string;
  recipe: RecipeId;
  arrivalTick: number;
  deadlineTick: number;
  value: number;
  priority: number;
  customerUseTicks: number;
  status: 'open' | 'delivered' | 'cleaned';
  deliveredTick?: number;
  customerReleaseTick?: number;
  cleanupCompletedTick?: number;
  trayId?: bigint;
};
export type Task = Base & {
  orderId: bigint;
  kind: TaskKind;
  role: string;
  status: TaskStatus;
  releaseTick: number;
  deadlineTick?: number;
  durationTicks: number;
  priority: number;
  value: number;
  requiredCapabilities: string[];
  estimatedCostMicrousd: bigint;
  attempt: number;
  workerId?: bigint;
  startedTick?: number;
  finishedTick?: number;
  finishAtTick?: number;
  customerReleaseGuard: boolean;
  trayMode: 'none' | 'acquire' | 'release';
  errorCode?: string;
};
export type Dependency = Base & {
  orderId: bigint;
  predecessorId: bigint;
  successorId: bigint;
};
export type Worker = Base & {
  label: string;
  role: string;
  capabilities: string[];
  enabled: boolean;
  speedFactor: number;
  currentTaskId?: bigint;
  currentAttempt?: number;
  x: number;
  y: number;
};
export type Resource = Base & {
  label: string;
  role: string;
  capacity: number;
  available: boolean;
};
export type Requirement = Base & {
  taskId: bigint;
  resourceId: bigint;
  units: number;
};
export type Reservation = Base & {
  taskId: bigint;
  workerId: bigint;
  attempt: number;
  resourceId: bigint;
  units: number;
};
export type Tray = Base & {
  state: 'clean' | 'in_use' | 'dirty' | 'cleaning';
  orderId?: bigint;
};
export type Job = Base & {
  taskId: bigint;
  workerId: bigint;
  attempt: number;
  status: 'pending' | 'claimed' | 'accepted' | 'failed' | 'uncertain';
  claimantIdentityHex?: string;
  claimedTick?: number;
  submittedTick?: number;
  expectedAction: TaskKind;
  observationJson: string;
  reservedCostMicrousd: bigint;
};
export type Decision = Base & {
  sequence: bigint;
  tick: number;
  policy: string;
  taskId: bigint;
  workerId: bigint;
  attempt: number;
  score: number;
  reasonCodes: string[];
  snapshotVersion: bigint;
};
export type Event = Base & {
  sequence: bigint;
  tick: number;
  type: string;
  taskId?: bigint;
  orderId?: bigint;
  workerId?: bigint;
  attempt?: number;
  detail: string;
};
export type Telemetry = Base & {
  externalKey: string;
  taskId?: bigint;
  attempt?: number;
  source: 'anthropic' | 'coordinator';
  inputTokens: bigint;
  outputTokens: bigint;
  reportedCostMicrousd: bigint;
  wallMilliseconds: number;
  reporterIdentityHex: string;
};
export type State = {
  run: Run;
  members: Member[];
  orders: Order[];
  tasks: Task[];
  dependencies: Dependency[];
  workers: Worker[];
  resources: Resource[];
  requirements: Requirement[];
  reservations: Reservation[];
  trays: Tray[];
  jobs: Job[];
  decisions: Decision[];
  events: Event[];
  telemetry: Telemetry[];
};
export type Principal = {
  identityHex: string;
};
export const STATE_TABLES = [
  'members',
  'orders',
  'tasks',
  'dependencies',
  'workers',
  'resources',
  'requirements',
  'reservations',
  'trays',
  'jobs',
  'decisions',
  'events',
  'telemetry',
] as const;
export function key(runId: bigint, id: bigint): string {
  return `${runId}:${id}`;
}
export function nextBase(s: State): Base {
  const id = s.run.nextId++;
  if (id >= 18446744073709551615n) throw new Error('ID_EXHAUSTED');
  return { id, runId: s.run.id, key: key(s.run.id, id) };
}
export function readPolicy(s: State): Partial<PolicyConfig> {
  return JSON.parse(s.run.policyJson) as Partial<PolicyConfig>;
}
