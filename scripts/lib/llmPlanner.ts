import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { DbConnection } from '../../packages/bindings/src';

/**
 * LLM planner for the SYNC run: picks the planner's objective weights with
 * as few tokens as possible.
 *
 * The engine's primal_dual policy makes every assignment; Claude only sets
 * its planning weights β (lateness), γ (execution cost) and δ (coordination
 * cost). The run is judged by the engine's fixed reward weights, so the LLM
 * cannot change the score itself.
 *
 * Token budget per run, smallest first:
 * - one request when the run starts, from the results of earlier runs of the
 *   same scenario (weights → final objective, kept in .local/), so tuning
 *   improves across runs instead of during one;
 * - at most MAX_CORRECTIONS more, only when orders fall at risk;
 * - numbers in, three numbers out, on a short system prompt;
 * - answers cached in memory by request (persisted to disk for later runs):
 *   the same scenario history or the same (bucketed) situation never calls
 *   the API twice.
 * Requests never block a tick. Each API call is reported through
 * `report_usage` (source "coordinator") as planning time.
 */

/** Small, fast model. */
const MODEL = 'claude-haiku-5-5';
/** Claude Haiku 5.5 list prices in micro-USD per token (input / output). */
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;
/** Mid-run corrections per run, and the gap between them (ticks). */
const MAX_CORRECTIONS = 2;
const CORRECTION_GAP = 20;
/** Orders at risk (negative slack) that justify a correction. */
const AT_RISK = 2;
/** Earlier runs per scenario shown to the model. */
const HISTORY_LIMIT = 8;
/** Allowed weight ranges (also stated in the prompt). */
const RANGE = { b: [0, 2], g: [0, 1], d: [0, 2] } as const;
const CACHE_FILE = '.local/llm-planner-cache.json';
const HISTORY_FILE = '.local/llm-planner-history.json';

const SYSTEM = `Tune a coffee-shop scheduler. Weights: b in [0,2] lateness penalty (default 0.1); g in [0,1] execution-cost penalty, higher adds extra staff less eagerly (default 0); d in [0,2] coordination cost, higher plans more coarsely (default 0). Goal: maximize the final objective (completed orders minus lateness, waiting, cost and staff time). Use steps of 0.1. Reply with b, g, d only.`;

const Answer = z.object({ b: z.number(), g: z.number(), d: z.number() });
type Weights = z.infer<typeof Answer>;
type Usage = {
  key: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
};

/** One finished run of a scenario: weights it started with → final objective. */
interface Past {
  b: number;
  g: number;
  d: number;
  objective: number;
}

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as T)
      : fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (file: string, value: unknown) => {
  mkdirSync('.local', { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 1));
};
/** Weights snap to steps of 0.1: fewer distinct values, more repeated questions. */
const clamp = (n: number, [lo, hi]: readonly [number, number]) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 10) / 10)) : lo;
/**
 * Answers by request hash, in memory: filled once from the disk cache, read
 * without touching the disk, and written through so the next feeder
 * process (one per run) starts with every answer so far.
 */
let memory: Map<string, Weights> | undefined;
const answers = () =>
  (memory ??= new Map(
    Object.entries(readJson<Record<string, Weights>>(CACHE_FILE, {})),
  ));
const remember = (key: string, w: Weights) => {
  answers().set(key, w);
  writeJson(CACHE_FILE, Object.fromEntries(answers()));
};
/** Coarse buckets so similar situations share a cache entry. */
const bucket = (n: number) => (n <= 0 ? '0' : n <= 2 ? '1-2' : '3+');
/** Staff load as a word instead of raw counts. */
const load = (busy: number, active: number) =>
  busy === 0 ? 'idle' : busy < active ? 'busy' : 'full';

export interface LlmPlannerOptions {
  /** Feeder connection (run owner): sets the policy weights. */
  conn: DbConnection;
  /** SYNC run whose planner is tuned. */
  runId: bigint;
  /** Fixed scenario id ("Low-3"): earlier results of it guide the first pick. */
  scenario: string;
  /** Scenario length in ticks (for the run phase). */
  horizon: number;
  /** Reports one API call (planning time, tokens, cost). */
  report?(usage: Usage): Promise<void>;
  log(line: string): void;
}

export class LlmPlanner {
  private readonly client = new Anthropic();
  private busy = false;
  private started = false;
  private corrections = 0;
  private lastCorrection = -Infinity;
  private calls = 0;
  private weights: Weights = { b: 0.1, g: 0, d: 0 };
  /** Weights picked when the run started (recorded with the final objective). */
  private initial?: Weights;

  constructor(private readonly o: LlmPlannerOptions) {}

  /** Called before each step; starts a request when one is due, never waits for it. */
  beforeStep(tick: number) {
    if (this.busy) return;
    if (!this.started) {
      this.started = true;
      return this.run(() => this.initialPick());
    }
    if (
      this.corrections >= MAX_CORRECTIONS ||
      tick - this.lastCorrection < CORRECTION_GAP
    )
      return;
    const atRisk = this.atRisk();
    if (atRisk < AT_RISK) return;
    this.corrections++;
    this.lastCorrection = tick;
    this.run(() => this.correct(tick, atRisk));
  }

