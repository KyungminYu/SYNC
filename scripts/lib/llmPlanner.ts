import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { DbConnection } from '../../packages/bindings/src';

/**
 * LLM planner for the SYNC run: decides staffing.
 *
 * The engine's primal-dual planner makes every assignment, and the four base
 * staff help each other across roles. Claude decides whether a cashier,
 * barista or server gets a second worker (the cleaner stays alone) and when
 * that worker goes home again: extra staff shorten waits but cost staff time
 * in the run's objective, so adding them pays only in a real rush.
 *
 * Calls are few. Each tick the planner sums up every role's backlog in
 * coarse buckets; only when that summary changes is the question asked, and
 * an answer to the same question is reused from the cache (memory, written
 * through to .local/ so later runs start with it). Requests never block a
 * tick, and each API call is reported through `report_usage` (source
 * "coordinator") as planning time.
 */

/** Small, fast model. */
const MODEL = 'claude-haiku-5-5';
/** Claude Haiku 5.5 list prices in micro-USD per token (input / output). */
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;
/** At most this many questions per run, at least this many ticks apart. */
const MAX_QUESTIONS = 12;
const QUESTION_GAP = 5;
const ROLES = ['cashier', 'barista', 'server'] as const;
type Role = (typeof ROLES)[number];
const CACHE_FILE = '.local/llm-staffing-cache.json';

const SYSTEM = `You are the manager of a coffee shop run by four people (cashier, barista, server, cleaner) who also help each other. For each of cashier, barista and server choose 1 or 2 workers. A second worker shortens waits, but staff time is expensive: each worker on shift for 100 seconds costs as much as two completed orders, and you are paid only while you answer. Add a second worker only for a backlog that helping cannot absorb; go back to 1 as soon as it clears. Reply with the three counts only.`;

const Answer = z.object({
  cashier: z.number(),
  barista: z.number(),
  server: z.number(),
});
type Staff = Record<Role, 1 | 2>;
type Usage = {
  key: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
};

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as T)
      : fallback;
  } catch {
    return fallback;
  }
};
/**
 * Answers by request hash, in memory: filled once from the disk cache, read
 * without touching the disk, and written through so the next feeder
 * process (one per run) starts with every answer so far.
 */
let memory: Map<string, Staff> | undefined;
const answers = () =>
  (memory ??= new Map(
    Object.entries(readJson<Record<string, Staff>>(CACHE_FILE, {})),
  ));
const remember = (key: string, w: Staff) => {
  answers().set(key, w);
  mkdirSync('.local', { recursive: true });
  writeFileSync(
    CACHE_FILE,
    JSON.stringify(Object.fromEntries(answers()), null, 1),
  );
};
/** Backlog in coarse buckets, so similar moments ask the same question. */
const bucket = (n: number) =>
  n <= 0 ? '0' : n <= 2 ? '1-2' : n <= 4 ? '3-4' : '5+';
/** Any answer becomes 1 or 2 workers. */
const count = (n: number): 1 | 2 => (Math.round(n) >= 2 ? 2 : 1);

export interface LlmPlannerOptions {
  /** Feeder connection (run owner): sets the staffing target. */
  conn: DbConnection;
  /** SYNC run whose staffing is decided. */
  runId: bigint;
  /** Fixed scenario id ("Low-3"), part of the question. */
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
  private asked = 0;
  private lastAsk = -Infinity;
  private calls = 0;
  private hits = 0;
  /** Situation of the last question (ask again only when it changes). */
  private lastSummary = '';
  private staff: Staff = { cashier: 1, barista: 1, server: 1 };

  constructor(private readonly o: LlmPlannerOptions) {}

  /** Called before each step; asks when the situation changed, never waits. */
  beforeStep(tick: number) {
    if (
      this.busy ||
      this.asked >= MAX_QUESTIONS ||
      tick - this.lastAsk < QUESTION_GAP
    )
      return;
    const summary = this.summary(tick);
    if (!summary || summary === this.lastSummary) return;
    this.lastSummary = summary;
    this.lastAsk = tick;
    this.asked++;
    this.busy = true;
    void this.ask(summary, tick)
      .catch((error: unknown) =>
        this.o.log(
          `llm planner: request failed (${error instanceof Error ? error.message : 'unknown error'})`,
        ),
      )
      .finally(() => {
        this.busy = false;
      });
  }

  /** Logs how the run went (API calls, reused answers, final objective). */
  finish() {
    const m = [...this.o.conn.db.uiMetrics.iter()].find(
      (x) => x.runId === this.o.runId,
    );
    this.o.log(
      `llm planner: ${this.calls} API calls, ${this.hits} cached answers; objective ${m ? m.netReward.toFixed(3) : '?'}`,
    );
  }

  /** Bucketed backlog and staff per role, orders at risk, run phase. */
  private summary(tick: number) {
    const db = this.o.conn.db;
    const tasks = [...db.uiTasks.iter()].filter(
      (t) => t.runId === this.o.runId,
    );
    if (!tasks.length) return undefined;
    const workers = [...db.uiWorkers.iter()].filter(
      (w) => w.runId === this.o.runId,
    );
    const atRisk = new Set(
      tasks
        .filter(
          (t) =>
            (t.status === 'ready' || t.status === 'blocked') &&
            (t.estimatedSlackTicks ?? 1n) < 0n,
        )
        .map((t) => String(t.orderId)),
    ).size;
    const phase = ['early', 'middle', 'late'][
      Math.min(2, Math.floor((3 * tick) / this.o.horizon))
    ];
    return [
      `scenario ${this.o.scenario}, ${phase} of run`,
      ...ROLES.map((role) => {
        const ready = tasks.filter(
          (t) => t.role === role && t.status === 'ready',
        ).length;
        const on = workers.filter((w) => w.role === role && w.enabled).length;
        return `${role}: backlog ${bucket(ready)}, workers ${on}`;
      }),
      `orders at risk ${bucket(atRisk)}`,
    ].join('\n');
  }

  /** Cached answer or one API call; applies the staffing target. */
  private async ask(summary: string, tick: number) {
    const key = createHash('sha256')
      .update(JSON.stringify([MODEL, SYSTEM, summary]))
      .digest('hex');
    let staff = answers().get(key);
    if (staff) this.hits++;
    else {
      const started = performance.now();
      const response = await this.client.messages.parse({
        model: MODEL,
        max_tokens: 1000,
        output_config: { effort: 'low', format: zodOutputFormat(Answer) },
        system: SYSTEM,
        messages: [{ role: 'user', content: summary }],
      });
      if (response.stop_reason === 'refusal' || !response.parsed_output) {
        this.o.log(`llm planner: tick ${tick} no usable answer`);
        return;
      }
      const a = response.parsed_output;
      staff = {
        cashier: count(a.cashier),
        barista: count(a.barista),
        server: count(a.server),
      };
      remember(key, staff);
      const ms = performance.now() - started;
      const u = response.usage;
      const inputTokens =
        u.input_tokens +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      this.calls++;
      this.o.log(
        `llm planner: tick ${tick} API call ${Math.round(ms)} ms (${inputTokens} in / ${u.output_tokens} out)`,
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
    const next = staff;
    if (ROLES.every((r) => this.staff[r] === next[r])) return;
    await this.o.conn.reducers.setPolicy({
      runId: this.o.runId,
      configJson: JSON.stringify({ staffTarget: next }),
    });
    this.staff = next;
    this.o.log(
      `llm planner: tick ${tick} workers cashier ${next.cashier}, barista ${next.barista}, server ${next.server}`,
    );
  }
}
