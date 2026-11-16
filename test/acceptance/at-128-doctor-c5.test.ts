/**
 * test/acceptance/at-128-doctor-c5.test.ts
 *
 * Acceptance Test AT-128: Doctor c5 snapshot directory truthfulness & zero-write guarantee (R12-1, extended R14-4).
 *
 * Validates:
 * 1. Calling GET /api/v1/doctor NEVER creates <ROUTERSYNC_STATE_DIR>/snapshots if missing.
 * 2. Missing snapshots dir -> state: 'not_checked', reason: 'no_snapshot_dir_yet', code: 'snapshot_dir_missing' (R14-4.1).
 * 3. Unwritable snapshots dir -> state: 'fail', code: 'snapshot_dir_unwritable'.
 * 4. Writable snapshots dir with DB present & 0 snapshots -> state: 'not_checked', code: 'snapshot_none_yet', params: { snapshots: 0 }.
 * 5. Writable snapshots dir with >= 1 snapshot -> state: 'pass', code: 'snapshot_dir_writable', params: { snapshots: N }.
 * 6. R14-4.3: with c1..c4 and c6 passing, a missing snapshots dir alone must NOT make overallStatus 'error'.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDaemonServer, clearProbeCache } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('Acceptance Test AT-128: Doctor c5 snapshot directory truthfulness (R12-1)', () => {
  let fixture: DaemonFixture | undefined;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
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

  it('guarantee (a): calling doctor NEVER creates snapshots directory when missing', async () => {
    const snapshotsDir = path.join(fixture!.stateDir, 'snapshots');

    // Ensure snapshots dir does not exist initially
    if (fs.existsSync(snapshotsDir)) {
      fs.rmSync(snapshotsDir, { recursive: true, force: true });
    }
    expect(fs.existsSync(snapshotsDir)).toBe(false);

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/doctor`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);

    // Assert snapshots dir was NOT created
    expect(fs.existsSync(snapshotsDir)).toBe(false);

    const body = (await res.json()) as {
      conditions: Array<{ id: string; state: string; reason?: string; code?: string }>;
    };
    const c5 = body.conditions.find((c) => c.id === 'c5');
    expect(c5).toBeDefined();
    // R14-4.1: a missing snapshot dir is NOT a failure. Daemon S1 never creates
    // it (zero-write), so on a machine that has never applied a plan the dir is
    // legitimately absent and c5 must stay 'not_checked'.
    expect(c5?.state).toBe('not_checked');
    expect(c5?.reason).toBe('no_snapshot_dir_yet');
    expect(c5?.code).toBe('snapshot_dir_missing');
  });

  it('guarantee (b1): unwritable snapshots directory reports snapshot_dir_unwritable', async () => {
    const snapshotsDir = path.join(fixture!.stateDir, 'snapshots');

    // Create a regular file at snapshots path so readdirSync fails with ENOTDIR (unwritable directory)
    if (fs.existsSync(snapshotsDir)) {
      fs.rmSync(snapshotsDir, { recursive: true, force: true });
    }
    fs.writeFileSync(snapshotsDir, 'not-a-directory', 'utf8');
    expect(fs.existsSync(snapshotsDir)).toBe(true);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/doctor`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      const body = (await res.json()) as { conditions: Array<{ id: string; state: string; code?: string }> };
      const c5 = body.conditions.find((c) => c.id === 'c5');
      expect(c5?.state).toBe('fail');
      expect(c5?.code).toBe('snapshot_dir_unwritable');
    } finally {
      fs.rmSync(snapshotsDir, { force: true });
    }
  });

  it('guarantee (b2): writable snapshots dir with DB present & 0 snapshots reports snapshot_none_yet', async () => {
    const snapshotsDir = path.join(fixture!.stateDir, 'snapshots');

    if (fs.existsSync(snapshotsDir)) {
      fs.rmSync(snapshotsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(snapshotsDir, { recursive: true });

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/doctor`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    const body = (await res.json()) as {
      conditions: Array<{ id: string; state: string; reason?: string; code?: string; params?: { snapshots?: number } }>;
    };
    const c5 = body.conditions.find((c) => c.id === 'c5');
    expect(c5?.state).toBe('not_checked');
    expect(c5?.reason).toBe('no_snapshot_yet');
    expect(c5?.code).toBe('snapshot_none_yet');
    expect(c5?.params?.snapshots).toBe(0);
  });

  it('guarantee (b3): writable snapshots dir with >= 1 snapshot reports snapshot_dir_writable', async () => {
    const snapshotsDir = path.join(fixture!.stateDir, 'snapshots');

    if (!fs.existsSync(snapshotsDir)) {
      fs.mkdirSync(snapshotsDir, { recursive: true });
    }
    fs.writeFileSync(path.join(snapshotsDir, 'snap-20261018-01.json'), '{}', 'utf8');

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/doctor`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    const body = (await res.json()) as {
      conditions: Array<{ id: string; state: string; code?: string; params?: { snapshots?: number } }>;
    };
    const c5 = body.conditions.find((c) => c.id === 'c5');
    expect(c5?.state).toBe('pass');
    expect(c5?.code).toBe('snapshot_dir_writable');
    expect(c5?.params?.snapshots).toBeGreaterThanOrEqual(1);
  });
});

/**
 * R14-4.3: a machine that has never applied a plan has no snapshot directory.
 * Daemon S1 is zero-write, so it never creates that directory. The missing
 * directory must NOT turn the whole doctor report into `overallStatus: 'error'`
 * when every other measurable condition passes.
 */
