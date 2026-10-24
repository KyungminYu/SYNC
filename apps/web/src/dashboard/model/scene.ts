/**
 * Scene model: turns delivered rows into what the floor shows at time t.
 * Pure function of (run data, t), so scrubbing, rewinding and speed changes
 * are always exact. No React, no Phaser, no scoring or scheduling logic.
 */
import type {
  Layout,
  ResourceType,
  Role,
  RunData,
  SyncEvent,
  Zone,
} from '../../sync/contract';
import {
  buildLanes,
  pathLength,
  pointAt,
  subPath,
  viaRow,
  type Lanes,
  type Point,
  type WaitingSpot,
} from './lanes';

/** What the floor draws at one instant. Positions are grid units. */
/** One slot as drawn: idle, busy (with progress) or claimed (shown "Reserved"). */
export interface SlotView {
  id: string;
  label: string;
  type: ResourceType;
  x: number;
  y: number;
  state: 'idle' | 'busy' | 'claimed';
  /** 0–1 while busy; null when the end time is not known yet. */
  progress: number | null;
  /** Sub line while busy, e.g. "c26 · make" (order id · kind of work). */
  taskLabel?: string;
}
/** Customer looks: 10 guest kinds, rows a–j of guests.png. */
export const GUEST_KINDS = [
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
] as const;
export type GuestKind = (typeof GUEST_KINDS)[number];

/**
 * Picks a guest kind for a customer with a seeded random draw: the same run
 * seed and customer id always give the same kind, a different seed reshuffles.
 */
export function guestKind(seed: number, customerId: string): GuestKind {
  // Hash seed + id into 32 bits, then one mulberry32 step for a uniform draw.
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const ch of customerId)
    h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  h = (h + 0x6d2b79f5) >>> 0;
  let r = Math.imul(h ^ (h >>> 15), h | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  const u = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  return GUEST_KINDS[Math.floor(u * GUEST_KINDS.length)];
}

/** Which way a person faces; picks the sprite direction. */
export type Facing = 'left' | 'down' | 'up' | 'right';

/** One staff member as drawn. `helping` = working outside the primary role. */
export interface AgentView {
  id: string;
  name: string;
  role: Role;
  x: number;
  y: number;
  state: 'idle' | 'moving' | 'waiting' | 'working';
  helping: boolean;
  /** 0–1 progress of the task being worked on; null otherwise. */
  progress: number | null;
  /** Walking direction, or the way they face while standing. */
  facing: Facing;
}
/** Where a customer is in the flow: line → ordering → waiting → ready → leaving. */
export type CustomerStage =
  'line' | 'ordering' | 'waiting' | 'ready' | 'leaving';
/** One customer token as drawn. `late` = past their deadline (provisional rule). */
export interface CustomerView {
  id: string;
  label: string;
  stage: CustomerStage;
  late: boolean;
  x: number;
  y: number;
  /** True while walking between places; drawn above standing customers. */
  walking: boolean;
  /** Walking direction, or the way they face while standing. */
  facing: Facing;
  /** Which of the 10 guest looks (a–j) this customer has. */
  guest: GuestKind;
}
/** Full floor state at one instant; also feeds the shop card's Done / Late. */
export interface Scene {
  t: number;
  zones: Zone[];
  /** Lane geometry, for drawing the floor guides, wall, doors and spots. */
  lanes: Lanes;
  /** True while the order line is long enough to use the bottom row (rope shown). */
  queueFolded: boolean;
  /** People in the order line now (decides which ropes are shown). */
  lineLength: number;
  slots: SlotView[];
  agents: AgentView[];
  customers: CustomerView[];
  done: number;
  late: number;
}

/** Short word for each kind of work, shown under a busy slot. */
const WORK: Record<ResourceType, string> = {
  register: 'order',
  bar: 'make',
  pickup: 'hand-off',
  clean: 'clean',
};

/** Customer walking speed, grid units per second. */
const CUSTOMER_SPEED = 3.5;

