/**
 * packages/core/test/assert-not-live.test.ts
 *
 * Unit tests for the live-DB safety rails (Gate R / T3-14):
 *  - isSameDbFile: canonical path, case (win), realpath, symlink, junction (win),
 *    hardlink (dev/ino), 8.3 short names (win, best-effort), nonexistent paths.
 *  - assertNotLiveRouterDb: refuses live paths from default locations,
 *    environment variables, and routersync.yaml db_path entries.
 *  - openBetterSqlite3: direct write on a live DB throws unless the adapter
 *    flag allowLiveDbWrite is passed.
 *
 * Platform notes: Windows-specific cases (case-insensitivity, junction, 8.3)
 * are guarded by process.platform and SKIPPED with a reason elsewhere.
 * Everything else is platform-neutral (POSIX variant for Gate X).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  isSameDbFile,
  assertNotLiveRouterDb,
  openBetterSqlite3,
  locateRouterDb,
  setDefaultRestrictDir,
} from '../src/index.js';

const ENV_KEYS = [
  'OMNIROUTE_DB_PATH', 'OMNIROUTE_HOME', 'OMNIROUTE_DATA_DIR',
  'NINEROUTER_DB_PATH', 'NINE_ROUTER_DB_PATH',
  'NINEROUTER_DATA_DIR', 'NINE_ROUTER_DATA_DIR',
];

const symlinkCapability = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_symlink_cap_'));
  const probeTarget = path.join(probeDir, 'target.txt');
  const probeLink = path.join(probeDir, 'link.txt');
  try {
    fs.writeFileSync(probeTarget, 'probe');
    fs.symlinkSync(probeTarget, probeLink);
    return { ok: true, reason: '' };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code || 'UNKNOWN';
    return { ok: false, reason: `symlink creation not permitted on this environment (${code})` };
  } finally {
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
  }
})();

describe('live-DB safety rails (assertNotLiveRouterDb / isSameDbFile)', () => {
  let tmpDir: string;
  let liveDb: string;
  let otherDb: string;
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_assert_live_'));
    liveDb = path.join(tmpDir, 'live.sqlite');
    otherDb = path.join(tmpDir, 'other.sqlite');
    for (const p of [liveDb, otherDb]) {
      const db = openBetterSqlite3(p, { readOnly: false });
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      db.close();
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    try { process.chdir(originalCwd); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('isSameDbFile', () => {
    it('same file via different path spellings', () => {
      expect(isSameDbFile(liveDb, liveDb)).toBe(true);
      expect(isSameDbFile(liveDb, path.join(tmpDir, '.', 'live.sqlite'))).toBe(true);
      expect(isSameDbFile(liveDb, path.resolve(liveDb))).toBe(true);
    });

    it('different files are not the same', () => {
      expect(isSameDbFile(liveDb, otherDb)).toBe(false);
    });

    it('never conflates distinct files that share a directory (win32 file index keeps full precision)', () => {
      const names = Array.from({ length: 64 }, (_, i) => path.join(tmpDir, `bulk-${i}.sqlite`));
      for (const p of names) fs.writeFileSync(p, 'x');
      const conflated: string[] = [];
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          if (isSameDbFile(names[i]!, names[j]!)) conflated.push(`${names[i]} == ${names[j]}`);
        }
      }
      expect(conflated).toEqual([]);
    });

    it('nonexistent paths do not throw and are not the same as existing files', () => {
      const ghost = path.join(tmpDir, 'ghost.sqlite');
      expect(() => isSameDbFile(ghost, liveDb)).not.toThrow();
      expect(isSameDbFile(ghost, liveDb)).toBe(false);
      expect(isSameDbFile(ghost, ghost)).toBe(true); // canonical string equality
    });

    it('hardlink to the same inode is the same file (dev/ino)', () => {
      const link = path.join(tmpDir, 'live-link.sqlite');
      fs.linkSync(liveDb, link);
      expect(isSameDbFile(liveDb, link)).toBe(true);
    });

    it(
      `symlink resolves to the same file${symlinkCapability.ok ? '' : ` (skipped: ${symlinkCapability.reason})`}`,
      (ctx) => {
        if (!symlinkCapability.ok) {
          console.info(`[skip] symlink: ${symlinkCapability.reason}`);
          ctx.skip();
        }
        const link = path.join(tmpDir, 'live-symlink.sqlite');
        fs.symlinkSync(liveDb, link);
        expect(isSameDbFile(liveDb, link)).toBe(true);
      }
    );

    it.skipIf(process.platform !== 'win32')('Windows: case differences resolve to the same file', () => {
      const upper = liveDb.toUpperCase();
      if (upper === liveDb) return; // already uppercase, nothing to compare
      expect(isSameDbFile(liveDb, upper)).toBe(true);
    });

    it.skipIf(process.platform !== 'win32')('Windows: 8.3 short name resolves to the same file', () => {
      // Long filename so NTFS generates an 8.3 alias (when 8.3 generation is on)
      const longName = path.join(tmpDir, 'a-very-long-router-database-name-for-83-testing.sqlite');
      fs.copyFileSync(liveDb, longName);
      let short: string | null = null;
      try {
        const out = execSync(`cmd /c for %I in ("${longName}") do @echo %~sI`, { encoding: 'utf8' }).trim();
        if (out && out !== longName && fs.existsSync(out)) short = out;
      } catch { /* 8.3 unavailable */ }
      if (!short) {
        console.log('[SKIP] 8.3 short name not available on this volume');
        return;
      }
      expect(isSameDbFile(longName, short)).toBe(true);
    });

    it.skipIf(process.platform !== 'win32')('Windows: directory junction resolves to the same file', () => {
      const realDir = path.join(tmpDir, 'realdir');
      const junctionDir = path.join(tmpDir, 'junctiondir');
      fs.mkdirSync(realDir);
      const fileInReal = path.join(realDir, 'live.sqlite');
      fs.copyFileSync(liveDb, fileInReal);
      try {
        execSync(`cmd /c mklink /J "${junctionDir}" "${realDir}"`, { stdio: 'ignore' });
      } catch {
        console.log('[SKIP] junction creation unavailable');
        return;
      }
      const viaJunction = path.join(junctionDir, 'live.sqlite');
      expect(isSameDbFile(fileInReal, viaJunction)).toBe(true);
    });
  });

  describe('assertNotLiveRouterDb', () => {
    it('refuses the default 9Router live DB path', () => {
      const live9 = locateRouterDb('9router');
      expect(() => assertNotLiveRouterDb(live9)).toThrow(/Refusing to write backup/);
    });

    it('refuses a live path registered via environment variable', () => {
      process.env['NINEROUTER_DB_PATH'] = liveDb;
      expect(() => assertNotLiveRouterDb(liveDb)).toThrow(/Refusing to write backup/);
    });

    it('refuses a live path registered via routersync.yaml db_path in CWD', () => {
      const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_cfg_cwd_'));
      fs.writeFileSync(
        path.join(cfgDir, 'routersync.yaml'),
        `version: 1\nrouters:\n  - id: nine\n    adapter: 9router\n    db:\n      path: ${liveDb}\n`,
        'utf8'
      );
      process.chdir(cfgDir);
      expect(() => assertNotLiveRouterDb(liveDb)).toThrow(/Refusing to write backup/);
      // Windows: cannot remove the current working directory — restore first.
      process.chdir(originalCwd);
      fs.rmSync(cfgDir, { recursive: true, force: true });
    });

    it('allows a temp-dir destination', () => {
      expect(() => assertNotLiveRouterDb(otherDb)).not.toThrow();
    });
  });

  describe('openBetterSqlite3 write guard', () => {
    it('direct write on an env-registered live DB throws without the adapter flag', () => {
      process.env['NINEROUTER_DB_PATH'] = liveDb;
      expect(() => openBetterSqlite3(liveDb, { readOnly: false })).toThrow(/restricted to adapter/);
    });

    it('direct write succeeds with allowLiveDbWrite (adapter-internal flag)', () => {
      process.env['NINEROUTER_DB_PATH'] = liveDb;
      const db = openBetterSqlite3(liveDb, { readOnly: false, allowLiveDbWrite: true });
      db.exec('CREATE TABLE IF NOT EXISTS adapter_written (id INTEGER)');
      db.close();
      const check = openBetterSqlite3(liveDb, { readOnly: true });
      const rows = check.prepare("SELECT name FROM sqlite_master WHERE name='adapter_written'").all();
      check.close();
      expect(rows).toHaveLength(1);
    });

    it('read-only open on a live DB always succeeds', () => {
      process.env['NINEROUTER_DB_PATH'] = liveDb;
      const db = openBetterSqlite3(liveDb, { readOnly: true });
      expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
      db.close();
    });

    it('write open respects restrictToDir option when specified', () => {
      // tmpDir is allowed
      const db = openBetterSqlite3(otherDb, { readOnly: false, restrictToDir: tmpDir });
      expect(() => db.exec('INSERT INTO t (id) VALUES (42)')).not.toThrow();
      db.close();

      // other directory restriction fails
      const restrictedDir = path.join(os.tmpdir(), 'some_disallowed_folder');
      expect(() =>
        openBetterSqlite3(otherDb, { readOnly: false, restrictToDir: restrictedDir })
      ).toThrow(/Directory Restriction Violation/);
    });

    it('write open without restrictToDir runs pure production path without NODE_ENV branching', () => {
      const db = openBetterSqlite3(otherDb, { readOnly: false });
      expect(() => db.exec('INSERT INTO t (id) VALUES (100)')).not.toThrow();
      db.close();
    });

    it('direct write on a routersync.yaml-registered live DB throws without adapter flag (even without restrictToDir)', () => {
      const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_cfg_write_'));
      fs.writeFileSync(
        path.join(cfgDir, 'routersync.yaml'),
        `version: 1\nrouters:\n  - id: nine\n    adapter: 9router\n    db:\n      path: ${liveDb}\n`,
        'utf8'
      );
      process.chdir(cfgDir);
      try {
        expect(() => openBetterSqlite3(liveDb, { readOnly: false })).toThrow(
          /Safety violation: Direct write access to live router database/
        );
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(cfgDir, { recursive: true, force: true });
      }
    });

    it('write open respects defaultRestrictDir injected globally', () => {
      const restrictedDir = path.join(os.tmpdir(), 'disallowed_dir_test');
      setDefaultRestrictDir(restrictedDir);
      try {
        expect(() =>
          openBetterSqlite3(otherDb, { readOnly: false })
        ).toThrow(/Directory Restriction Violation/);
      } finally {
        setDefaultRestrictDir(os.tmpdir());
      }
    });
  });
});
