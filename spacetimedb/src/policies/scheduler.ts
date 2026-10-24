/**
 * Deterministic immediate-dispatch policies. This file has no host dependencies.
 * The caller supplies the eligible task frontier and currently idle worker slots.
 * Admission MUST recheck dependencies, ownership, and capacity transactionally.
 */
export type PolicyName =
  | 'fcfs'
  | 'earliest_finish'
  | 'minimum_slack'
  | 'critical_path'
  | 'sync_greedy'
  | 'bounded_joint'
  | 'primal_dual';
export interface ResourceRequirement {
  resourceId: bigint;
  units: number;
}
export interface TaskCandidate {
  id: bigint;
  orderId: bigint;
  releaseTick: number;
  deadlineTick?: number;
  priority: number;
  value: number;
  /** Estimated downstream tail AFTER this task; zero for a terminal task. */
  remainingPathTicks: number;
  requiredCapabilities: string[];
  requirements: ResourceRequirement[];
  /** Order-owned trays persist between tasks; release never supplies capacity early. */
  trayMode: 'none' | 'acquire' | 'release';
}
export interface WorkerCandidate {
  id: bigint;
  capabilities: string[];
  estimates: {
    taskId: bigint;
    durationTicks: number;
    costMicrousd: bigint;
  }[];
}
export interface Snapshot {
  tick: number;
  tasks: TaskCandidate[];
  workers: WorkerCandidate[];
  resources: {
    id: bigint;
    freeUnits: number;
  }[];
  freeTrayIds: bigint[];
  /** Remaining modeled budget after committed spending AND existing reservations. */
  budgetRemainingMicrousd?: bigint;
}
export interface Assignment {
  taskId: bigint;
  workerId: bigint;
  durationTicks: number;
  costMicrousd: bigint;
  trayId?: bigint;
  score: number;
  reasonCodes: string[];
}
export interface PolicyConfig {
  policy: PolicyName;
  urgencyWeight: number;
  criticalityWeight: number;
  ageWeight: number;
  durationWeight: number;
  costWeight: number;
  priorityWeight: number;
  valueWeight: number;
  timeScaleTicks: number;
  costScaleMicrousd: number;
  maxAgeTicks: number;
  candidatesPerWorker: number;
  maxBranches: number;
}
export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  policy: 'sync_greedy',
  urgencyWeight: 2,
  criticalityWeight: 0.5,
  ageWeight: 1,
  durationWeight: 0.15,
  costWeight: 0.1,
  priorityWeight: 0.5,
  valueWeight: 0.5,
  timeScaleTicks: 30,
  costScaleMicrousd: 1000,
  maxAgeTicks: 300,
  candidatesPerWorker: 4,
  maxBranches: 2000,
};
const POLICY_NAMES: readonly PolicyName[] = [
  'fcfs',
  'earliest_finish',
  'minimum_slack',
  'critical_path',
  'sync_greedy',
  'bounded_joint',
  'primal_dual',
];
function nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite and nonnegative`);
  }
}
function whole(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
}
export function validatePolicyConfig(config: PolicyConfig): void {
  if (!POLICY_NAMES.includes(config.policy)) throw new Error('Unknown policy');
  for (const name of [
    'urgencyWeight',
    'criticalityWeight',
    'ageWeight',
    'durationWeight',
    'costWeight',
    'priorityWeight',
    'valueWeight',
  ] as const) {
    nonnegative(config[name], name);
    if (config[name] > 1000) throw new Error(`${name} exceeds supported limit`);
  }
  whole(config.timeScaleTicks, 'timeScaleTicks', 1);
  whole(config.costScaleMicrousd, 'costScaleMicrousd', 1);
  whole(config.maxAgeTicks, 'maxAgeTicks', 1);
  whole(config.candidatesPerWorker, 'candidatesPerWorker', 1);
  whole(config.maxBranches, 'maxBranches', 1);
  if (config.candidatesPerWorker > 32 || config.maxBranches > 100000) {
    throw new Error('Joint search exceeds supported deterministic bound');
  }
}
const compareId = (a: bigint, b: bigint): number =>
  a < b ? -1 : a > b ? 1 : 0;
const bounded = (value: number, scale: number): number =>
  Math.min(10, value / scale);
const squash = (value: number): number => value / (1 + value);
function uniqueIds(ids: bigint[], label: string): void {
  if (ids.some((id) => typeof id !== 'bigint' || id < 0n)) {
    throw new Error(`${label} IDs must be nonnegative bigint values`);
  }
  if (new Set(ids).size !== ids.length)
    throw new Error(`Duplicate ${label} ID`);
}
function validateSnapshot(snapshot: Snapshot): void {
  whole(snapshot.tick, 'tick');
  if (
    snapshot.budgetRemainingMicrousd !== undefined &&
    (typeof snapshot.budgetRemainingMicrousd !== 'bigint' ||
      snapshot.budgetRemainingMicrousd < 0n)
  ) {
    throw new Error('budgetRemainingMicrousd must be a nonnegative bigint');
  }
  uniqueIds(
    snapshot.tasks.map((task) => task.id),
    'task',
  );
  uniqueIds(
    snapshot.workers.map((worker) => worker.id),
    'worker',
  );
  uniqueIds(
    snapshot.resources.map((resource) => resource.id),
    'resource',
  );
  uniqueIds(snapshot.freeTrayIds, 'tray');
  for (const task of snapshot.tasks) {
    whole(task.releaseTick, 'releaseTick');
    if (task.deadlineTick !== undefined)
      whole(task.deadlineTick, 'deadlineTick');
    nonnegative(task.priority, 'priority');
    nonnegative(task.value, 'value');
    whole(task.remainingPathTicks, 'remainingPathTicks');
    if (!['none', 'acquire', 'release'].includes(task.trayMode)) {
      throw new Error('Invalid trayMode');
    }
    for (const requirement of task.requirements) {
      if (
        typeof requirement.resourceId !== 'bigint' ||
        requirement.resourceId < 0n
      ) {
        throw new Error('Resource requirement ID must be a nonnegative bigint');
      }
      whole(requirement.units, 'requirement units', 1);
    }
  }
  for (const resource of snapshot.resources)
    whole(resource.freeUnits, 'freeUnits');
  for (const worker of snapshot.workers) {
    uniqueIds(
      worker.estimates.map((estimate) => estimate.taskId),
      'estimate task',
    );
    for (const estimate of worker.estimates) {
      whole(estimate.durationTicks, 'durationTicks', 1);
      if (
        typeof estimate.costMicrousd !== 'bigint' ||
        estimate.costMicrousd < 0n
      ) {
        throw new Error('costMicrousd must be a nonnegative bigint');
      }
    }
  }
}
/** Aggregate repeated requirements rather than accidentally checking each in isolation. */
function requirementsOf(task: TaskCandidate): Map<bigint, number> {
  const units = new Map<bigint, number>();
  for (const requirement of task.requirements) {
    const sum = (units.get(requirement.resourceId) ?? 0) + requirement.units;
    whole(sum, 'aggregated requirement', 1);
    units.set(requirement.resourceId, sum);
  }
  return units;
}
interface Pair {
  task: TaskCandidate;
  worker: WorkerCandidate;
  durationTicks: number;
  costMicrousd: bigint;
  score: number;
  slack: number;
  criticality: number;
  requirements: Map<bigint, number>;
}
function candidatePairs(snapshot: Snapshot, config: PolicyConfig): Pair[] {
  const result: Pair[] = [];
  for (const task of snapshot.tasks) {
    if (task.releaseTick > snapshot.tick) continue;
    const requirements = requirementsOf(task);
    for (const worker of snapshot.workers) {
      if (
        !task.requiredCapabilities.every((cap) =>
          worker.capabilities.includes(cap),
        )
      )
        continue;
      const estimate = worker.estimates.find((item) => item.taskId === task.id);
      if (!estimate) continue;
      const criticality = estimate.durationTicks + task.remainingPathTicks;
      whole(criticality, 'duration plus remaining path', 1);
      const slack =
        task.deadlineTick === undefined
          ? Number.POSITIVE_INFINITY
          : task.deadlineTick - snapshot.tick - criticality;
      // Dimensionless terms: urgency [0,3], age [0,1], priority/value [0,1),
      // remaining-path/duration/cost [0,10]. No guarantee of starvation freedom.
      const urgency =
        task.deadlineTick === undefined
          ? 0
          : slack < 0
            ? 1 + Math.min(2, -slack / config.timeScaleTicks)
            : 1 / (1 + slack / config.timeScaleTicks);
      const age =
        Math.min(config.maxAgeTicks, snapshot.tick - task.releaseTick) /
        config.maxAgeTicks;
      const maxCost = BigInt(config.costScaleMicrousd) * 10n;
      const boundedCost =
        estimate.costMicrousd > maxCost ? maxCost : estimate.costMicrousd;
      const score =
        1 +
        config.urgencyWeight * urgency +
        config.criticalityWeight * bounded(criticality, config.timeScaleTicks) +
        config.ageWeight * age +
        config.priorityWeight * squash(task.priority) +
        config.valueWeight * squash(task.value) -
        config.durationWeight *
          bounded(estimate.durationTicks, config.timeScaleTicks) -
        config.costWeight * (Number(boundedCost) / config.costScaleMicrousd);
      result.push({
        task,
        worker,
        ...estimate,
        score,
        slack,
        criticality,
        requirements,
      });
    }
  }
  return result;
}
function pairOrder(policy: PolicyName, a: Pair, b: Pair): number {
  let comparison: number;
  if (policy === 'fcfs') {
    comparison =
      a.task.releaseTick - b.task.releaseTick ||
      compareId(a.task.id, b.task.id);
  } else if (policy === 'earliest_finish') {
    comparison = a.durationTicks - b.durationTicks;
  } else if (policy === 'minimum_slack') {
    // Infinity - Infinity is NaN; relational comparison preserves a total tie order.
    comparison = a.slack < b.slack ? -1 : a.slack > b.slack ? 1 : 0;
  } else if (policy === 'critical_path') {
    comparison = b.criticality - a.criticality;
  } else {
    comparison = b.score - a.score;
  }
  return (
    comparison ||
    a.durationTicks - b.durationTicks ||
    compareId(a.task.id, b.task.id) ||
    compareId(a.worker.id, b.worker.id)
  );
}
function fits(pair: Pair, free: Map<bigint, number>, trays: bigint[]): boolean {
  if (pair.task.trayMode === 'acquire' && trays.length === 0) return false;
  for (const [resourceId, units] of pair.requirements) {
    if ((free.get(resourceId) ?? 0) < units) return false;
  }
  return true;
}
function reserve(pair: Pair, free: Map<bigint, number>): Map<bigint, number> {
  const next = new Map(free);
  for (const [resourceId, units] of pair.requirements) {
    next.set(resourceId, next.get(resourceId)! - units);
  }
  return next;
}
function assignmentOf(
  pair: Pair,
  trays: bigint[],
  policy: PolicyName,
): Assignment {
  return {
    taskId: pair.task.id,
    workerId: pair.worker.id,
    durationTicks: pair.durationTicks,
    costMicrousd: pair.costMicrousd,
    ...(pair.task.trayMode === 'acquire' ? { trayId: trays[0]! } : {}),
    score: pair.score,
    reasonCodes: [
      policy,
      'eligible_frontier_supplied',
      'compatible_worker',
      'resource_capacity_available',
      ...(pair.task.trayMode === 'acquire' ? ['clean_tray_reserved'] : []),
    ],
  };
}
function greedy(
  snapshot: Snapshot,
  pairs: Pair[],
  policy: PolicyName,
): Assignment[] {
  let free = new Map(
    snapshot.resources.map((resource) => [resource.id, resource.freeUnits]),
  );
  let trays = snapshot.freeTrayIds.slice().sort(compareId);
  let budget = snapshot.budgetRemainingMicrousd;
  const taskIds = new Set<bigint>();
  const workerIds = new Set<bigint>();
  const selected: Assignment[] = [];
  for (const pair of pairs.slice().sort((a, b) => pairOrder(policy, a, b))) {
    if (
      taskIds.has(pair.task.id) ||
      workerIds.has(pair.worker.id) ||
      !fits(pair, free, trays)
    )
      continue;
    if (budget !== undefined && pair.costMicrousd > budget) continue;
    selected.push(assignmentOf(pair, trays, policy));
    taskIds.add(pair.task.id);
    workerIds.add(pair.worker.id);
    free = reserve(pair, free);
    if (budget !== undefined) budget -= pair.costMicrousd;
    if (pair.task.trayMode === 'acquire') trays = trays.slice(1);
  }
  return selected;
}
function joint(
  snapshot: Snapshot,
  pairs: Pair[],
  config: PolicyConfig,
): Assignment[] {
  const workers = snapshot.workers
    .slice()
    .sort((a, b) => compareId(a.id, b.id));
  if (workers.length > 64)
    throw new Error('bounded_joint supports at most 64 worker slots');
  const perWorker = workers.map((worker) =>
    pairs
      .filter((pair) => pair.worker.id === worker.id)
      .sort((a, b) => pairOrder('sync_greedy', a, b))
      .slice(0, config.candidatesPerWorker),
  );
  // Always retain a feasible deterministic incumbent, even if search is truncated.
  const incumbent = greedy(snapshot, pairs, 'sync_greedy');
  const incumbentScore = incumbent.reduce((sum, item) => sum + item.score, 0);
  let best = incumbentScore > 0 ? incumbent : [];
  let bestScore = Math.max(0, incumbentScore);
  let branches = 0;
  const visit = (
    index: number,
    used: Set<bigint>,
    free: Map<bigint, number>,
    trays: bigint[],
    budget: bigint | undefined,
    selected: Assignment[],
    score: number,
  ): void => {
    if (branches >= config.maxBranches) return;
    branches += 1;
    // Every prefix is feasible because all other workers may remain idle.
    if (score > bestScore) {
      bestScore = score;
      best = selected.slice();
    }
    if (index >= workers.length) return;
    for (const pair of perWorker[index]!) {
      if (used.has(pair.task.id) || !fits(pair, free, trays)) continue;
      if (budget !== undefined && pair.costMicrousd > budget) continue;
      const nextUsed = new Set(used);
      nextUsed.add(pair.task.id);
      visit(
        index + 1,
        nextUsed,
        reserve(pair, free),
        pair.task.trayMode === 'acquire' ? trays.slice(1) : trays,
        budget === undefined ? undefined : budget - pair.costMicrousd,
        [...selected, assignmentOf(pair, trays, 'bounded_joint')],
        score + pair.score,
      );
    }
    visit(index + 1, used, free, trays, budget, selected, score); // explicit idle option
  };
  visit(
    0,
    new Set(),
    new Map(
      snapshot.resources.map((resource) => [resource.id, resource.freeUnits]),
    ),
    snapshot.freeTrayIds.slice().sort(compareId),
    snapshot.budgetRemainingMicrousd,
    [],
    0,
  );
  return best.map((item) => ({
    ...item,
    reasonCodes: [
      ...item.reasonCodes.filter(
        (reason) => reason !== 'sync_greedy' && reason !== 'bounded_joint',
      ),
      'bounded_joint',
      'primal_dual',
      branches >= config.maxBranches
        ? 'search_budget_reached'
        : 'candidate_search_completed',
    ],
  }));
}
/**
 * Immediate dispatch only: no clairvoyant arrivals, speculative releases, or host time.
 * Missing worker estimates make that pair ineligible. Idle workers represent one slot each.
 * Joint search is optimal only within its shortlist when the deterministic budget permits.
 * Default search visits at most 2,000 prefix states. Seven slots with four candidates
 * each plus idle could otherwise create 5^7 leaf combinations (97,656 prefix states).
 */
export function plan(
  snapshot: Snapshot,
  options: Partial<PolicyConfig> = {},
): Assignment[] {
  const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, ...options };
  validatePolicyConfig(config);
  if (config.policy === 'primal_dual')
    throw new Error('Use RollingHorizonEngine for primal_dual');
  validateSnapshot(snapshot);
  const pairs = candidatePairs(snapshot, config);
  return config.policy === 'bounded_joint'
    ? joint(snapshot, pairs, config)
    : greedy(snapshot, pairs, config.policy);
}
