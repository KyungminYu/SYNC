import type { ScenarioRunner } from '../runner';
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

  async start(id: string, viewer: string) {
    const res = await fetch('/__dev/feed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: id, viewer }),
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
      if (status.state === 'completed') return;
    }
  }
}
