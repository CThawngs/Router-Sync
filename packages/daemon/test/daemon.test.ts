import { describe, it, expect } from 'vitest';
import { CAPABILITIES, AUTOMATION_LEVELS, generateCapabilityMatrix } from '../src/capability.js';
import { acquireLock, releaseLock, parseLockContent, isPidAlive } from '../src/single-instance.js';
import { buildScheduleArtifacts } from '../../cli/src/commands/schedule.js';
import { createScheduler, jitteredDelay, backoffDelay, readJobLog, setPaused, isPaused } from '../src/scheduler.js';
import { compareFingerprints, verdictAgainstBaseline, hashRows, canonicalRow, type DbFingerprint } from '../src/fence.js';
import { createDaemonServer, checkBearerToken, tokenFileGuidance } from '../src/server.js';
import { createApprovalToken, verifyAndConsumeApprovalToken, resetTokenRegistry } from '../src/security/approval-token.js';
import { FastLoop, type FastLoopOptions } from '../src/loop/fast-loop.js';
import {
  activateFreeze,
  deactivateFreeze,
  verifyAndConsumePersistentApprovalToken,
} from '@routersync/core';
import { DAEMON_FIXTURE_ENV_KEYS, setupDaemonFixture } from '../../../test/harness/daemon-fixture.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (file: string) => {
  exec(sql: string): void;
  close(): void;
};

