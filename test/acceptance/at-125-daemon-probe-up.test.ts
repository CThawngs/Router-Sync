/**
 * test/acceptance/at-125-daemon-probe-up.test.ts
 *
 * Acceptance Test AT-125: Router Reachability Classification
 *
 * Verifies honest router reachability classification against dynamic local HTTP mock servers:
 * (1) /api/health returns 200 -> 'up'
 * (2) /api/health returns 404, but /v1/models returns 200 -> 'up' (OmniRoute fallback)
 * (3) Connection refused (server closed) -> 'down'
 * (4) HTTP 5xx / 401 -> 'unknown' (with httpStatus)
 * (5) Timeout (>800ms) -> 'down'
 *
 * Zero live router calls (no ports 20128/30128), zero token consumption.
 */

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeRouter } from '../../packages/daemon/src/probe/reachability.js';
import { createDaemonServer, clearProbeCache } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('Acceptance Test AT-125: Router Reachability Classification', () => {
  it('classifies /api/health returning 200 as up', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;

    try {
      const probe = await probeRouter('9router', url);
      expect(probe.reachability).toBe('up');
      expect(probe.httpStatus).toBe(200);
      expect(probe.url).toBe(url);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('classifies /api/health 404 with /v1/models 200 as up (OmniRoute fallback)', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      } else if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;

    try {
      const probe = await probeRouter('omniroute', url);
      expect(probe.reachability).toBe('up');
      expect(probe.httpStatus).toBe(200);
      expect(probe.url).toBe(url);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('classifies connection refused as down', async () => {
    // Pick an unused port by starting and immediately closing a server
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const url = `http://127.0.0.1:${port}`;
    const probe = await probeRouter('9router', url);

    expect(probe.reachability).toBe('down');
    expect(probe.url).toBe(url);
    expect(probe.error).toBeDefined();
  });

  it('classifies HTTP 5xx or 401 as unknown with httpStatus', async () => {
    const server500 = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    });
    await new Promise<void>((resolve) => server500.listen(0, '127.0.0.1', () => resolve()));
    const port500 = (server500.address() as AddressInfo).port;
    const url500 = `http://127.0.0.1:${port500}`;

    try {
      const probe500 = await probeRouter('9router', url500);
      expect(probe500.reachability).toBe('unknown');
      expect(probe500.httpStatus).toBe(500);
    } finally {
      await new Promise<void>((resolve) => server500.close(() => resolve()));
    }

    const server401 = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server401.listen(0, '127.0.0.1', () => resolve()));
    const port401 = (server401.address() as AddressInfo).port;
    const url401 = `http://127.0.0.1:${port401}`;

    try {
      const probe401 = await probeRouter('omniroute', url401);
      expect(probe401.reachability).toBe('unknown');
      expect(probe401.httpStatus).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server401.close(() => resolve()));
    }
  });

  it('classifies response timeout as down', async () => {
    const server = http.createServer((_req, _res) => {
      // Intentionally do not respond; let the 800ms abort signal trigger
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;

    try {
      const probe = await probeRouter('9router', url);
      expect(probe.reachability).toBe('down');
      expect(probe.error).toBeDefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * R11-3: router-UP case through the full daemon.
 *
 * Daemon S1 performs NO writes, so it must NEVER emit `applyState` — even when
 * both routers are reachable (`up`). Emitting `applyState: 'verified'` while no
 * write + read-back has ever happened would be untruthful (spec §33.3 states
 * are apply outcomes, not reachability).
 */
describe('Acceptance Test AT-125 (R11-3): router UP -> /targets carries NO applyState key', () => {
  /** Recursively collect every occurrence of `key` in a JSON-like value. */
  function findKeysDeep(obj: unknown, key: string, pathStr = ''): string[] {
    const found: string[] = [];
    if (!obj || typeof obj !== 'object') return found;
    if (Array.isArray(obj)) {
      obj.forEach((item, idx) => {
        found.push(...findKeysDeep(item, key, `${pathStr}[${idx}]`));
      });
      return found;
    }
    for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
      const currentPath = pathStr ? `${pathStr}.${k}` : k;
      if (k === key) found.push(currentPath);
      found.push(...findKeysDeep(val, key, currentPath));
    }
    return found;
  }

  it(
    'with both routers UP, GET /api/v1/targets has zero `applyState` keys at any level',
    async () => {
    // 1. Mock UP routers (zero-token /api/health -> 200)
    const mockOmni = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    const mockNine = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    await new Promise<void>((r) => mockOmni.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>((r) => mockNine.listen(0, '127.0.0.1', () => r()));
    const omniMockPort = (mockOmni.address() as AddressInfo).port;
    const nineMockPort = (mockNine.address() as AddressInfo).port;

    // 2. Hermetic fixture with probe URLs pointed at the mock UP routers
    let fixture: DaemonFixture | undefined;
    let daemon: http.Server | undefined;
    try {
      fixture = await setupDaemonFixture({
        probePorts: { omni: omniMockPort, nine: nineMockPort },
      });
      clearProbeCache();
      daemon = createDaemonServer({ host: '127.0.0.1' });
      const d = daemon;
      await new Promise<void>((resolve) => {
        d.listen(0, '127.0.0.1', () => resolve());
      });
      const daemonPort = (d.address() as AddressInfo).port;

      // 3. Probe classification stays honest
      const omniProbe = await probeRouter('omniroute', fixture.omniProbeUrl);
      const nineProbe = await probeRouter('9router', fixture.nineProbeUrl);
      expect(omniProbe.reachability).toBe('up');
      expect(nineProbe.reachability).toBe('up');

      // 4. /targets payload: NO `applyState` key at any level
      const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/targets`, {
        headers: { Host: `127.0.0.1:${daemonPort}` },
      });
      expect(res.status).toBe(200);
      const payload = await res.json();

      const applyStatePaths = findKeysDeep(payload, 'applyState');
      expect(applyStatePaths).toEqual([]);

      const targets = payload as Array<{
        id: string;
        probe?: { reachability: string };
        readBackLevel?: string;
      }>;
      const omni = targets.find((t) => t.id === 'omniroute');
      const nine = targets.find((t) => t.id === '9router');
      expect(omni?.probe?.reachability).toBe('up');
      expect(nine?.probe?.reachability).toBe('up');
      // Honest read-back level is unchanged: db-only (no write ever happened)
      expect(omni?.readBackLevel).toBe('db-only');
      expect(nine?.readBackLevel).toBe('db-only');
    } finally {
      const d = daemon;
      if (d) await new Promise<void>((resolve) => d.close(() => resolve()));
      mockOmni.close();
      mockNine.close();
      fixture?.restore();
    }
  }, 15000);
});
