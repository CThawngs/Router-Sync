/**
 * test/acceptance/at-127-hermetic-guard.test.ts
 *
 * Acceptance Test AT-127: Hermetic Daemon Test Guard (R11-0.3).
 *
 * Background (R11-0 DISCREPANCY): `r10-at123-red` showed that a daemon test
 * started with the default configuration read the owner's REAL router
 * databases and probed the REAL router ports 20128/30128. AT-127 locks the
 * guard in test/harness/daemon-fixture.ts:
 *
 *  - green: a correctly wired setupDaemonFixture() env passes the guard;
 *  - red paths: a deleted env override, a DB/config path resolving outside
 *    os.tmpdir(), or a probe URL on a real router port each make the guard
 *    throw.
 *
 * Mutation contract (r11-at127-red): deleting ONE env assignment inside the
 * harness (snapshotAndApplyEnv) must turn the green case RED, because the
 * guard treats a missing override as a fall-back-to-real-state hazard.
 *
 * This test never touches ports 20128/30128 and never reads real router
 * state: the "real port" case is rejected by the guard before any connection.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  assertDaemonEnvIsHermetic,
  isHermeticProbeUrl,
  isPathUnderTmpDir,
  setupDaemonFixture,
  type DaemonFixture,
} from '../harness/daemon-fixture.js';

describe('Acceptance Test AT-127: Hermetic Daemon Test Guard (R11-0.3)', () => {
  let fixture: DaemonFixture | undefined;

  afterAll(() => {
    fixture?.restore();
  });

  it('green: setupDaemonFixture() env passes assertDaemonEnvIsHermetic()', async () => {
    fixture = await setupDaemonFixture();

    // Every override is explicit, tmp-bound, and free of real router ports.
    expect(() => assertDaemonEnvIsHermetic()).not.toThrow();

    expect(isPathUnderTmpDir(fixture.configPath)).toBe(true);
    expect(isPathUnderTmpDir(fixture.omniDbPath)).toBe(true);
    expect(isPathUnderTmpDir(fixture.nineDbPath)).toBe(true);
    expect(isPathUnderTmpDir(fixture.stateDir)).toBe(true);
    expect(isHermeticProbeUrl(fixture.omniProbeUrl)).toBe(true);
    expect(isHermeticProbeUrl(fixture.nineProbeUrl)).toBe(true);
  });

  it('red path: deleting ONE env override makes the guard throw', async () => {
    if (!fixture) fixture = await setupDaemonFixture();
    const original = process.env['NINEROUTER_URL'];
    delete process.env['NINEROUTER_URL'];
    try {
      expect(() => assertDaemonEnvIsHermetic()).toThrow(/NINEROUTER_URL is not set/);
    } finally {
      if (original !== undefined) process.env['NINEROUTER_URL'] = original;
    }
  });

  it('red path: DB path resolving outside os.tmpdir() is rejected', async () => {
    if (!fixture) fixture = await setupDaemonFixture();
    // An existing file: provably real-filesystem, provably not under tmp.
    const repoFile = path.resolve(process.cwd(), 'package.json');
    const outsideTmp = isPathUnderTmpDir(repoFile) ? process.execPath : repoFile;
    const original = process.env['OMNIROUTE_DB_PATH'];
    process.env['OMNIROUTE_DB_PATH'] = outsideTmp;
    try {
      expect(isPathUnderTmpDir(outsideTmp)).toBe(false);
      expect(() => assertDaemonEnvIsHermetic()).toThrow(/OMNIROUTE_DB_PATH/);
    } finally {
      if (original !== undefined) process.env['OMNIROUTE_DB_PATH'] = original;
    }
  });

  it('red path: probe URL on real router port 20128/30128 is rejected before any connection', async () => {
    if (!fixture) fixture = await setupDaemonFixture();
    const original = process.env['OMNIROUTE_URL'];
    for (const port of [20128, 30128]) {
      process.env['OMNIROUTE_URL'] = `http://127.0.0.1:${port}`;
      expect(isHermeticProbeUrl(process.env['OMNIROUTE_URL'] as string)).toBe(false);
      expect(() => assertDaemonEnvIsHermetic()).toThrow(/real router port|forbidden/);
    }
    try {
      // loopback + ephemeral port stays allowed (used by AT-125 mock servers)
      expect(isHermeticProbeUrl('http://127.0.0.1:49152')).toBe(true);
    } finally {
      if (original !== undefined) process.env['OMNIROUTE_URL'] = original;
    }
  });

  it('red path: config file outside os.tmpdir() is rejected', async () => {
    if (!fixture) fixture = await setupDaemonFixture();
    const repoFile = path.resolve(process.cwd(), 'tsconfig.json');
    const outsideTmp = isPathUnderTmpDir(repoFile) ? process.execPath : repoFile;
    const original = process.env['ROUTERSYNC_CONFIG'];
    process.env['ROUTERSYNC_CONFIG'] = outsideTmp;
    try {
      expect(() => assertDaemonEnvIsHermetic()).toThrow(/ROUTERSYNC_CONFIG/);
    } finally {
      if (original !== undefined) process.env['ROUTERSYNC_CONFIG'] = original;
    }
  });

  it('static analysis: all tests creating or starting daemon server MUST call setupDaemonFixture (R12-4)', () => {
    function findTsFiles(dir: string): string[] {
      if (!fs.existsSync(dir)) return [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...findTsFiles(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const testRoots = [
      path.resolve(process.cwd(), 'test'),
      path.resolve(process.cwd(), 'packages'),
    ];

    const allTsFiles: string[] = [];
    allTsFiles.push(...findTsFiles(testRoots[0]!));

    // For packages, only scan packages/*/test
    const pkgsDir = testRoots[1]!;
    if (fs.existsSync(pkgsDir)) {
      for (const pkg of fs.readdirSync(pkgsDir, { withFileTypes: true })) {
        if (pkg.isDirectory()) {
          allTsFiles.push(...findTsFiles(path.join(pkgsDir, pkg.name, 'test')));
        }
      }
    }

    // Allowlist: solely at-122-live.test.ts (gate ROUTERSYNC_LIVE_RO=1, human-run on live routers)
    const ALLOWLIST = new Set([
      path.resolve(process.cwd(), 'test/acceptance/at-122-live.test.ts'),
    ]);

    const violations: string[] = [];
    for (const file of allTsFiles) {
      if (ALLOWLIST.has(path.resolve(file))) continue;
      const content = fs.readFileSync(file, 'utf8');
      const usesDaemon =
        content.includes('createDaemonServer(') || content.includes('startDaemonServer(');
      if (usesDaemon && !content.includes('setupDaemonFixture(')) {
        violations.push(path.relative(process.cwd(), file).replace(/\\/g, '/'));
      }
    }

    expect(
      violations,
      `Tests using createDaemonServer/startDaemonServer without setupDaemonFixture: ${violations.join(', ')}`
    ).toEqual([]);
  });
});