describe('W4 daemon/schedule/capability', () => {
  it('capability registry ids unique, required ids present', () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['scan', 'diff', 'plan', 'remove', 'add', 'reorder', 'health', 'discover', 'research', 'daemon', 'schedule', 'autoSafe', 'mcpRead', 'mcpPropose']) {
      expect(ids).toContain(id);
    }
    for (const cap of CAPABILITIES) {
      expect(['read', 'propose', 'write']).toContain(cap.risk);
      expect(cap.inSchema.length).toBeGreaterThan(0);
      expect(cap.outSchema.length).toBeGreaterThan(0);
    }
  });

  it('capability matrix: GUI chua noi for all rows', () => {
    const rows = generateCapabilityMatrix();
    expect(rows.length).toBe(CAPABILITIES.length);
    for (const row of rows) {
      expect(row.gui).toBe('chua noi');
      expect(row.guiReason).toContain('C2');
    }
  });

  it('automation levels: observe/propose/auto-safe, no full', () => {
    expect([...AUTOMATION_LEVELS]).toEqual(['observe', 'propose', 'auto-safe']);
    expect(AUTOMATION_LEVELS).not.toContain('full');
  });

  it('schedule artifacts: 3 OS + uninstall, dry-run only', () => {
    const a = buildScheduleArtifacts();
    expect(a.windowsXml).toContain('PT15M');
    expect(a.systemdUnit).toContain('ExecStart');
    expect(a.systemdTimer).toContain('15min');
    expect(a.launchdPlist).toContain('900');
    expect(a.uninstallCommands.length).toBe(3);
    const joined = [a.windowsXml, a.systemdUnit, a.systemdTimer, a.launchdPlist, ...a.uninstallCommands].join('\n');
    expect(joined).not.toContain('schtasks /create');
  });

  it('single-instance lock: acquire, block live pid, stale takeover, release', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routersync-lock-'));
    const lockPath = path.join(dir, 'daemon.lock');
    expect(parseLockContent('not-json')).toBeNull();
    expect(isPidAlive(process.pid)).toBe(true);

    const first = acquireLock(lockPath);
    expect(first.acquired).toBe(true);

    // Re-acquire by another pid while owner alive -> blocked.
    const blocked = acquireLock(lockPath, process.pid + 1_000_000);
    expect(blocked.acquired).toBe(false);

    // Stale: owner pid dead -> takeover succeeds.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2, startedAt: '2020-01-01T00:00:00Z' }) + '\n', 'utf8');
    const stale = acquireLock(lockPath);
    expect(stale.acquired).toBe(true);
    expect(stale.stale).toBe(true);

    releaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scheduler: paused tick logs skipped: paused, resume runs jobs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routersync-pause-'));
    let runs = 0;
    const sched = createScheduler({
      stateDir: dir,
      runJob: async (j) => { runs++; return `${j}:ok`; },
      setTimer: () => null,
      clearTimer: () => {},
    });
    setPaused(true, dir);
    expect(isPaused(dir)).toBe(true);
    await sched.tick();
    expect(runs).toBe(0);
    const log1 = readJobLog(dir);
    expect(log1.some((e) => e.status === 'skipped' && e.summary === 'skipped: paused')).toBe(true);

    sched.resume();
    expect(isPaused(dir)).toBe(false);
    await sched.tick();
    expect(runs).toBeGreaterThan(0);
    const log2 = readJobLog(dir);
    expect(log2.some((e) => e.status === 'ok')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('jitter ±10% and backoff caps at 8x', () => {
    expect(jitteredDelay(1000, () => 0)).toBe(900);
    expect(jitteredDelay(1000, () => 0.999999)).toBe(1100);
    expect(jitteredDelay(1000, () => 0.5)).toBe(1000);
    expect(backoffDelay(0, 1000)).toBe(1000);
    expect(backoffDelay(1, 1000)).toBe(2000);
    expect(backoffDelay(10, 1000)).toBe(8000);
  });

  it('fence SAME/DIFF + hot tables + volatile normalization', () => {
    const a: DbFingerprint = { dbPath: '/x.db', tables: [{ table: 't', count: 1, hash: 'h1' }] };
    const same = compareFingerprints([a], JSON.parse(JSON.stringify([a])) as DbFingerprint[]);
    expect(same.lines[0]?.status).toBe('SAME');

    const diff: DbFingerprint = { dbPath: '/x.db', tables: [{ table: 't', count: 2, hash: 'h2' }] };
    const r = compareFingerprints([a], [diff]);
    expect(r.lines[0]?.status).toBe('DIFF');
    expect(r.lines[0]?.hot).toBe(true); // changed during idle gap => hot

    const v = verdictAgainstBaseline([a], [diff], new Set());
    expect(v.status).toBe('UNVERIFIED');
    expect(v.ok).toBe(false);

    const vHot = verdictAgainstBaseline([a], [diff], new Set(['/x.db#t']));
    expect(vHot.status).toBe('PASS');
    expect(vHot.ok).toBe(true);

    // volatile keys on connection tables masked
    const r1 = canonicalRow('provider_connections', { id: '1', lastTested: 'x', name: 'a' });
    const r2 = canonicalRow('provider_connections', { id: '1', lastTested: 'y', name: 'a' });
    expect(r1).toBe(r2);
    expect(hashRows('t', [{ id: '1' }]).count).toBe(1);
  });

  it('HTTP: 401 missing token, 403 foreign Origin, OPTIONS no CORS, loopback only', async () => {
    const fixture = await setupDaemonFixture();
    try {
    const server = createDaemonServer({ port: 0, token: 'secret-token' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const port = addr.port;

    function req(opts: http.RequestOptions, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
      return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, ...opts, method }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        r.on('error', reject);
        r.end();
      });
    }

    const noToken = await req({ path: '/api/v1/health' });
    expect(noToken.status).toBe(401);

    const foreign = await req({ path: '/api/v1/health', headers: { Authorization: 'Bearer secret-token', Origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();

    const options = await req({ path: '/api/v1/health', headers: { Origin: `http://127.0.0.1:${port}` } }, 'OPTIONS');
    expect(options.status).toBe(204);
    expect(options.headers['access-control-allow-origin']).toBeUndefined();

    const ok = await req({ path: '/api/v1/health', headers: { Authorization: 'Bearer secret-token' } });
    expect([200, 404, 405]).toContain(ok.status);

    expect(checkBearerToken('Bearer secret-token', 'secret-token')).toBe(true);
    expect(checkBearerToken(undefined, 'secret-token')).toBe(false);
    expect(tokenFileGuidance()).toContain('600');

    await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      fixture.restore();
    }
  });
});

describe('M2-02: FastLoop actionable webhook & daemon-fixture env isolation', () => {
  it('M2-02-T2 / AT-127: setupDaemonFixture clears ambient ROUTERSYNC_WEBHOOK_URL and restores on teardown without altering DAEMON_FIXTURE_ENV_KEYS', async () => {
    expect(DAEMON_FIXTURE_ENV_KEYS).not.toContain('ROUTERSYNC_WEBHOOK_URL');
    const prev = process.env['ROUTERSYNC_WEBHOOK_URL'];
    process.env['ROUTERSYNC_WEBHOOK_URL'] = 'http://127.0.0.1:59999/ambient-shell-hook';
    try {
      const fixture = await setupDaemonFixture();
      try {
        expect(process.env['ROUTERSYNC_WEBHOOK_URL']).toBeUndefined();
      } finally {
        fixture.restore();
      }
      expect(process.env['ROUTERSYNC_WEBHOOK_URL']).toBe('http://127.0.0.1:59999/ambient-shell-hook');
    } finally {
      if (prev !== undefined) process.env['ROUTERSYNC_WEBHOOK_URL'] = prev;
      else delete process.env['ROUTERSYNC_WEBHOOK_URL'];
    }
  });

  it('M2-02-T1 & M2-02-T2: FastLoop emits webhook once on drift transition, suppresses consecutive identical drift, and fires again after recovery + new drift', async () => {
    const fixture = await setupDaemonFixture();
    const receivedBodies: Array<Record<string, unknown>> = [];
    let serverStatus = 200;

    const hookServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'POST') {
          try {
            receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
          } catch {
            receivedBodies.push({});
          }
        }
        res.writeHead(serverStatus, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });

    await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    const hookPort = (hookServer.address() as { port: number }).port;

    try {
      const loop = new FastLoop({
        intervalMs: 60_000,
        webhookUrl: `http://127.0.0.1:${hookPort}/fast-hook`,
        webhookTimeoutMs: 2_000,
      } as unknown as FastLoopOptions);

      // Tick 1: Baseline -> 0 alerts, 0 POSTs
      const s1 = await loop.checkOnce();
      expect(s1.driftDetected).toBe(false);
      expect(receivedBodies).toHaveLength(0);

      // Introduce external drift into OmniRoute fixture SQLite DB
      const db1 = new Database(fixture.omniDbPath);
      try {
        db1.exec(
          `INSERT INTO combos (id, name, data) VALUES ('external-drift-1', 'external-drift-1', '{"strategy":"priority","models":["m1","m2"],"managed":false}');`
        );
      } finally {
        db1.close();
      }

      // Tick 2: Initial drift transition -> 1 POST with schemaVersion '1.0'
      const s2 = await loop.checkOnce();
      expect(s2.driftDetected).toBe(true);
      expect(receivedBodies).toHaveLength(1);
      expect(receivedBodies[0]!['schemaVersion']).toBe('1.0');
      expect(receivedBodies[0]!['event']).toBe('routersync.actionable_alert');
      expect(receivedBodies[0]!['source']).toBe('daemon.fast_loop');
      const sum2 = receivedBodies[0]!['summary'] as Record<string, unknown>;
      expect(Number(sum2['driftCount'])).toBeGreaterThanOrEqual(1);
      const alerts2 = receivedBodies[0]!['alerts'] as Array<Record<string, unknown>>;
      expect(alerts2.length).toBeGreaterThanOrEqual(1);
      expect(alerts2[0]!['kind']).toBe('router_drift');

      // Tick 3: Identical consecutive unresolved drift -> suppressed (0 duplicate POSTs)
      const s3 = await loop.checkOnce();
      expect(s3.driftDetected).toBe(true);
      expect(receivedBodies).toHaveLength(1);

      // Tick 4: Recovery back to baseline -> 0 POSTs, resets drift fingerprint
      const dbRecover = new Database(fixture.omniDbPath);
      try {
        dbRecover.exec(`DELETE FROM combos WHERE id = 'external-drift-1';`);
      } finally {
        dbRecover.close();
      }
      const s4 = await loop.checkOnce();
      expect(s4.driftDetected).toBe(false);
      expect(receivedBodies).toHaveLength(1);

      // Tick 5: New drift after recovery -> fires again (total POSTs === 2), even on HTTP 500 non-fatal check
      serverStatus = 500;
      const dbRedrift = new Database(fixture.omniDbPath);
      try {
        dbRedrift.exec(
          `INSERT INTO combos (id, name, data) VALUES ('external-drift-2', 'external-drift-2', '{"strategy":"priority","models":["m3"],"managed":false}');`
        );
      } finally {
        dbRedrift.close();
      }
      const s5 = await loop.checkOnce();
      expect(s5.driftDetected).toBe(true);
      expect(receivedBodies).toHaveLength(2);
      const del5 = (s5 as unknown as Record<string, unknown>)['webhookDelivery'] as
        | Record<string, unknown>
        | undefined;
      expect(del5?.['status']).toBe('failed');
      expect(del5?.['reason']).toBe('http_500');

      // M2-02-T4 in FastLoop: live router port 20128 is rejected with 0 sockets opened
      let rejectedFetchCalls = 0;
      const rejectedLoop = new FastLoop({
        intervalMs: 60_000,
        webhookUrl: 'http://127.0.0.1:20128/v1/models',
        fetchFn: (async () => {
          rejectedFetchCalls++;
          throw new Error('Socket must never open for forbidden router port');
        }) as unknown as typeof globalThis.fetch,
      } as unknown as FastLoopOptions);
      await rejectedLoop.checkOnce();
      const dbReject = new Database(fixture.omniDbPath);
      try {
        dbReject.exec(`DELETE FROM combos WHERE id = 'external-drift-2';`);
      } finally {
        dbReject.close();
      }
      const sReject = await rejectedLoop.checkOnce();
      const delReject = (sReject as unknown as Record<string, unknown>)['webhookDelivery'] as
        | Record<string, unknown>
        | undefined;
      expect(delReject?.['status']).toBe('rejected_url');
      expect(delReject?.['reason']).toBe('forbidden_router_port');
      expect(rejectedFetchCalls).toBe(0);
    } finally {
      await new Promise<void>((resolve) => hookServer.close(() => resolve()));
      fixture.restore();
    }
  });
});

