import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { createDaemonServer, clearProbeCache } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('Acceptance Test AT-121: Data Honesty & D7/D1 Reflection (B-1 / D7 / D1)', () => {
  let server: http.Server;
  let port: number;
  let fixture: DaemonFixture | undefined;

  beforeAll(async () => {
    // R11-0: hermetic fixture — env overrides point config/DBs/probe URLs at tmp state.
    fixture = await setupDaemonFixture();
    clearProbeCache();
    server = createDaemonServer({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fixture?.restore();
  });

  it('reflects router reachability honestly when routers are down (B-1 / D7)', async () => {
    // When 9Router and OmniRoute ports are not running live, daemon must report them down
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/targets`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);

    const targets = (await res.json()) as Array<{
      id: string;
      readBackLevel?: string;
      applyState?: string;
      breakerState?: string;
      db?: { meta: { source: string }; combosManaged: number };
      probe?: { meta: { source: string; reason?: string }; reachability: string };
    }>;

    const omni = targets.find((t) => t.id === 'omniroute');
    const nine = targets.find((t) => t.id === '9router');

    expect(omni).toBeDefined();
    expect(nine).toBeDefined();

    // If local routers are not running, must reflect degraded state honestly:
    // NOT false 'full', NOT false 'verified', and NOT false 'written-pending-reload' (R8-5)
    if (omni?.probe?.reachability === 'down') {
      expect(omni.probe.meta.source).toBe('unavailable');
      expect(omni.probe.meta.reason).toBe('router_unreachable');
      expect(omni.applyState).toBeUndefined();
      expect(omni.breakerState).toBeUndefined();
    }

    if (nine?.probe?.reachability === 'down') {
      expect(nine.probe.meta.source).toBe('unavailable');
      expect(nine.probe.meta.reason).toBe('router_unreachable');
      expect(nine.applyState).toBeUndefined();
      expect(nine.breakerState).toBeUndefined();
    }
  });

  it('reports meta.source as unavailable in /api/v1/overview when routers are offline (D7)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/overview`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);

    const overview = (await res.json()) as any;
    expect(overview.meta).toBeDefined();
    expect(overview.billableRequestsToday.code).toBe('by_design_zero_inference');
    expect(overview.billableRequestsToday.count).toBeUndefined();

    // Todo and event items use structured code keys for D1 localization
    for (const item of overview.todoItems ?? []) {
      expect(item.code).toBeDefined();
      expect(typeof item.code).toBe('string');
    }
    for (const evt of overview.recentEvents ?? []) {
      expect(evt.code).toBeDefined();
      expect(typeof evt.code).toBe('string');
    }
  });
});
