import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { DbConnection } from '../../packages/bindings/src';

/**
 * LLM planner for the SYNC run: tunes the planner's objective weights.
 *
 * The engine's primal_dual policy makes every assignment. Every few ticks
 * the feeder asks Claude to set its planning weights β (lateness), γ
 * (execution cost) and δ (coordination cost), given the run so far and the
 * penalty each earlier choice was followed by. The run is judged by the
 * engine's fixed reward weights (ui_metrics.penalty), so the LLM searches
 * for planning weights that keep that penalty low; it cannot change the
 * score itself. δ also sets how long until the next request (a higher
 * coordination cost means fewer calls). Requests never block the tick.
 *
 * Each answered request is reported through `report_usage` (source
 * "coordinator"), so the dashboard shows it as planning time.
 */

/** Small, fast model; a run makes about 6–18 short requests. */
const MODEL = 'claude-haiku-5-5';
/** Claude Haiku 5.5 list prices in micro-USD per token (input / output). */
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;
/** Ticks between requests: 10 at δ = 0, up to 30 at δ = 2. */
const BASE_INTERVAL = 10;
/** Allowed weight ranges (also stated in the prompt). */
const RANGE = { beta: [0, 2], gamma: [0, 1], delta: [0, 2] } as const;

const SYSTEM = `You tune the planning weights of a coffee-shop scheduler (a primal-dual planner) during a live simulation.
The planner scores each possible task start as: value + age bonus + beta * (ticks the customer would be late, up to 30) - gamma * (modeled execution cost) and plans with an effort that falls as delta rises.
- beta in [0, 2]: how strongly to avoid late customers (default 0.1).
- gamma in [0, 1]: how strongly to save execution cost; higher also adds a second worker per role less eagerly (default 0).
- delta in [0, 2]: coordination cost; higher means cheaper, coarser planning and fewer calls to you (next call in 10 + 10 * delta ticks) (default 0).
The run is judged by a fixed penalty you cannot change: lateness ticks, waiting ticks, execution dollars and active worker ticks (lower is better), plus completed orders (higher is better).
You get the current state and the history of your earlier weights with the penalty change that followed each. Choose weights for the next window that lower the penalty growth. Change weights in modest steps unless the history clearly shows a better region.
Answer only with the requested JSON; "reason" is one short sentence.`;

const Answer = z.object({
  beta: z.number(),
  gamma: z.number(),
  delta: z.number(),
  reason: z.string(),
});
type Weights = { beta: number; gamma: number; delta: number };

/** One window of the run: the weights in force and what followed. */
interface Window {
  from: number;
  to?: number;
  weights: Weights;
  penaltyAtStart: number;
  rewardAtStart: number;
}

export interface LlmPlannerOptions {
  /** Feeder connection (run owner): sets the policy weights. */
  conn: DbConnection;
  /** SYNC run whose planner is tuned. */
  runId: bigint;
  /** Reports one answered request (planning time, tokens, cost). */
  report?(usage: {
    key: string;
    ms: number;
    inputTokens: number;
    outputTokens: number;
    costMicrousd: number;
  }): Promise<void>;
  log(line: string): void;
}

const clamp = (n: number, [lo, hi]: readonly [number, number]) =>
  Number.isFinite(n)
    ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100))
    : lo;

export class LlmPlanner {
  private readonly client = new Anthropic();
  private busy = false;
  private nextTick = 0;
  private requests = 0;
  private weights: Weights = { beta: 0.1, gamma: 0, delta: 0 };
  private readonly history: Window[] = [];

  constructor(private readonly o: LlmPlannerOptions) {}

  /** Called before each step; starts a request when one is due, never waits for it. */
  beforeStep(tick: number) {
    if (this.busy || tick < this.nextTick) return;
    const metrics = this.metrics();
    // Nothing to plan before the first customer arrives.
    if (!metrics || metrics.ordersReceived === 0) return;
    this.busy = true;
    void this.ask(tick, metrics)
      .catch((error: unknown) =>
        this.o.log(
          `llm planner: request failed (${error instanceof Error ? error.message : 'unknown error'})`,
        ),
      )
      .finally(() => {
        this.busy = false;
      });
  }

  private metrics() {
    return [...this.o.conn.db.uiMetrics.iter()].find(
      (m) => m.runId === this.o.runId,
    );
  }

