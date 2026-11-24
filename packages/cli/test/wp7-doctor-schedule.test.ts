/**
 * packages/cli/test/wp7-doctor-schedule.test.ts
 *
 * C45-WP7 Red-First Doctor Diagnostics Tests (Phục vụ: S6):
 *  - Backward-compatible `DoctorReport` top-level fields + extended `schedule` + 9 `harnessSchedules`
 *  - Read-only Tier 1..4 schedule detection in isolated `os.tmpdir()`
 *  - Exact `> 2x` stale-tick warning boundary (`29m` & `30m` clean vs `31m` warning on `15m` interval — kills M3)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearConfiguredRouterDbPaths,
  loadHarnessMatrix,
  setConfiguredRouterDbPaths,
} from '@routersync/core';
import { runDoctorCommand } from '../src/commands/doctor.js';

describe('C45-WP7: routersync doctor Schedule Ladder & Stale-Tick Diagnostics', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp7-doctor-'));
    setConfiguredRouterDbPaths({
      '9router': path.join(tmpDir, 'isolated-9router.sqlite'),
      omniroute: path.join(tmpDir, 'isolated-omniroute.sqlite'),
    });
  });

  afterEach(() => {
    clearConfiguredRouterDbPaths();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports all 9 harnessSchedules in canonical matrix order with zero disk mutations', async () => {
    const homeDir = path.join(tmpDir, 'home');
    const tickStateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(tickStateDir, { recursive: true });

    const beforeHome = fs.readdirSync(homeDir);
    const report = await runDoctorCommand({
      configPath: path.join(tmpDir, 'missing-config.yaml'),
      homeDir,
      tickStateDir,
      probeOsScheduleFn: () => ({ installed: false, detail: '' }),
      json: true,
      silent: true,
    });
    expect(fs.readdirSync(homeDir)).toEqual(beforeHome);

    const matrix = loadHarnessMatrix();
    expect(report.harnessSchedules).toHaveLength(9);
    expect(report.harnessSchedules.map((h) => h.harnessId)).toEqual(
      matrix.harnesses.map((h) => h.id)
    );

    const nativeCapable = report.harnessSchedules
      .filter((h) => h.zeroTokenNativeCapable)
      .map((h) => h.harnessId);
    expect(nativeCapable).toEqual(['hermes', 'antigravity']);
    expect(report.schedule.activeTier).toBe('none');
    expect(report.schedule.configuredIntervalMinutes).toBe(15);
    expect(report.schedule.staleThresholdMinutes).toBe(30);
  });

  it('enforces exact > 2x stale-tick threshold: 29m and 30m clean, 31m triggers staleTickWarning + recommendation (kills M3)', async () => {
    const homeDir = path.join(tmpDir, 'home');
    const tickStateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(path.join(homeDir, '.hermes', 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.hermes', 'scripts', 'routersync-tick.sh'),
      '#!/bin/sh\n',
      'utf8'
    );
    fs.mkdirSync(tickStateDir, { recursive: true });

    const baseMs = Date.parse('2026-11-24T12:00:00.000Z');
    fs.writeFileSync(
      path.join(tickStateDir, 'status.json'),
      JSON.stringify({ timestamp: new Date(baseMs).toISOString(), mode: 'propose' }),
      'utf8'
    );

    // 29 minutes old (<= 30m threshold on 15m interval) -> NOT stale
    const r29 = await runDoctorCommand({
      configPath: path.join(tmpDir, 'missing.yaml'),
      homeDir,
      tickStateDir,
      probeOsScheduleFn: () => ({ installed: false, detail: '' }),
      nowMs: baseMs + 29 * 60_000,
      silent: true,
    });
    expect(r29.schedule.installed).toBe(true);
    expect(r29.schedule.activeTier).toBe('harness-native');
    expect(r29.schedule.lastTickAgeMinutes).toBe(29);
    expect(r29.schedule.staleTickWarning).toBe(false);

    // Exact 30 minutes old (=== 2x, NOT strictly > 2x) -> NOT stale
    const r30 = await runDoctorCommand({
      configPath: path.join(tmpDir, 'missing.yaml'),
      homeDir,
      tickStateDir,
      probeOsScheduleFn: () => ({ installed: false, detail: '' }),
      nowMs: baseMs + 30 * 60_000,
      silent: true,
    });
    expect(r30.schedule.staleTickWarning).toBe(false);

    // 31 minutes old (> 30m threshold, ~2.07x overdue) -> MUST warn (kills M3 if threshold changed to 10x or false)
    const r31 = await runDoctorCommand({
      configPath: path.join(tmpDir, 'missing.yaml'),
      homeDir,
      tickStateDir,
      probeOsScheduleFn: () => ({ installed: false, detail: '' }),
      nowMs: baseMs + 31 * 60_000,
      silent: true,
    });
    expect(r31.schedule.lastTickAgeMinutes).toBe(31);
    expect(r31.schedule.staleTickWarning).toBe(true);
    expect(
      r31.recommendations.some(
        (rec) => rec.includes('31') && rec.includes('30') && /schedule install|routersync tick/i.test(rec)
      )
    ).toBe(true);
  });

  it('honors explicit policy.schedule.sync ("every 1h" -> 120m threshold) and detects OS / daemon tiers', async () => {
    const homeDir = path.join(tmpDir, 'home');
    const tickStateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(tickStateDir, { recursive: true });

    const cfgPath = path.join(tmpDir, 'routersync.yaml');
    fs.writeFileSync(
      cfgPath,
      [
        'version: 1',
        'routers:',
        '  - id: nine',
        '    adapter: 9router',
        'policy:',
        '  mode: manual',
        '  schedule:',
        '    sync: every 1h',
        '',
      ].join('\n'),
      'utf8'
    );

    const baseMs = Date.parse('2026-11-24T12:00:00.000Z');
    fs.writeFileSync(
      path.join(tickStateDir, 'status.json'),
      JSON.stringify({ timestamp: new Date(baseMs).toISOString() }),
      'utf8'
    );
    // Live daemon.lock owned by current process.pid
    fs.writeFileSync(
      path.join(tickStateDir, 'daemon.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date(baseMs).toISOString() }),
      'utf8'
    );

    const r119 = await runDoctorCommand({
      configPath: cfgPath,
      homeDir,
      tickStateDir,
      probeOsScheduleFn: () => ({ installed: false, detail: '' }),
      nowMs: baseMs + 119 * 60_000,
      silent: true,
    });
    expect(r119.schedule.activeTier).toBe('daemon');
    expect(r119.schedule.configuredIntervalMinutes).toBe(60);
    expect(r119.schedule.staleThresholdMinutes).toBe(120);
    expect(r119.schedule.staleTickWarning).toBe(false);

    const r125 = await runDoctorCommand({
      configPath: cfgPath,
      homeDir,
      tickStateDir,
      probeOsScheduleFn: () => ({ installed: false, detail: '' }),
      nowMs: baseMs + 125 * 60_000,
      silent: true,
    });
    expect(r125.schedule.staleTickWarning).toBe(true);
  });
});