/** Where a walk along `route` that started at `start` is at time t. */
function walkAt(route: Point[], start: number, t: number) {
  const len = pathLength(route);
  const d = Math.max(0, (t - start) * CUSTOMER_SPEED);
  return {
    ...pointAt(route, Math.min(d, len)),
    walking: d < len,
    done: d >= len,
  };
}

/**
 * Replays events up to t. The only computation the dashboard does: it never
 * scores or decides, it only turns delivered rows into positions and states.
 * Expects events from normalizeRun (time ordered).
 */
export function sceneAt(
  data: RunData,
  t: number,
  lanes: Lanes = buildLanes(data.layout, peakWaiting(data), peakLine(data)),
  /** Internal: false when computing the previous instant for facing. */
  withFacing = true,
): Scene {
  const { layout } = data;
  const resources = new Map(layout.resources.map((r) => [r.id, r]));
  const taskType = new Map(data.tasks.map((task) => [task.id, task.type]));
  const registerTasks = registerCounts(data);
  // Known finish times, for progress bars when task.started carries no duration.
  const finishedAt = new Map<string, number>();
  for (const e of data.events)
    if (e.type === 'task.finished' && e.taskId) finishedAt.set(e.taskId, e.t);

  // Mutable replay state, rebuilt from scratch on every call.
  const slots = new Map(
    layout.resources.map((r) => [
      r.id,
      { busy: undefined as SyncEvent | undefined, claimed: false },
    ]),
  );
  const agents = new Map(
    layout.agents.map((a) => [
      a.id,
      {
        move: undefined as SyncEvent | undefined,
        task: undefined as string | undefined,
        working: false,
        waiting: false,
      },
    ]),
  );
  /** Per customer: when each step of their visit happened (only steps up to t). */
  const customers = new Map<
    string,
    {
      arrived: number;
      /**
       * When they step through the door. Customers who arrive together come
       * in one after another (one queue spacing apart), never as a clump.
       */
      entered?: number;
      stage: CustomerStage;
      orderStart?: number;
      register?: string;
      /** Register tasks finished so far (a live cart has one pair per drink). */
      registersDone?: number;
      orderEnd?: number;
      spot?: number;
      handoffStart?: number;
      pickup?: string;
      completed?: number;
      onTime?: boolean;
    }
  >();
  // Pickup waiting spots: index → customer holding it. Assigned in event order,
  // so a customer keeps the same spot until called (orders finish out of order).
  const spotHolder: (string | undefined)[] = lanes.waitingSpots.map(
    () => undefined,
  );
  const preparationOnly = new Set(
    data.tasks.filter((t) => t.customerHandoff === false).map((t) => t.id),
  );
  const jobOf = (e: SyncEvent) =>
    e.jobId ?? (e.taskId ? e.taskId.split('.')[0] : undefined);

  // Replay every event up to t (events are time ordered, so stop at the first later one).
  for (const e of data.events) {
    if (e.t > t) break;
    const agent = e.agentId ? agents.get(e.agentId) : undefined;
    const slot = e.resourceId ? slots.get(e.resourceId) : undefined;
    const type = e.taskId ? taskType.get(e.taskId) : undefined;
    const customer = customers.get(jobOf(e) ?? '');
    switch (e.type) {
      // Customer enters and joins the line.
      case 'job.arrived':
        customers.set(e.jobId!, { arrived: e.t, stage: 'line' });
        break;
      case 'task.assigned':
        if (agent) agent.task = e.taskId;
        break;
      case 'agent.move':
        if (agent) agent.move = e;
        break;
      // Agent reached its slot but the task's dependencies are not done yet.
      case 'agent.wait':
        if (agent) agent.waiting = true;
        break;
      // Work begins. Taking the order puts the customer at a register;
      // the hand off puts them at a pickup counter.
      case 'task.started':
        if (agent)
          Object.assign(agent, {
            working: true,
            waiting: false,
            task: e.taskId,
          });
        if (slot) slot.busy = e;
        // Only the first register task moves the customer; later ones (more
        // drinks, payment) keep them at the register they walked to.
        if (customer && type === 'register' && customer.stage === 'line')
          Object.assign(customer, {
            stage: 'ordering',
            orderStart: e.t,
            register: e.resourceId,
          });
        // Only the first hand-off task calls the customer to pickup.
        if (
          customer &&
          type === 'pickup' &&
          !preparationOnly.has(e.taskId!) &&
          customer.stage !== 'ready' &&
          customer.stage !== 'leaving'
        ) {
          // Called: leave the waiting spot (free it for the next arrival).
          if (customer.spot !== undefined)
            spotHolder[customer.spot] = undefined;
          Object.assign(customer, {
            stage: 'ready',
            handoffStart: e.t,
            pickup: e.resourceId,
          });
        }
        break;
      // Work ends. After ordering, the customer moves to the waiting area.
      case 'task.finished':
        if (agent) Object.assign(agent, { working: false, task: undefined });
        if (slot) slot.busy = undefined;
        if (customer && type === 'register')
          customer.registersDone = (customer.registersDone ?? 0) + 1;
        if (
          customer &&
          type === 'register' &&
          customer.stage === 'ordering' &&
          customer.registersDone! >= (registerTasks.get(jobOf(e)!) ?? 1)
        ) {
          // Ordered (last register task done): take the nearest free waiting spot and keep it.
          const free = spotHolder.findIndex((h) => h === undefined);
          if (free >= 0) spotHolder[free] = jobOf(e);
          Object.assign(customer, {
            stage: 'waiting',
            orderEnd: e.t,
            spot: free >= 0 ? free : undefined,
          });
        }
        break;
      // A lease without running work shows the slot as "Reserved".
      case 'lease.claimed':
        if (slot) slot.claimed = true;
        break;
      case 'lease.released':
        if (slot) slot.claimed = false;
        break;
      // Drinks handed over: the customer leaves (on time or late).
      case 'job.completed':
        if (customer)
          Object.assign(customer, {
            stage: 'leaving',
            completed: e.t,
            onTime: e.data?.onTime,
          });
        break;
    }
  }

  // Slots: busy beats claimed; progress = elapsed / expected duration.
  const slotViews: SlotView[] = layout.resources.map((r) => {
    const s = slots.get(r.id)!;
    let progress: number | null = null;
    if (s.busy) {
      const end =
        s.busy.data?.duration !== undefined
          ? s.busy.t + s.busy.data.duration
          : finishedAt.get(s.busy.taskId!);
      if (end !== undefined && end > s.busy.t)
        progress = Math.min(1, (t - s.busy.t) / (end - s.busy.t));
    }
    return {
      id: r.id,
      label: r.label,
      type: r.type,
      x: r.x,
      y: r.y,
      state: s.busy ? 'busy' : s.claimed ? 'claimed' : 'idle',
      progress,
      taskLabel: s.busy?.taskId
        ? `${s.busy.taskId.split('.')[0]} · ${WORK[r.type]}`
        : undefined,
    };
  });

  // Staff: walk along the staff aisle (vertical, horizontal, vertical) over the
  // move's eta; state priority working > waiting > moving > idle.
  const agentViews: AgentView[] = layout.agents
    .filter((a) => a.enabled !== false || agents.get(a.id)?.working)
    .map((a) => {
      const s = agents.get(a.id)!;
      let pos: Point = { x: a.startX, y: a.startY };
      let moving = false;
      const m = s.move?.data;
      if (s.move && m) {
        const from = { x: m.fromX ?? a.startX, y: m.fromY ?? a.startY };
        const route = viaRow(from, { x: m.toX!, y: m.toY! }, lanes.staffAisleY);
        const k = m.eta ? Math.min(1, Math.max(0, (t - s.move.t) / m.eta)) : 1;
        pos = pointAt(route, k * pathLength(route));
        moving = k < 1;
      }
      const type = s.task ? taskType.get(s.task) : undefined;
      const slot = slotViews.find(
        (v) => v.state === 'busy' && slots.get(v.id)!.busy?.agentId === a.id,
      );
      // Fixed (Baseline) staff work from their own spot; the slot shows progress.
      if (s.working && slot && !a.fixed) {
        const location = resources.get(slot.id);
        if (location)
          pos = {
            x: location.standX ?? location.x,
            y: location.standY ?? location.y,
          };
      }
      return {
        id: a.id,
        name: a.name,
        role: a.role,
        ...pos,
        state: s.working
          ? 'working'
          : s.waiting
            ? 'waiting'
            : moving
              ? 'moving'
              : 'idle',
        helping: type !== undefined && !a.primaryTypes.includes(type),
        progress: s.working ? (slot?.progress ?? null) : null,
        facing: 'down' as Facing,
      };
    });
  // One person per slot: an idle person whose slot is taken waits aside.
  clearSlots(agentViews, layout, lanes);

  const jobs = new Map(data.jobs.map((j) => [j.id, j]));
  const counterAt = (id?: string): Point => ({
    x: resources.get(id ?? '')?.x ?? lanes.headX,
    y: lanes.standY,
  });
  const path = lanes.queuePath;
  const queueLen = pathLength(path);
  const stepTime = lanes.spacing / CUSTOMER_SPEED;
  // Customers in arrival order: the order line is first come, first served.
  const order = [...customers.entries()].sort(
    (a, b) => a[1].arrived - b[1].arrived,
  );
  // Single file through the door: each customer enters at least one step
  // after the one before (a group that arrives at once files in).
  let lastEntered = -Infinity;
  for (const [, c] of order) {
    c.entered = Math.max(c.arrived, lastEntered + stepTime);
    lastEntered = c.entered;
  }

  /**
   * Place in line (0 = head) at time tau, theme-park shuffle: the place taken
   * on arrival, minus one spot — walked over stepTime — for everyone ahead who
   * has left the line since.
   */
  const placeAt = (index: number, tau: number) => {
    const c = order[index][1];
    const ahead = order.slice(0, index).map(([, d]) => d);
    let place = ahead.filter(
      (d) => (d.orderStart ?? Infinity) > c.entered!,
    ).length;
    const joined = place;
    for (const d of ahead) {
      const left = d.orderStart ?? Infinity;
      if (left > c.entered! && left <= tau)
        place -= Math.min(1, (tau - left) / stepTime);
    }
    return { place, joined };
  };

  /**
   * Where a customer in line is at time tau. Newcomers never squeeze past
   * anyone: with a short line they walk the empty bottom lane to just behind
   * the tail and step up; with a long line the tail is at the door, so they
   * walk in from the door end. Then they follow the shuffle along the lane.
   */
  const linePosition = (index: number, tau: number) => {
    const c = order[index][1];
    const { place, joined } = placeAt(index, tau);
    const dJoin = Math.min(queueLen, joined * lanes.spacing);
    const spot = pointAt(path, dJoin);
    const entry =
      dJoin <= lanes.topRowLength
        ? [
            lanes.door,
            { x: lanes.door.x, y: lanes.bottomRowY },
            { x: spot.x, y: lanes.bottomRowY },
            spot,
          ]
        : [lanes.door, ...subPath(path, queueLen, dJoin)];
    const entryLen = pathLength(entry);
    const walked = Math.max(0, tau - c.entered!) * CUSTOMER_SPEED;
    if (walked < entryLen)
      return {
        ...pointAt(entry, walked),
        d: undefined as number | undefined,
        rest: subPath(entry, walked, entryLen),
        dJoin,
      };
    const reached = c.entered! + entryLen / CUSTOMER_SPEED;
    const target = Math.min(queueLen, place * lanes.spacing);
    const d = Math.max(target, dJoin - (tau - reached) * CUSTOMER_SPEED);
    return { ...pointAt(path, d), d, rest: [] as Point[], dJoin };
  };

  // Routes between a register, a waiting spot and a pickup counter. Front-row
  // spots step straight onto the counter lane; other rows use their aisle.
  const toSpot = (from: Point, spot: WaitingSpot): Point[] =>
    spot.aisleY === undefined
      ? [
          from,
          { x: from.x, y: lanes.counterY },
          { x: spot.x, y: lanes.counterY },
          spot,
        ]
      : [
          from,
          { x: from.x, y: lanes.counterY },
          { x: lanes.spurX, y: lanes.counterY },
          { x: lanes.spurX, y: spot.aisleY },
          { x: spot.x, y: spot.aisleY },
          spot,
        ];
  const fromSpot = (spot: WaitingSpot, to: Point): Point[] =>
    [...toSpot(to, spot)].reverse();

  // Customers leaving a spot that shares an aisle go one at a time.
  const aisleFreeAt = new Map<number, number>();
  const aisleStart = new Map<string, number>();
  for (const [id, c] of [...order].sort(
    (a, b) => (a[1].handoffStart ?? Infinity) - (b[1].handoffStart ?? Infinity),
  )) {
    if (c.handoffStart === undefined || c.spot === undefined) continue;
    const spot = lanes.waitingSpots[c.spot];
    if (spot.aisleY === undefined) continue;
    const start = Math.max(
      c.handoffStart,
      aisleFreeAt.get(spot.aisleY) ?? -Infinity,
    );
    aisleStart.set(id, start);
    aisleFreeAt.set(
      spot.aisleY,
      start + (Math.abs(spot.x - lanes.spurX) + 0.6) / CUSTOMER_SPEED,
    );
  }

  // Customers ordering now, per register, in the order they stepped up.
  const orderingAt = new Map<string, string[]>();
  for (const [id, c] of [...customers.entries()].sort(
    (a, b) => (a[1].orderStart ?? 0) - (b[1].orderStart ?? 0),
  ))
    if (c.stage === 'ordering' && c.register)
      orderingAt.set(c.register, [...(orderingAt.get(c.register) ?? []), id]);

  let done = 0,
    late = 0,
    inLine = 0;
  const customerViews: CustomerView[] = [];
  order.forEach(([id, c], index) => {
    const job = jobs.get(id);
    const deadline = job?.deadline ?? Infinity;
    // Late: served after the deadline, or still in the shop past it.
    const isLate =
      c.completed !== undefined ? c.onTime === false : t > deadline;
    if (c.completed !== undefined) done++;
    if (isLate) late++;
    const spot = c.spot !== undefined ? lanes.waitingSpots[c.spot] : undefined;
    let p: { x: number; y: number; walking: boolean };
    // Still outside, waiting for the one ahead to step in: not drawn
    // (customers never stand stacked on the doorway). This holds even when a
    // free register calls them straight away (group arrivals, two cashiers).
    if ((c.stage === 'line' || c.stage === 'ordering') && t < c.entered!)
      return;
    if (c.stage === 'line') {
      // Standing in (or walking into) the line.
      inLine++;
      const now = linePosition(index, t);
      const before = linePosition(index, t - 0.05);
      p = {
        x: now.x,
        y: now.y,
        walking: Math.abs(now.x - before.x) + Math.abs(now.y - before.y) > 1e-6,
      };
    } else if (c.stage === 'ordering') {
      // From the place in line forward to the head, up to the counter lane, to the register.
      const at = linePosition(index, c.orderStart!);
      // Several customers ordering at one register (the cashier alternates
      // between their drinks) stand side by side: 0, −0.8, +0.8, −1.6 …
      const rank = (orderingAt.get(c.register ?? '') ?? []).indexOf(id);
      const shift =
        rank <= 0 ? 0 : (rank % 2 ? -1 : 1) * Math.ceil(rank / 2) * 0.8;
      const base = counterAt(c.register);
      const reg = { ...base, x: base.x + shift };
      const toHead =
        at.d !== undefined
          ? subPath(path, at.d, 0)
          : [...at.rest, ...subPath(path, at.dJoin, 0)];
      const route = [
        ...toHead,
        { x: lanes.headX, y: lanes.counterY },
        { x: reg.x, y: lanes.counterY },
        reg,
      ];
      // Called at once by a free register: the walk starts when they step in.
      p = walkAt(route, Math.max(c.orderStart!, c.entered!), t);
    } else if (c.stage === 'waiting') {
      // From the register to the assigned spot, then stay there.
      const reg = counterAt(c.register);
      const route = spot
        ? toSpot(reg, spot)
        : [
            reg,
            { x: reg.x, y: lanes.counterY },
            { x: lanes.spurX, y: lanes.counterY },
          ];
      p = walkAt(route, c.orderEnd!, t);
    } else if (c.stage === 'ready') {
      // Called: leave the spot (waiting for a busy aisle) and go to pickup.
      const to = counterAt(c.pickup);
      const route = spot ? fromSpot(spot, to) : [counterAt(c.register), to];
      p = walkAt(route, aisleStart.get(id) ?? c.handoffStart!, t);
    } else {
      // Served: counter lane to the exit lane, then out through the door.
      const pick = counterAt(c.pickup);
      const route = [
        pick,
        { x: pick.x, y: lanes.counterY },
        { x: lanes.exitX, y: lanes.counterY },
        { x: lanes.exitX, y: lanes.wallY },
      ];
      const w = walkAt(route, c.completed!, t);
      if (w.done) return;
      p = w;
    }
    customerViews.push({
      id,
      label: job?.label ?? id,
      stage: c.stage,
      late: isLate,
      x: p.x,
      y: p.y,
      walking: p.walking,
      facing: 'up' as Facing,
      guest: guestKind(data.run.seed, id),
    });
  });

  if (withFacing)
    applyFacing(
      agentViews,
      customerViews,
      sceneAt(data, t - 0.12, lanes, false),
      lanes,
    );

  return {
    t,
    zones: layout.zones,
    lanes,
    queueFolded: inLine > lanes.foldAfter,
    lineLength: inLine,
    slots: slotViews,
    agents: agentViews,
    customers: customerViews,
    done,
    late,
  };
}

