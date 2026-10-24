import type { Planner, RunnerClock, ScenarioRunner } from '../runner';
import { SCENARIOS } from '../scenarioCatalog';

/**
 * ScenarioRunner for local development: asks the Vite dev server to run the
 * test feeder (apps/web/devFeederPlugin.ts → scripts/feed-scenario.ts) for a
 * fixed scenario. The feeder process writes to SpacetimeDB; nothing here does.
 */
export class DevFeederRunner implements ScenarioRunner {
  readonly scenarios = SCENARIOS.map((s) => ({
    id: s.id,
    label: s.id,
    group: s.load,
    detail: s.description,
  }));

  async start(id: string, viewer: string, planner: Planner = 'algorithm') {
    const res = await fetch('/__dev/feed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: id, viewer, planner }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Feeder request failed (${res.status}).`);
    }
    const { jobId } = (await res.json()) as { jobId: number };
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const statusResponse = await fetch('/__dev/feed', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (!statusResponse.ok)
        throw new Error(
          'Cannot read scenario status. Check the development server.',
        );
      const status = (await statusResponse.json()) as {
        jobId: number;
        state: string;
        lastLine: string;
      };
      if (status.jobId !== jobId)
        throw new Error(
          'The feeder restarted. Select the latest scenario or retry.',
        );
      if (status.state === 'failed')
        throw new Error(
          status.lastLine || 'Scenario failed. Check the server logs.',
        );
      // Completed, or stopped from the dashboard: either way the run is over.
      if (status.state === 'completed' || status.state === 'stopped') return;
    }
  }

  async clock(): Promise<RunnerClock | undefined> {
    const res = await fetch('/__dev/feed', { cache: 'no-store' });
    if (!res.ok) return undefined;
    const s = (await res.json()) as {
      state: string;
      scenario?: string;
      clock?: { startedAt: number; tickMs: number };
    };
    return s.state === 'running' && s.scenario && s.clock
      ? { scenario: s.scenario, ...s.clock }
      : undefined;
  }

  async llmAvailable() {
    const res = await fetch('/__dev/feed', { cache: 'no-store' });
    if (!res.ok) return false;
    return !!((await res.json()) as { llmAvailable?: boolean }).llmAvailable;
  }

  async stop() {
    const res = await fetch('/__dev/feed', { method: 'DELETE' });
    if (!res.ok) throw new Error(`Stop request failed (${res.status}).`);
  }
}