  /** Records the run's result for the next run of the same scenario. */
  finish() {
    const m = this.metrics();
    if (!m || !this.initial) return;
    const all = readJson<Record<string, Past[]>>(HISTORY_FILE, {});
    all[this.o.scenario] = [
      ...(all[this.o.scenario] ?? []),
      { ...this.initial, objective: Math.round(m.netReward * 1000) / 1000 },
    ].slice(-50);
    writeJson(HISTORY_FILE, all);
    this.o.log(
      `llm planner: ${this.calls} API calls; recorded objective ${m.netReward.toFixed(3)} for ${this.o.scenario}`,
    );
  }

  private run(job: () => Promise<void>) {
    this.busy = true;
    void job()
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

  /** Orders with a waiting task already past its slack. */
  private atRisk() {
    return new Set(
      [...this.o.conn.db.uiTasks.iter()]
        .filter(
          (t) =>
            t.runId === this.o.runId &&
            (t.status === 'ready' || t.status === 'blocked') &&
            (t.estimatedSlackTicks ?? 1n) < 0n,
        )
        .map((t) => String(t.orderId)),
    ).size;
  }

  /** First pick, from earlier runs of this scenario (best first). */
  private async initialPick() {
    // Weight sets tried on this scenario, best mean objective first. Only the
    // order goes into the question: while it stays the same, so does the
    // question, and the cached answer is reused (no API call).
    const byWeights = new Map<string, number[]>();
    for (const p of readJson<Record<string, Past[]>>(HISTORY_FILE, {})[
      this.o.scenario
    ] ?? []) {
      const k = `${clamp(p.b, RANGE.b)},${clamp(p.g, RANGE.g)},${clamp(p.d, RANGE.d)}`;
      byWeights.set(k, [...(byWeights.get(k) ?? []), p.objective]);
    }
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const ranked = [...byWeights]
      .sort((a, b) => mean(b[1]) - mean(a[1]) || (a[0] < b[0] ? -1 : 1))
      .slice(0, HISTORY_LIMIT)
      .map(([k]) => k);
    const prompt = [
      `scenario ${this.o.scenario}, start of run`,
      ranked.length
        ? `weights tried b,g,d, best objective first: ${ranked.join('; ')}`
        : 'no past runs',
    ].join('\n');
    const w = await this.ask(prompt, 'start');
    if (w) this.initial = w;
  }

  /** Mid-run correction from a bucketed situation (cache-friendly). */
  private async correct(tick: number, atRisk: number) {
    const m = this.metrics();
    const phase = ['early', 'middle', 'late'][
      Math.min(2, Math.floor((3 * tick) / this.o.horizon))
    ];
    const prompt = [
      `scenario ${this.o.scenario}, ${phase} of run, now b ${this.weights.b} g ${this.weights.g} d ${this.weights.d}`,
      `orders at risk ${bucket(atRisk)}, late open ${bucket(m?.lateOpenOrders ?? 0)}, ready tasks ${bucket(m?.readyTasks ?? 0)}, staff ${load(m?.busyWorkers ?? 0, m?.activeWorkers ?? 0)}`,
    ].join('\n');
    await this.ask(prompt, `tick ${tick}`);
  }

  /** Cached answer or one API call; applies the weights. */
  private async ask(
    prompt: string,
    when: string,
  ): Promise<Weights | undefined> {
    const key = createHash('sha256')
      .update(JSON.stringify([MODEL, SYSTEM, prompt]))
      .digest('hex');
    let w = answers().get(key);
    if (w) this.o.log(`llm planner: ${when} cache hit`);
    else {
      const started = performance.now();
      const response = await this.client.messages.parse({
        model: MODEL,
        max_tokens: 1000,
        output_config: { effort: 'low', format: zodOutputFormat(Answer) },
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      });
      if (response.stop_reason === 'refusal' || !response.parsed_output) {
        this.o.log(`llm planner: ${when} no usable answer`);
        return undefined;
      }
      w = response.parsed_output;
      remember(key, w);
      const ms = performance.now() - started;
      const u = response.usage;
      const inputTokens =
        u.input_tokens +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      this.calls++;
      this.o.log(
        `llm planner: ${when} API call ${Math.round(ms)} ms (${inputTokens} in / ${u.output_tokens} out)`,
      );
      await this.o.report?.({
        key: `llm-${this.o.runId}-${this.calls}`,
        ms,
        inputTokens,
        outputTokens: u.output_tokens,
        costMicrousd: Math.round(
          inputTokens * PRICE_IN + u.output_tokens * PRICE_OUT,
        ),
      });
    }
    const weights = {
      b: clamp(w.b, RANGE.b),
      g: clamp(w.g, RANGE.g),
      d: clamp(w.d, RANGE.d),
    };
    await this.o.conn.reducers.setPolicy({
      runId: this.o.runId,
      configJson: JSON.stringify({
        deadlineWeight: weights.b,
        executionWeight: weights.g,
        coordinationWeight: weights.d,
      }),
    });
    this.weights = weights;
    this.o.log(
      `llm planner: ${when} b ${weights.b} g ${weights.g} d ${weights.d}`,
    );
    return weights;
  }
}
