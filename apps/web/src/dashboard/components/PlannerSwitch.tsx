import type { Planner } from '../../sync/runner';

/**
 * Who plans the next SYNC run: the engine's own policy, or an LLM (Claude)
 * that tunes the planner weights (β, γ, δ). Shown next to the scenario picker;
 * the choice applies to the next Run. LLM is disabled without an API key.
 */
export function PlannerSwitch({
  value,
  llmAvailable,
  onChange,
}: {
  value: Planner;
  llmAvailable: boolean;
  onChange(p: Planner): void;
}) {
  return (
    <div className="planner-switch">
      <span className="planner-label">SYNC planner</span>
      <div className="segmented" role="group" aria-label="SYNC planner">
        <button
          aria-pressed={value === 'algorithm'}
          onClick={() => onChange('algorithm')}
        >
          Algorithm
        </button>
        <button
          aria-pressed={value === 'llm'}
          disabled={!llmAvailable}
          title={
            llmAvailable
              ? 'Claude tunes the planner weights β, γ, δ every 10–30 ticks'
              : 'Add ANTHROPIC_API_KEY to the repo root .env.local'
          }
          onClick={() => onChange('llm')}
        >
          LLM · Claude
        </button>
      </div>
      {!llmAvailable && (
        <span className="planner-hint">needs ANTHROPIC_API_KEY</span>
      )}
    </div>
  );
}
