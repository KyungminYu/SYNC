import type { Policy } from '../contract';
import type { Planner } from '../runner';
import { LOADS, type Load } from '../scenarioCatalog';

/**
 * Engine run names for live scenarios: "{Low|Mid|High}-{n} · {Baseline|SYNC}",
 * with " · LLM" when an LLM tuned the SYNC planner. The Baseline and SYNC runs
 * of one scenario share the scenario id ("Mid-2", or "Mid-2 · LLM"), so
 * algorithm and LLM results are kept apart. The format may change later; it
 * is written and read only here.
 */

export { LOADS, type Load };

const POLICY_WORD: Record<Policy, string> = {
  baseline: 'Baseline',
  sync: 'SYNC',
};

/** Scenario id per planner: "Mid-2" or "Mid-2 · LLM". */
export function scenarioId(
  load: Load,
  n: number,
  planner: Planner = 'algorithm',
) {
  return `${load}-${n}${planner === 'llm' ? ' · LLM' : ''}`;
}

/** "Mid-2 · SYNC" or "Mid-2 · SYNC · LLM", plus " [batch]". */
export function runName(
  load: Load,
  n: number,
  policy: Policy,
  batch?: string,
  planner: Planner = 'algorithm',
) {
  return `${load}-${n} · ${POLICY_WORD[policy]}${planner === 'llm' ? ' · LLM' : ''}${batch ? ` [${batch}]` : ''}`;
}

/** Parsed run name, or undefined for runs that do not follow the format. */
export function parseRunName(name: string):
  | {
      scenario: string;
      load: Load;
      n: number;
      policy: Policy;
      planner: Planner;
      batch?: string;
    }
  | undefined {
  const m = name.match(
    /^(Low|Mid|High)-(\d+) · (Baseline|SYNC)( · LLM)?(?: \[([a-z0-9-]+)\])?$/,
  );
  if (!m) return undefined;
  const planner: Planner = m[4] ? 'llm' : 'algorithm';
  return {
    scenario: scenarioId(m[1] as Load, Number(m[2]), planner),
    load: m[1] as Load,
    n: Number(m[2]),
    policy: m[3] === 'SYNC' ? 'sync' : 'baseline',
    planner,
    batch: m[5],
  };
}
