import type { Planner, RunnerClock, ScenarioRunner } from '../runner';
import { SCENARIOS } from '../scenarioCatalog';

/**
 * ScenarioRunner for local development: asks the Vite dev server to run the
 * test feeder (apps/web/devFeederPlugin.ts → scripts/feed-scenario.ts) for a
 * fixed scenario. The feeder process writes to SpacetimeDB; nothing here does.
 */
export class DevFeederRunner implements ScenarioRunner {
  private accessCode: string | undefined;
  constructor(
    private readonly endpoint = '/__dev/feed',
    private readonly remote = false,
  ) {}

  private async request(init: RequestInit = {}) {
    const mutation = init.method === 'POST' || init.method === 'DELETE';
    if (this.remote && mutation && !this.accessCode) {
      this.accessCode = window.prompt('Runner operator access code')?.trim();
      if (!this.accessCode)
        throw new Error('A runner operator access code is required.');
    }
    const response = await fetch(this.endpoint, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(10000),
      headers: {
        ...init.headers,
        ...(this.remote && mutation
          ? { authorization: `Bearer ${this.accessCode}` }
          : {}),
      },
    });
    if (response.status === 401) this.accessCode = undefined;
    return response;
  }

  readonly scenarios = SCENARIOS.map((s) => ({
    id: s.id,
    label: s.id,
    group: s.load,
    detail: s.description,
  }));

  async start(id: string, viewer: string, planner: Planner = 'algorithm') {
    const res = await this.request({
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
      const statusResponse = await this.request({
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (!statusResponse.ok)
        throw new Error(
          'Cannot read scenario status. Check the runner service.',
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
    const res = await this.request({ cache: 'no-store' });
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
    const res = await this.request({ cache: 'no-store' });
    if (!res.ok) return false;
    return !!((await res.json()) as { llmAvailable?: boolean }).llmAvailable;
  }

  async stop() {
    const res = await this.request({ method: 'DELETE' });
    if (!res.ok) throw new Error(`Stop request failed (${res.status}).`);
  }
}
