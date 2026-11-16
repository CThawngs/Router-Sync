/**
 * packages/core/src/sqlite/better-sqlite3.ts
 *
 * BetterSqlite3Driver — concrete implementation of SqliteDriver using
 * better-sqlite3@13 (MIT, stable). Adapters import `openBetterSqlite3`
 * rather than referencing the library directly.
 *
 * Safety features enforced here:
 *  - `busy_timeout` PRAGMA applied immediately after open (default 5000 ms).
 *  - Read-only mode supported for snapshot/fingerprint operations.
 *  - `transaction()` uses `BEGIN IMMEDIATE` to avoid SQLITE_BUSY on write
 *    contention in WAL mode.
 *  - `backup()` uses VACUUM INTO (clean snapshot, safe for live DBs).
 *  - No `journal_mode` changes (respect router's WAL mode).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OpenSqliteDriver, SqliteDriver, SqliteStatement } from './driver.js';

// Dynamic require so the ESM package itself doesn't hard-fail on import if
// the prebuilt binary is missing — callers get a clear error at open time.
import { createRequire } from 'node:module';
import { getConfiguredRouterDbPath, locateRouterDb } from './router-paths.js';
const require = createRequire(import.meta.url);

interface BetterSqlite3DB {
  exec(sql: string): this;
  prepare(sql: string): BetterSqlite3Stmt;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
  pragma(name: string, opts?: { simple: boolean }): unknown;
  backup(destPath: string): Promise<void>;
  close(): void;
}

interface BetterSqlite3Stmt {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

function wrapStatement(stmt: BetterSqlite3Stmt): SqliteStatement {
  return {
    all: (...params) => stmt.all(...params),
    get: (...params) => stmt.get(...params),
    run: (...params) => stmt.run(...params),
  };
}

class BetterSqlite3Driver implements SqliteDriver {
  private db: BetterSqlite3DB;

  constructor(db: BetterSqlite3DB) {
    this.db = db;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return wrapStatement(this.db.prepare(sql));
  }

  transaction<T>(fn: () => T): T {
    // better-sqlite3 transaction() creates BEGIN/COMMIT/ROLLBACK wrappers.
    // We use db.exec directly for BEGIN IMMEDIATE so we can control the
    // isolation level explicitly.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback error — DB is already in a failed state.
      }
      throw err;
    }
  }

  pragma(name: string): string | number | null {
    // better-sqlite3 pragma() with { simple: true } returns the scalar value.
    const raw = this.db.pragma(name, { simple: true });
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string' || typeof raw === 'number') return raw;
    return String(raw);
  }

  backup(destPath: string): void {
    assertNotLiveRouterDb(destPath);
    const db = this.db;
    // Use VACUUM INTO as a synchronous alternative (safe in WAL mode).
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Normalizes a database path for security comparison:
 * - Strips Windows verbatim prefix (\\?\, \\?\UNC\)
 * - Resolves symlinks / junctions / 8.3 short names via fs.realpathSync.native when path exists
 * - Standardizes slashes and case (lowercase on Windows & macOS)
 */
export function canonicalizePath(p: string): string {
  let cleaned = p;
  if (cleaned.startsWith('\\\\?\\UNC\\')) {
    cleaned = '\\\\' + cleaned.slice(8);
  } else if (cleaned.startsWith('\\\\?\\')) {
    cleaned = cleaned.slice(4);
  }
  const resolved = path.resolve(cleaned);
  let canonical = resolved;
  try {
    if (fs.existsSync(resolved)) {
      canonical = fs.realpathSync.native(resolved);
    }
  } catch {}

  if (process.platform === 'win32' || process.platform === 'darwin') {
    canonical = canonical.toLowerCase();
  }
  return path.normalize(canonical);
}

