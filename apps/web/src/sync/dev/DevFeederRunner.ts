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
  }
}
