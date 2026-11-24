/**
 * packages/core/test/wp7-tick-gate-and-harness-schedule.test.ts
 *
 * C45-WP7 Red-First Unit Tests (Phục vụ: S6, S7):
 *  - 15-minute `evaluateTickFreshness` boundary (14m59s skip vs 15m00s due)
 *  - Exclusive `<stateDir>/tick.lock` contention (including same-PID non-reentrancy) + stale lock recovery
 *  - Cross-UID `EPERM` (e.g. Linux `pid: 2` `[kthreadd]`) stale lock takeover while live `process.pid` / child PID still blocks (M2)
 *  - 9-harness 4-tier schedule ladder resolution driven by `harness-matrix.json`
 *  - Non-destructive snippet emission (`jobs.json` & `openmausbot/routines.json` untouched)
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TICK_GATE_MS,
  STALE_LOCK_MAX_AGE_MS,
  SCHEDULE_LADDER_TIERS,
  emitHarnessNativeSnippets,
  evaluateTickFreshness,
  isProcessAlive,
  listHarnessLadderEntries,
  releaseTickLock,
  tryAcquireTickLock,
  updateTickLockOwner,
  loadHarnessMatrix,
} from '../src/index.js';

describe('C45-WP7: Shared 15-Minute Tick Gate & Exclusive Lock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp7-gate-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('evaluates missing or corrupt status.json as due without creating any files', () => {
    const missingStateDir = path.join(tmpDir, 'nonexistent-state');
    const resMissing = evaluateTickFreshness(missingStateDir, 1_700_000_000_000);
    expect(resMissing).toEqual({
      due: true,
      reason: 'missing_status',
      lastTickAt: null,
      ageMs: null,
    });
    expect(fs.existsSync(missingStateDir)).toBe(false);

    fs.mkdirSync(missingStateDir, { recursive: true });
    fs.writeFileSync(path.join(missingStateDir, 'status.json'), '{not-valid-json', 'utf8');
    const resCorrupt = evaluateTickFreshness(missingStateDir, 1_700_000_000_000);
    expect(resCorrupt.due).toBe(true);
    expect(resCorrupt.reason).toBe('missing_status');
  });

  it('enforces exact 15m freshness boundary: 14m59s is fresh (skip), 15m00s is stale (due)', () => {
    expect(DEFAULT_TICK_GATE_MS).toBe(15 * 60 * 1000);
    const baseMs = Date.parse('2026-11-24T12:00:00.000Z');
    fs.writeFileSync(
      path.join(tmpDir, 'status.json'),
      JSON.stringify({ timestamp: new Date(baseMs).toISOString(), mode: 'observe' }),
      'utf8'
    );

    // 14m59s = 899,000 ms -> NOT due (kills M2 if gate weakened to ageMs >= 0)
    const freshCheck = evaluateTickFreshness(tmpDir, baseMs + 14 * 60_000 + 59_000);
    expect(freshCheck).toEqual({
      due: false,
      reason: 'fresh',
      lastTickAt: '2026-11-24T12:00:00.000Z',
      ageMs: 899_000,
    });

    // 15m00s = 900,000 ms -> due
    const dueCheck = evaluateTickFreshness(tmpDir, baseMs + 15 * 60_000);
    expect(dueCheck).toEqual({
      due: true,
      reason: 'stale_status',
      lastTickAt: '2026-11-24T12:00:00.000Z',
      ageMs: 900_000,
    });

    // Also supports generatedAt timestamp alias
    const stateDirAlt = path.join(tmpDir, 'alt');
    fs.mkdirSync(stateDirAlt, { recursive: true });
    fs.writeFileSync(
      path.join(stateDirAlt, 'status.json'),
      JSON.stringify({ generatedAt: new Date(baseMs).toISOString() }),
      'utf8'
    );
    expect(evaluateTickFreshness(stateDirAlt, baseMs + 60_000).due).toBe(false);
    expect(evaluateTickFreshness(stateDirAlt, baseMs + 900_000).due).toBe(true);
  });

  it('blocks concurrent lock acquisition even from the same process.pid and recovers dead/aged locks', () => {
    expect(STALE_LOCK_MAX_AGE_MS).toBe(10 * 60 * 1000);
    const nowMs = Date.parse('2026-11-24T12:00:00.000Z');

    const first = tryAcquireTickLock(tmpDir, process.pid, nowMs, () => true);
    expect(first.acquired).toBe(true);
    expect(first.staleRecovered).toBe(false);
    expect(first.holderPid).toBe(process.pid);

    // Same process.pid trying to re-acquire active lock MUST be rejected (kills M2)
    const samePidContention = tryAcquireTickLock(tmpDir, process.pid, nowMs + 5_000, () => true);
    expect(samePidContention.acquired).toBe(false);
    expect(samePidContention.holderPid).toBe(process.pid);

    // Different live PID contention -> rejected
    const otherPidContention = tryAcquireTickLock(tmpDir, 99991, nowMs + 5_000, () => true);
    expect(otherPidContention.acquired).toBe(false);
    expect(otherPidContention.holderPid).toBe(process.pid);

    // Dead PID -> stale lock recovered
    const deadRecovery = tryAcquireTickLock(tmpDir, 42424, nowMs + 10_000, (pid) => pid === 42424);
    expect(deadRecovery.acquired).toBe(true);
    expect(deadRecovery.staleRecovered).toBe(true);
    expect(deadRecovery.holderPid).toBe(42424);

    // Aged lock (> 10m STALE_LOCK_MAX_AGE_MS) -> recovered even if PID appears alive
    const agedRecovery = tryAcquireTickLock(
      tmpDir,
      53535,
      nowMs + 10_000 + STALE_LOCK_MAX_AGE_MS + 1_000,
      () => true
    );
    expect(agedRecovery.acquired).toBe(true);
    expect(agedRecovery.staleRecovered).toBe(true);
    expect(agedRecovery.holderPid).toBe(53535);

    // Update owner to child PID and verify release only unlinks matching PID
    updateTickLockOwner(tmpDir, 77777, nowMs + 20_000);
    releaseTickLock(tmpDir, 11111);
    expect(fs.existsSync(path.join(tmpDir, 'tick.lock'))).toBe(true);

    releaseTickLock(tmpDir, 77777);
    expect(fs.existsSync(path.join(tmpDir, 'tick.lock'))).toBe(false);
  });

  it('treats cross-UID EPERM (e.g. Linux pid:2 kthreadd) as stale while blocking live process.pid and live child PIDs (preserves M2)', () => {
    const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
    const lockPath = path.join(tmpDir, 'tick.lock');

    // 1. Live process.pid via real default isProcessAlive MUST block lock takeover (M2)
    expect(isProcessAlive(process.pid)).toBe(true);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date(nowMs).toISOString() }) + '\n',
      'utf8'
    );
    const blockedBySelf = tryAcquireTickLock(tmpDir, process.pid, nowMs + 1_000);
    expect(blockedBySelf.acquired).toBe(false);
    expect(blockedBySelf.holderPid).toBe(process.pid);

    // 2. Live child process owned by current user MUST be detected alive and block takeover (M2)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
    });
    try {
      expect(typeof child.pid).toBe('number');
      const childPid = child.pid!;
      expect(isProcessAlive(childPid)).toBe(true);
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: childPid, startedAt: new Date(nowMs).toISOString() }) + '\n',
        'utf8'
      );
      const blockedByChild = tryAcquireTickLock(tmpDir, process.pid, nowMs + 1_000);
      expect(blockedByChild.acquired).toBe(false);
      expect(blockedByChild.holderPid).toBe(childPid);
    } finally {
      child.kill();
    }

    // 3. Simulated Linux kthreadd / cross-UID EPERM on pid: 2 MUST NOT block stale takeover
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === 2) {
        const eperm = new Error('kill EPERM') as NodeJS.ErrnoException;
        eperm.code = 'EPERM';
        throw eperm;
      }
      return realKill(pid, signal as NodeJS.Signals | number | undefined);
    }) as typeof process.kill);

    expect(isProcessAlive(2)).toBe(false);

    // Both aged ('2020-01-01T00:00:00Z') and recent (nowMs - 1_000) foreign-UID pid:2 locks must be taken over cleanly
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2, startedAt: '2020-01-01T00:00:00Z' }) + '\n',
      'utf8'
    );
    const takeoverAged = tryAcquireTickLock(tmpDir, process.pid, nowMs);
    expect(takeoverAged.acquired).toBe(true);
    expect(takeoverAged.staleRecovered).toBe(true);
    expect(takeoverAged.holderPid).toBe(process.pid);

    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2, startedAt: new Date(nowMs - 1_000).toISOString() }) + '\n',
      'utf8'
    );
    const takeoverFreshForeignUid = tryAcquireTickLock(tmpDir, process.pid, nowMs);
    expect(takeoverFreshForeignUid.acquired).toBe(true);
    expect(takeoverFreshForeignUid.staleRecovered).toBe(true);
    expect(takeoverFreshForeignUid.holderPid).toBe(process.pid);

    releaseTickLock(tmpDir, process.pid);
  });
});

describe('C45-WP7: 9-Harness 4-Tier Schedule Ladder Resolution', () => {
  it('resolves all 9 harnesses strictly from harness-matrix.json (only hermes & antigravity enter Tier 1)', () => {
    expect(SCHEDULE_LADDER_TIERS).toEqual([
      'harness-native',
      'os-scheduler',
      'tick-if-due',
      'daemon',
    ]);

    const matrix = loadHarnessMatrix();
    const entries = listHarnessLadderEntries({
      intervalMinutes: 15,
      nodePath: '/usr/bin/node',
      cliEntryPath: '/opt/routersync/packages/cli/dist/index.js',
      mode: 'propose',
    });

    expect(entries.map((e) => e.harnessId)).toEqual(matrix.harnesses.map((h) => h.id));
    expect(entries).toHaveLength(9);

    const tier1Ids = entries.filter((e) => e.primaryTier === 'harness-native').map((e) => e.harnessId);
    expect(tier1Ids).toEqual(['hermes', 'antigravity']);

    for (const entry of entries) {
      if (entry.harnessId === 'hermes') {
        expect(entry.zeroTokenScriptCapable).toBe(true);
        expect(entry.harnessNativeSupported).toBe(true);
        expect(entry.assets?.kind).toBe('hermes-script-cron');
        expect(entry.assets?.cronJobSnippetJson).toContain('"no_agent": true');
        expect(entry.assets?.posixScript).toContain('tick');
        expect(entry.assets?.powershellScript).toContain('tick');
      } else if (entry.harnessId === 'antigravity') {
        expect(entry.zeroTokenScriptCapable).toBe(true);
        expect(entry.harnessNativeSupported).toBe(true);
        expect(entry.assets?.kind).toBe('antigravity-schedule-sidecar');
        expect(entry.assets?.sidecarSnippetJson).toContain('"builtin": "schedule"');
        expect(entry.assets?.optInSettingKey).toBe('sidecars.routersync-tick.enabled');
      } else {
        // Kills M1 if zeroTokenScriptCapable guard is flipped to schedulerType !== 'none'
        expect(entry.zeroTokenScriptCapable).toBe(false);
        expect(entry.harnessNativeSupported).toBe(false);
        expect(entry.primaryTier).toBe('os-scheduler');
        expect(entry.fallbackTiers).toEqual(['tick-if-due', 'daemon']);
        expect(entry.assets).toBeNull();
        expect(entry.reason.length).toBeGreaterThan(20);
        if (entry.harnessId === 'openmausbot') {
          expect(entry.reason).toContain('routines.json');
        }
      }
    }
  });

  it('emits non-destructive Hermes & Antigravity snippet files without overwriting jobs.json or routines.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp7-snippets-'));
    try {
      const hermesHome = path.join(tmp, 'hermes-home');
      fs.mkdirSync(path.join(hermesHome, 'cron'), { recursive: true });
      const liveJobsPath = path.join(hermesHome, 'cron', 'jobs.json');
      const originalJobs = JSON.stringify({ jobs: [{ id: 'user-existing-job' }] });
      fs.writeFileSync(liveJobsPath, originalJobs, 'utf8');

      const openmausbotDir = path.join(tmp, 'openmausbot');
      fs.mkdirSync(openmausbotDir, { recursive: true });
      const routinesPath = path.join(openmausbotDir, 'routines.json');
      fs.writeFileSync(routinesPath, '{"routines":[]}', 'utf8');

      const hermesEmit = emitHarnessNativeSnippets('hermes', hermesHome, {
        intervalMinutes: 15,
        nodePath: '/usr/bin/node',
        cliEntryPath: '/opt/rs/index.js',
      });
      expect(hermesEmit.writtenFiles.length).toBe(3);
      expect(fs.existsSync(path.join(hermesHome, 'scripts', 'routersync-tick.sh'))).toBe(true);
      expect(fs.existsSync(path.join(hermesHome, 'scripts', 'routersync-tick.ps1'))).toBe(true);
      expect(fs.existsSync(path.join(hermesHome, 'scripts', 'routersync-cron-job.snippet.json'))).toBe(true);
      // Safety lock: existing cron/jobs.json untouched byte-for-byte
      expect(fs.readFileSync(liveJobsPath, 'utf8')).toBe(originalJobs);

      const agyDir = path.join(tmp, 'agy-schedules');
      const agyEmit = emitHarnessNativeSnippets('antigravity', agyDir, {
        intervalMinutes: 15,
        nodePath: '/usr/bin/node',
        cliEntryPath: '/opt/rs/index.js',
      });
      expect(agyEmit.writtenFiles).toEqual([path.join(agyDir, 'antigravity-sidecar.snippet.json')]);

      const ombEmit = emitHarnessNativeSnippets('openmausbot', openmausbotDir);
      expect(ombEmit.writtenFiles).toEqual([]);
      expect(fs.readFileSync(routinesPath, 'utf8')).toBe('{"routines":[]}');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