  private async ask(
    tick: number,
    m: NonNullable<ReturnType<LlmPlanner['metrics']>>,
  ) {
    const started = performance.now();
    // Close the current window with the penalty change it was followed by.
    const open = this.history.at(-1);
    if (open && open.to === undefined) open.to = tick;
    const db = this.o.conn.db;
    const tasks = [...db.uiTasks.iter()].filter(
      (t) => t.runId === this.o.runId,
    );
    const waiting = tasks.filter(
      (t) => t.status === 'ready' || t.status === 'blocked',
    );
    const atRisk = new Set(
      waiting
        .filter((t) => (t.estimatedSlackTicks ?? 1n) < 0n)
        .map((t) => String(t.orderId)),
    ).size;
    const byRole = new Map<string, number>();
    for (const t of waiting.filter((t) => t.status === 'ready'))
      byRole.set(t.role, (byRole.get(t.role) ?? 0) + 1);
    const lines = [
      `tick ${tick}`,
      `current weights: beta ${this.weights.beta}, gamma ${this.weights.gamma}, delta ${this.weights.delta}`,
      `orders: received ${m.ordersReceived}, delivered ${m.deliveredOrders}, on time ${m.onTimeOrders}, late and still open ${m.lateOpenOrders}`,
      `orders at risk (negative slack): ${atRisk}`,
      `ready tasks by role: ${[...byRole].map(([r, n]) => `${r} ${n}`).join(', ') || 'none'}`,
      `staff: ${m.activeWorkers} active, ${m.busyWorkers} busy`,
      `score so far: reward ${m.reward.toFixed(2)}, penalty ${m.penalty.toFixed(3)}`,
      'history (ticks: weights -> penalty change, reward change):',
      ...(this.history.length
        ? this.history.map((w, i) => {
            const next = this.history[i + 1];
            const penaltyEnd = next?.penaltyAtStart ?? m.penalty;
            const rewardEnd = next?.rewardAtStart ?? m.reward;
            return `${w.from}-${w.to}: beta ${w.weights.beta}, gamma ${w.weights.gamma}, delta ${w.weights.delta} -> +${(penaltyEnd - w.penaltyAtStart).toFixed(3)}, +${(rewardEnd - w.rewardAtStart).toFixed(2)}`;
          })
        : ['none yet']),
    ];
    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low', format: zodOutputFormat(Answer) },
      system: [
        { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: lines.join('\n') }],
    });
    if (response.stop_reason === 'refusal') {
      this.o.log(`llm planner: tick ${tick} declined`);
      return;
    }
    const answer = response.parsed_output;
    if (!answer) {
      this.o.log(`llm planner: tick ${tick} answer could not be parsed`);
      return;
    }
    const weights = {
      beta: clamp(answer.beta, RANGE.beta),
      gamma: clamp(answer.gamma, RANGE.gamma),
      delta: clamp(answer.delta, RANGE.delta),
    };
    await this.o.conn.reducers.setPolicy({
      runId: this.o.runId,
      configJson: JSON.stringify({
        deadlineWeight: weights.beta,
        executionWeight: weights.gamma,
        coordinationWeight: weights.delta,
      }),
    });
    this.weights = weights;
    const now = this.metrics() ?? m;
    this.history.push({
      from: tick,
      weights,
      penaltyAtStart: now.penalty,
      rewardAtStart: now.reward,
    });
    this.nextTick = tick + Math.round(BASE_INTERVAL * (1 + weights.delta));
    const ms = performance.now() - started;
    const usage = response.usage;
    const inputTokens =
      usage.input_tokens +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    this.requests++;
    this.o.log(
      `llm planner: tick ${tick} beta ${weights.beta} gamma ${weights.gamma} delta ${weights.delta} in ${Math.round(ms)} ms (${inputTokens} in / ${usage.output_tokens} out), next at tick ${this.nextTick}: ${answer.reason}`,
    );
    await this.o.report?.({
      key: `llm-${this.o.runId}-${this.requests}`,
      ms,
      inputTokens,
      outputTokens: usage.output_tokens,
      costMicrousd: Math.round(
        inputTokens * PRICE_IN + usage.output_tokens * PRICE_OUT,
      ),
    });
  }
}