describe('Acceptance Test AT-128 (R14-4.3): missing snapshot dir alone is not an error', () => {
  it('with c1..c4 and c6 passing, overallStatus is not "error" because of c5', async () => {
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

    let fixture: DaemonFixture | undefined;
    let daemon: http.Server | undefined;
    try {
      fixture = await setupDaemonFixture({
        probePorts: {
          omni: (mockOmni.address() as AddressInfo).port,
          nine: (mockNine.address() as AddressInfo).port,
        },
      });
      clearProbeCache();
      daemon = createDaemonServer({ host: '127.0.0.1' });
      const d = daemon;
      await new Promise<void>((resolve) => {
        d.listen(0, '127.0.0.1', () => resolve());
      });
      const daemonPort = (d.address() as AddressInfo).port;

      // The snapshot dir does not exist in a fresh fixture state dir.
      const snapshotsDir = path.join(fixture.stateDir, 'snapshots');
      expect(fs.existsSync(snapshotsDir)).toBe(false);

      const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/doctor`, {
        headers: { Host: `127.0.0.1:${daemonPort}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        overallStatus: string;
        conditions: Array<{ id: string; state: string; reason?: string; code?: string }>;
      };

      const byId = (id: string) => body.conditions.find((c) => c.id === id);
      expect(byId('c1')?.state).toBe('pass');
      expect(byId('c2')?.state).toBe('pass');
      expect(byId('c3')?.state).toBe('pass');
      expect(byId('c4')?.state).toBe('pass');
      expect(byId('c6')?.state).toBe('pass');

      // c5 stays 'not_checked' (dir legitimately absent on a never-applied machine)
      expect(byId('c5')?.state).toBe('not_checked');
      expect(byId('c5')?.reason).toBe('no_snapshot_dir_yet');
      expect(byId('c5')?.code).toBe('snapshot_dir_missing');

      // ... and it must not make the whole report an error.
      expect(body.overallStatus).not.toBe('error');
      expect(body.overallStatus).toBe('warning');

      // Zero-write: the doctor call still never created the directory.
      expect(fs.existsSync(snapshotsDir)).toBe(false);
    } finally {
      const d = daemon;
      if (d) await new Promise<void>((resolve) => d.close(() => resolve()));
      mockOmni.close();
      mockNine.close();
      fixture?.restore();
    }
  }, 15000);
});