/** Gap between people waiting at the staff spot (grid units). */
export const STAFF_SPOT_GAP = 0.75;

/**
 * One person per slot (Figma "Staff rules v2"): when people stand on the same
 * spot (a helper working a colleague's slot), the one working keeps it and
 * the others walk to the staff spot in the aisle — between the bar row's last
 * slot and the first pickup — away from every slot. Fixed (Baseline) staff
 * never move. Mutates the views in place; positions only.
 */
export function clearSlots(views: AgentView[], layout: Layout, lanes: Lanes) {
  const bars = layout.resources.filter((r) => r.type === 'bar').map((r) => r.x);
  const pickups = layout.resources
    .filter((r) => r.type === 'pickup')
    .map((r) => r.x);
  const spotX =
    bars.length && pickups.length
      ? (Math.max(...bars) + Math.min(...pickups)) / 2
      : (lanes.headX + lanes.exitX) / 2;
  const fixed = new Set(layout.agents.filter((a) => a.fixed).map((a) => a.id));
  // Same spot = same position to 1/100 of a tile (walkers mid-route never match).
  const spots = new Map<string, AgentView[]>();
  for (const v of views) {
    const key = `${v.x.toFixed(2)},${v.y.toFixed(2)}`;
    spots.set(key, [...(spots.get(key) ?? []), v]);
  }
  let waiting = 0;
  for (const group of spots.values()) {
    if (group.length < 2) continue;
    // Working first, then fixed staff (never move), then layout order.
    const rank = (v: AgentView) =>
      (v.state === 'working' ? 2 : 0) + (fixed.has(v.id) ? 1 : 0);
    const ordered = [...group].sort((a, b) => rank(b) - rank(a));
    for (const v of ordered.slice(1)) {
      if (fixed.has(v.id)) continue;
      // Side by side at the staff spot: centre, then right, left, …
      const k = waiting++;
      const offset = Math.ceil(k / 2) * (k % 2 ? 1 : -1) * STAFF_SPOT_GAP;
      v.x = spotX + offset;
      v.y = lanes.staffAisleY;
    }
  }
}