/**
 * True when `targetPath` is inside `dir` (or IS `dir`).
 *
 * C4n/N8: the old check was `resolvedPath.startsWith(resolvedAllowedDir)` on
 * lowercased strings. That had two bugs:
 *   - a sibling directory with the same prefix matched: `/tmp/abc` passed for
 *     the allowed dir `/tmp/ab`;
 *   - lowercasing every path made the comparison case-insensitive on Linux,
 *     where the filesystem IS case-sensitive.
 *
 * `path.relative` gives the exact relation: a path inside the directory has a
 * relative path that does not start with `..` and is not absolute. The
 * case-folding is applied only where the filesystem folds case.
 */
export function isPathInsideDir(targetPath: string, dir: string): boolean {
  const resolvedDir = path.resolve(dir);
  const resolvedTarget = path.resolve(targetPath);

  // Windows and macOS fold case; Linux does not.
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const normalize = (p: string) => (caseInsensitive ? p.toLowerCase() : p);

  const relative = path.relative(normalize(resolvedDir), normalize(resolvedTarget));
  if (relative === '') return true; // the directory itself
  if (path.isAbsolute(relative)) return false; // a different drive/root
  const isOutside = relative === '..' || relative.startsWith('..' + path.sep);
  return !isOutside;
}

/**
 * Checks if two paths refer to the exact same physical database file.
 * Compares canonical paths and (dev, ino) device/inode numbers when both files exist.
 */
export function isSameDbFile(pathA: string, pathB: string): boolean {
  const normA = canonicalizePath(pathA);
  const normB = canonicalizePath(pathB);
  if (normA === normB) return true;

  try {
    if (fs.existsSync(pathA) && fs.existsSync(pathB)) {
      // bigint stats: on Windows the 64-bit file index does not fit in a double,
      // so the number form can round two distinct files onto the same `ino`.
      const statA = fs.statSync(pathA, { bigint: true });
      const statB = fs.statSync(pathB, { bigint: true });
      if (statA.dev === statB.dev && statA.ino === statB.ino && statA.ino !== 0n) {
        return true;
      }
    }
  } catch {}

  return false;
}

/**
 * Explicit database paths, installed by the CLI from `config.yaml`
 * (`routers[].db.path`).
 *
 * C4n/N5: `scan` read the configured database while `rank --apply` /
 * `sync --apply` wrote the platform default, so the plan shown to the owner
 * described one database and the write landed in another. Installing the
 * configured paths here makes EVERY reader and EVERY writer resolve the same
 * file: the registry is consulted before the env override.
 *
 * The registry itself lives in ./router-paths.ts so the read-only entrypoint
 * can read it without pulling in this module.
 */
export {
  setConfiguredRouterDbPaths,
  getConfiguredRouterDbPaths,
  getConfiguredRouterDbPath,
  clearConfiguredRouterDbPaths,
  locateRouterDb,
  firstNonEmpty,
  expandTildePath,
  resolveSingleConfiguredDbPath,
  resolveConfiguredDbPaths,
  type RouterDbConfigEntry,
  type RouterDbConfigLike,
} from './router-paths.js';

export function locateAllRouterDbs(): string[] {
  return [locateRouterDb('omniroute'), locateRouterDb('9router')];
}

/**
 * Returns all live router database paths gathered from:
 * 1. Default system paths via locateRouterDb
 * 2. Environment variables for custom DB / data paths
 * 3. Configuration files (routersync.yaml / routersync.yml)
 */
