import { schema, table, t } from 'spacetimedb/server';
// All base tables are private. Public views perform identity-based filtering.
export const run = table(
  { name: 'sync_run', public: false },
  {
    id: t.u64().primaryKey().autoInc(),
    ownerIdentityHex: t.string().index('btree'),
    name: t.string(),
    seed: t.u32(),
    tick: t.u32(),
    status: t.string(),
    arrivalsClosed: t.bool(),
    mode: t.string(),
    version: t.u64(),
    nextId: t.u64(),
    eventSequence: t.u64(),
    policyJson: t.string(),
    maxOrders: t.u32(),
    budgetMicrousd: t.option(t.u64()),
    modeledSpentMicrousd: t.u64(),
    reservedMicrousd: t.u64(),
  },
);
export const members = table(
  { name: 'sync_members', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    identityHex: t.string().index('btree'),
    permission: t.string(),
    enabled: t.bool(),
  },
);

// One cart per customer checkout; a cart owns many orders (one order per menu item).
export const carts = table(
  { name: 'sync_carts', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    externalKey: t.string(),
    arrivalTick: t.u32(),
    status: t.string(),
  },
);
// One recipe row per order (1:1); `recipe` is the recipe kind used to materialize tasks.
export const recipes = table(
  { name: 'sync_recipes', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    recipe: t.string(),
    name: t.string(),
    description: t.string(),
  },
);
export const orders = table(
  { name: 'sync_orders', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    cartId: t.u64().index('btree'),
    externalKey: t.string(),
    recipeId: t.u64(),
    arrivalTick: t.u32(),
    deadlineTick: t.u32(),
    value: t.u32(),
    priority: t.u32(),
    customerUseTicks: t.u32(),
    status: t.string(),
    deliveredTick: t.option(t.u32()),
    customerReleaseTick: t.option(t.u32()),
    cleanupCompletedTick: t.option(t.u32()),
    trayId: t.option(t.u64()),
  },
);
export const tasks = table(
  { name: 'sync_tasks', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    cartId: t.u64().index('btree'),
    orderId: t.u64().index('btree'),
    kind: t.string(),
    role: t.string(),
    status: t.string(),
    releaseTick: t.u32(),
    deadlineTick: t.option(t.u32()),
    durationTicks: t.u32(),
    priority: t.u32(),
    value: t.u32(),
    requiredCapabilities: t.array(t.string()),
    estimatedCostMicrousd: t.u64(),
    attempt: t.u32(),
    workerId: t.option(t.u64()),
    startedTick: t.option(t.u32()),
    finishedTick: t.option(t.u32()),
    finishAtTick: t.option(t.u32()),
    customerReleaseGuard: t.bool(),
    trayMode: t.string(),
    errorCode: t.option(t.string()),
  },
);
export const dependencies = table(
  { name: 'sync_dependencies', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    orderId: t.u64().index('btree'),
    predecessorId: t.u64(),
    successorId: t.u64().index('btree'),
  },
);
export const workers = table(
  { name: 'sync_workers', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    label: t.string(),
    role: t.string(),
    capabilities: t.array(t.string()),
    enabled: t.bool(),
    speedFactor: t.f64(),
    currentTaskId: t.option(t.u64()),
    currentAttempt: t.option(t.u32()),
    x: t.f64(),
    y: t.f64(),
  },
);
export const resources = table(
  { name: 'sync_resources', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    label: t.string(),
    role: t.string(),
    capacity: t.u32(),
    available: t.bool(),
  },
);
export const requirements = table(
  { name: 'sync_requirements', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    taskId: t.u64().index('btree'),
    resourceId: t.u64(),
    units: t.u32(),
  },
);
export const reservations = table(
  { name: 'sync_reservations', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    taskId: t.u64().index('btree'),
    workerId: t.u64(),
    attempt: t.u32(),
    resourceId: t.u64().index('btree'),
    units: t.u32(),
  },
);
export const trays = table(
  { name: 'sync_trays', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    state: t.string(),
    orderId: t.option(t.u64()),
  },
);
export const jobs = table(
  { name: 'sync_jobs', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    taskId: t.u64().index('btree'),
    workerId: t.u64(),
    attempt: t.u32(),
    status: t.string(),
    claimantIdentityHex: t.option(t.string()),
    claimedTick: t.option(t.u32()),
    submittedTick: t.option(t.u32()),
    expectedAction: t.string(),
    observationJson: t.string(),
    reservedCostMicrousd: t.u64(),
  },
);
export const decisions = table(
  { name: 'sync_decisions', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    sequence: t.u64(),
    tick: t.u32(),
    policy: t.string(),
    taskId: t.u64(),
    workerId: t.u64(),
    attempt: t.u32(),
    score: t.f64(),
    reasonCodes: t.array(t.string()),
    snapshotVersion: t.u64(),
  },
);
export const events = table(
  { name: 'sync_events', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    sequence: t.u64(),
    tick: t.u32(),
    type: t.string(),
    taskId: t.option(t.u64()),
    cartId: t.option(t.u64()),
    orderId: t.option(t.u64()),
    workerId: t.option(t.u64()),
    attempt: t.option(t.u32()),
    detail: t.string(),
  },
);
export const telemetry = table(
  { name: 'sync_telemetry', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    externalKey: t.string(),
    taskId: t.option(t.u64()),
    attempt: t.option(t.u32()),
    source: t.string(),
    inputTokens: t.u64(),
    outputTokens: t.u64(),
    reportedCostMicrousd: t.u64(),
    wallMilliseconds: t.f64(),
    reporterIdentityHex: t.string(),
  },
);
export const clock = table(
  { name: 'sync_clock', public: false },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    runId: t.u64().unique(),
  },
);
export const planner = table(
  { name: 'sync_planner', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    fingerprint: t.string(),
    lastPlanTick: t.u32(),
    nextWakeTick: t.u32(),
    replanCount: t.u64(),
    snapshotVersion: t.u64(),
    trigger: t.string(),
    objective: t.f64(),
    candidateCount: t.u32(),
    candidateLimitReached: t.bool(),
    pricesJson: t.string(),
    planJson: t.string(),
  },
);
export const taskItems = table(
  { name: 'sync_task_items', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    taskId: t.u64().index('btree'),
    orderId: t.u64().index('btree'),
  },
);
export const utensils = table(
  { name: 'sync_utensils', public: false },
  {
    key: t.string().primaryKey(),
    id: t.u64(),
    runId: t.u64().index('btree'),
    kind: t.string(),
    state: t.string(),
    taskId: t.option(t.u64()),
  },
);
export const db = schema({
  taskItems,
  utensils,
  planner,
  run,
  members,
  carts,
  recipes,
  orders,
  tasks,
  dependencies,
  workers,
  resources,
  requirements,
  reservations,
  trays,
  jobs,
  decisions,
  events,
  telemetry,
  clock,
});
export default db;