describe('C45-WP4: Cross-Process Approval Token Persistence & Freeze Enforcement', () => {
  it('mirrors daemon approval tokens to <stateDir>/approval-tokens.json and blocks POST /api/v1/changes/approve with 403 write_frozen', async () => {
    const fixture = await setupDaemonFixture();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp4-daemon-state-'));
    const prevState = process.env['ROUTERSYNC_STATE_DIR'];
    process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
    resetTokenRegistry();

    const server = createDaemonServer({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const issued = createApprovalToken('plan-hash-wp4-cross-proc');
      expect(fs.existsSync(path.join(stateDir, 'approval-tokens.json'))).toBe(true);

      // Consume cross-process via @routersync/core store -> subsequent daemon verify must detect replay!
      const crossConsume = verifyAndConsumePersistentApprovalToken(
        stateDir,
        issued.token,
        'plan-hash-wp4-cross-proc'
      );
      expect(crossConsume).toEqual({ valid: true });
      expect(verifyAndConsumeApprovalToken(issued.token, 'plan-hash-wp4-cross-proc')).toEqual({
        valid: false,
        reason: 'token_already_consumed',
      });

      // Freeze blocks HTTP approval endpoint with 403 write_frozen
      const issued2 = createApprovalToken('plan-hash-wp4-frozen');
      activateFreeze(stateDir, 'daemon-freeze-check');
      const resFrozen = await fetch(`http://127.0.0.1:${port}/api/v1/changes/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planHash: 'plan-hash-wp4-frozen', token: issued2.token }),
      });
      expect(resFrozen.status).toBe(403);
      const bodyFrozen = (await resFrozen.json()) as Record<string, any>;
      expect(bodyFrozen['meta']?.['reason']).toBe('write_frozen');
      expect(bodyFrozen['approved']).toBe(false);

      // Unfreeze restores token usability (not consumed while frozen!)
      deactivateFreeze(stateDir);
      const resOk = await fetch(`http://127.0.0.1:${port}/api/v1/changes/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planHash: 'plan-hash-wp4-frozen', token: issued2.token }),
      });
      expect(resOk.status).toBe(200);
    } finally {
      resetTokenRegistry();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevState !== undefined) process.env['ROUTERSYNC_STATE_DIR'] = prevState;
      else delete process.env['ROUTERSYNC_STATE_DIR'];
      fixture.restore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
