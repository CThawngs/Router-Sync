import { describe, it, expect } from 'vitest';
import { CAPABILITIES, AUTOMATION_LEVELS, generateCapabilityMatrix } from '../src/capability.js';
import { acquireLock, releaseLock, parseLockContent, isPidAlive } from '../src/single-instance.js';
import { buildScheduleArtifacts } from '../../cli/src/commands/schedule.js';
import { createScheduler, jitteredDelay, backoffDelay, readJobLog, setPaused, isPaused } from '../src/scheduler.js';
import { compareFingerprints, verdictAgainstBaseline, hashRows, canonicalRow, type DbFingerprint } from '../src/fence.js';
import { createDaemonServer, checkBearerToken, tokenFileGuidance } from '../src/server.js';
import { setupDaemonFixture } from '../../../test/harness/daemon-fixture.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

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