/**
 * The shop with nobody in it: every slot idle, no staff, no customers, no
 * ropes. Drawn when there is no run yet, so the floor keeps its layout
 * instead of disappearing (Figma "SYNC Dashboard · Empty (no scenario)").
 */
export function emptyScene(layout: Layout, lanes: Lanes): Scene {
  return {
    t: 0,
    zones: layout.zones,
    lanes,
    queueFolded: false,
    lineLength: 0,
    slots: layout.resources.map((r) => ({
      id: r.id,
      label: r.label,
      type: r.type,
      x: r.x,
      y: r.y,
      state: 'idle',
      progress: null,
    })),
    agents: [],
    customers: [],
    done: 0,
    late: 0,
  };
}

/**
 * Most customers waiting for pickup at the same time in the delivered rows
 * (order taken, hand off not started). Sizes the waiting area: >10 adds a
 * sixth column, >12 adds rows and a taller board.
 */
/** Most people in the order line at once in the delivered rows (sizes the queue rows). */
export function peakLine(data: RunData) {
  // In line from arrival until the first register task starts.
  const type = new Map(data.tasks.map((task) => [task.id, task.type]));
  const changes: Array<[number, number]> = [];
  const started = new Set<string>();
  for (const e of data.events) {
    if (e.type === 'job.arrived' && e.jobId) changes.push([e.t, 1]);
    const job = e.taskId?.split('.')[0];
    if (
      e.type === 'task.started' &&
      job &&
      type.get(e.taskId!) === 'register' &&
      !started.has(job)
    ) {
      started.add(job);
      changes.push([e.t, -1]);
    }
  }
  let now = 0,
    peak = 0;
  for (const [, d] of changes.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    now += d;
    peak = Math.max(peak, now);
  }
  return peak;
}