export function getLiveRouterDbs(): string[] {
  const dbs = new Set<string>();

    // 1. Defaults
  for (const p of locateAllRouterDbs()) {
    dbs.add(path.resolve(p));
  }
  const home = process.env['HOME'] ?? os.homedir();
  dbs.add(path.resolve(path.join(home, '.9router', 'db', 'data.sqlite')));
  const appData = process.env['APPDATA'] ?? path.join(process.env['USERPROFILE'] ?? home, 'AppData', 'Roaming');
  dbs.add(path.resolve(path.join(appData, '9router', 'db', 'data.sqlite')));

  // 2. Environment variables
  const envCandidates: Array<string | undefined> = [
    process.env['OMNIROUTE_DB_PATH'],
    process.env['OMNIROUTE_HOME'] ? path.join(process.env['OMNIROUTE_HOME'], 'storage.sqlite') : undefined,
    process.env['OMNIROUTE_DATA_DIR'] ? path.join(process.env['OMNIROUTE_DATA_DIR'], 'storage.sqlite') : undefined,
    process.env['NINEROUTER_DB_PATH'],
    process.env['NINE_ROUTER_DB_PATH'],
    process.env['NINEROUTER_DATA_DIR'] ? path.join(process.env['NINEROUTER_DATA_DIR'], 'data.sqlite') : undefined,
    process.env['NINE_ROUTER_DATA_DIR'] ? path.join(process.env['NINE_ROUTER_DATA_DIR'], 'data.sqlite') : undefined,
    process.env['DATA_DIR'] ? path.join(process.env['DATA_DIR'], 'db', 'data.sqlite') : undefined,
  ];
  for (const envPath of envCandidates) {
    if (envPath && typeof envPath === 'string' && envPath.trim().length > 0) {
      dbs.add(path.resolve(envPath.trim()));
    }
  }

  // 3. Configuration files:
  // - Explicit ROUTERSYNC_CONFIG environment variable
  // - routersync.yaml / routersync.yml / config.yaml in CWD
  // - Default OS config location (%APPDATA%\routersync\config.yaml or ~/.config/routersync/config.yaml)
  // Matches BOTH the nested schema form (db: -> path:) and legacy flat keys
  // (db_path / dbPath).
  const defaultOsConfig = process.platform === 'win32'
    ? path.join(process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'routersync', 'config.yaml')
    : path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'), 'routersync', 'config.yaml');

  const cfgCandidates = [
    process.env['ROUTERSYNC_CONFIG'],
    path.resolve(process.cwd(), 'routersync.yaml'),
    path.resolve(process.cwd(), 'routersync.yml'),
    path.resolve(process.cwd(), 'config.yaml'),
    defaultOsConfig,
  ].filter((p): p is string => Boolean(p && typeof p === 'string' && p.trim().length > 0));

  for (const cfgPath of cfgCandidates) {
    try {
      if (fs.existsSync(cfgPath)) {
        const content = fs.readFileSync(cfgPath, 'utf8');
        let inDbBlock = false;
        for (const rawLine of content.split(/\r?\n/)) {
          const line = rawLine.replace(/#.*$/, '');
          if (/^\s*db\s*:/.test(line)) {
            inDbBlock = true;
            continue;
          }
          if (inDbBlock) {
            const nested = line.match(/^\s+path\s*:\s*["']?([^"'\r\n#]+)["']?/);
            if (nested?.[1]?.trim()) {
              dbs.add(path.resolve(nested[1].trim()));
            }
            if (/^\S/.test(line)) inDbBlock = false; // new top-level key ends db block
            continue;
          }
          const flat = line.match(/(?:db_path|dbPath)\s*:\s*["']?([^"'\r\n#]+)["']?/);
          if (flat?.[1]?.trim()) {
            dbs.add(path.resolve(flat[1].trim()));
          }
        }
      }
    } catch {}
  }

  return Array.from(dbs);
}

export function isLiveRouterDb(targetPath: string): boolean {
  for (const livePath of getLiveRouterDbs()) {
    if (isSameDbFile(targetPath, livePath)) {
      return true;
    }
  }
  return false;
}

/**
 * Enforces safety rail (Spec §31.9 & Rule 3.4):
 * Refuses backup operations where destPath matches any live router database location.
 * Live databases must never be overwritten in bulk via backup destination.
 */
export function assertNotLiveRouterDb(destPath: string): void {
  for (const livePath of getLiveRouterDbs()) {
    if (isSameDbFile(destPath, livePath)) {
      throw new Error(
        `Safety violation: Refusing to write backup directly into live router database at "${destPath}". ` +
        `Live router databases can only be modified via surgical row-level adapter operations, never direct backup overwrite.`
      );
    }
  }
}

let defaultRestrictDir: string | undefined;

/**
 * Configure default directory restriction for SQLite write access.
 * Typically injected by test harnesses (e.g. vitest setupFiles) to ensure
 * all database writes are strictly confined to temporary directories.
 */
export function setDefaultRestrictDir(dir: string | undefined): void {
  defaultRestrictDir = dir;
}

export function getDefaultRestrictDir(): string | undefined {
  return defaultRestrictDir;
}

/**
 * Open a better-sqlite3 database and return a SqliteDriver.
 * This is the factory function adapters should use.
 *
 * @throws If the prebuilt binary is missing or the file cannot be opened.
 */
export const openBetterSqlite3: OpenSqliteDriver = (
  filePath,
  options = {}
) => {
  let Database: new (path: string, opts?: Record<string, unknown>) => BetterSqlite3DB;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    Database = require('better-sqlite3');
  } catch (err) {
    throw new Error(
      `[routersync] Failed to load better-sqlite3 native addon.\n` +
      `  Possible fix: run \`npm rebuild better-sqlite3\` or \`pnpm rebuild better-sqlite3\`.\n` +
      `  Node version: ${process.version}  Platform: ${process.platform}/${process.arch}\n` +
      `  Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Safety Guard: Direct write access on any live router database is restricted
  // strictly to adapter transactions passing allowLiveDbWrite: true.
  if (!options.readOnly && isLiveRouterDb(filePath)) {
    if (!options.allowLiveDbWrite) {
      throw new Error(
        `Safety violation: Direct write access to live router database at "${filePath}" is restricted to adapter internal operations (allowLiveDbWrite=true). External scripts and test harnesses must open live DBs in readOnly mode.`
      );
    }
  }

  // Directory Restriction: When restrictToDir is supplied (or configured via setDefaultRestrictDir),
  // verify that any writable database path resides strictly within the allowed directory tree.
  const effectiveRestrictDir = options.restrictToDir !== undefined ? options.restrictToDir : defaultRestrictDir;
  if (effectiveRestrictDir && !options.readOnly) {
    if (!isPathInsideDir(filePath, effectiveRestrictDir)) {
      throw new Error(
        `[routersync] Directory Restriction Violation: SQLite drivers opened with write permissions must point to paths under "${effectiveRestrictDir}". Attempted to open: "${filePath}"`
      );
    }
  }

  let db: BetterSqlite3DB;
  try {
    db = new Database(filePath, {
      readonly: options.readOnly ?? false,
      // fileMustExist: false — allow creation for test fixtures
    });
  } catch (err) {
    // A missing router database is a setup problem, not a bug: say what to do.
    const message = err instanceof Error ? err.message : String(err);
    if (/directory does not exist|ENOENT|unable to open database/i.test(message)) {
      throw new Error(
        `[routersync] Cannot open the router database at "${filePath}".\n` +
        `  The file (or its folder) does not exist on this machine.\n` +
        `  Fix: point RouterSync at the right database, or start the router first.\n` +
        `    - 9Router   : %APPDATA%\\9router\\db\\data.sqlite      (Windows)\n` +
        `                   ~/.9router/db/data.sqlite           (macOS/Linux)\n` +
        `    - OmniRoute : ~/.omniroute/storage.sqlite           (all platforms)\n` +
        `  Override either path with ROUTERSYNC_9ROUTER_DB or ROUTERSYNC_OMNIROUTE_DB.\n` +
        `  Original error: ${message}`
      );
    }
    throw err;
  }
  const busyTimeout = options.busyTimeoutMs ?? 5000;
  db.pragma(`busy_timeout = ${busyTimeout}`, { simple: true });

  return new BetterSqlite3Driver(db);
};

/**
 * Async variant of backup using better-sqlite3's native backup API.
 * Safer than VACUUM INTO for very large databases.
 * Returns a Promise that resolves when the backup is complete.
 */
export async function backupAsync(
  filePath: string,
  destPath: string
): Promise<void> {
  assertNotLiveRouterDb(destPath);
  let Database: new (path: string, opts?: Record<string, unknown>) => BetterSqlite3DB;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  Database = require('better-sqlite3');
  const db = new Database(filePath, { readonly: true });
  try {
    await db.backup(destPath);
  } finally {
    db.close();
  }
}
