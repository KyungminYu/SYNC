import type { Policy } from '../contract';
import { LOADS, type Load } from '../scenarioCatalog';

/**
 * Engine run names for live scenarios: "{Low|Mid|High}-{n} · {Baseline|SYNC}".
 * The Baseline and SYNC runs of one scenario share "{load}-{n}" (the scenario
 * id). The format may change later; it is written and read only here.
 */

export { LOADS, type Load };

const POLICY_WORD: Record<Policy, string> = {
  baseline: 'Baseline',
  sync: 'SYNC',
};

/** "Mid-2 · SYNC". */
export function runName(load: Load, n: number, policy: Policy, batch?: string) {
  return `${load}-${n} · ${POLICY_WORD[policy]}${batch ? ` [${batch}]` : ''}`;
}

/** Parsed run name, or undefined for runs that do not follow the format. */
export function parseRunName(
  name: string,
):
  | { scenario: string; load: Load; n: number; policy: Policy; batch?: string }
  | undefined {
  const m = name.match(
    /^(Low|Mid|High)-(\d+) · (Baseline|SYNC)(?: \[([a-z0-9-]+)\])?$/,
  );
  if (!m) return undefined;
  return {
    scenario: `${m[1]}-${m[2]}`,
    load: m[1] as Load,
    n: Number(m[2]),
    policy: m[3] === 'SYNC' ? 'sync' : 'baseline',
    batch: m[4],
  };
}