export function peakWaiting(data: RunData) {
  let now = 0,
    peak = 0;
  const task = new Map(data.tasks.map((t) => [t.id, t]));
  const registerTasks = registerCounts(data);
  // Per customer: register tasks finished, and whether they are waiting / called.
  const done = new Map<string, number>();
  const state = new Map<string, 'waiting' | 'called'>();
  for (const e of data.events) {
    const t = e.taskId ? task.get(e.taskId) : undefined;
    if (!t) continue;
    if (e.type === 'task.finished' && t.type === 'register') {
      const n = (done.get(t.jobId) ?? 0) + 1;
      done.set(t.jobId, n);
      if (n === (registerTasks.get(t.jobId) ?? 1) && !state.has(t.jobId)) {
        state.set(t.jobId, 'waiting');
        now++;
      }
    }
    if (
      e.type === 'task.started' &&
      t.type === 'pickup' &&
      t.customerHandoff !== false
    ) {
      if (state.get(t.jobId) === 'waiting') now--;
      state.set(t.jobId, 'called');
    }
    peak = Math.max(peak, now);
  }
  return peak;
}

/** Direction of travel between two positions, or null when standing still. */
function travelDirection(from: Point, to: Point): Facing | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) + Math.abs(dy) < 1e-4) return null;
  return Math.abs(dx) >= Math.abs(dy)
    ? dx < 0
      ? 'left'
      : 'right'
    : dy < 0
      ? 'up'
      : 'down';
}

/**
 * Sets each person's facing: the way they moved since a moment ago, or a
 * sensible standing direction — staff face their workstation (machines at the
 * back, customers at the counter), people in line face the head of the line,
 * everyone else faces the counters, and leaving customers face the door.
 */
function applyFacing(
  agents: AgentView[],
  customers: CustomerView[],
  prev: Scene,
  lanes: Lanes,
) {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  for (const a of agents) {
    const before = prev.agents.find((p) => p.id === a.id);
    a.facing =
      (before && travelDirection(before, a)) ??
      (a.y < lanes.staffAisleY ? 'up' : 'down');
  }
  for (const c of customers) {
    const before = prev.customers.find((p) => p.id === c.id);
    const moved = before && travelDirection(before, c);
    if (moved) c.facing = moved;
    else if (c.stage === 'leaving') c.facing = 'down';
    else if (c.stage === 'line') {
      // Rows alternate direction; everyone faces toward the head of the line.
      const row = lanes.queueRowsY.findIndex((y) => near(c.y, y));
      c.facing = row < 0 ? 'up' : row % 2 === 0 ? 'left' : 'right';
    } else c.facing = 'up';
  }
}

/** Register tasks per customer (1 in the mock; capture + payment per drink live). */
function registerCounts(data: RunData) {
  const counts = new Map<string, number>();
  for (const t of data.tasks)
    if (t.type === 'register')
      counts.set(t.jobId, (counts.get(t.jobId) ?? 0) + 1);
  return counts;
}
