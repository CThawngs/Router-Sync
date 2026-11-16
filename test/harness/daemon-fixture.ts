/**
 * test/harness/daemon-fixture.ts
 *
 * Shared hermetic fixture for EVERY test that starts the S1 daemon
 * (createDaemonServer / startDaemonServer) — AT-118..AT-127 (R11-0).
 *
 * Why this exists (R11-0 DISCREPANCY): `r10-at123-red` proved that daemon tests
 * started with the DEFAULT configuration resolved the owner's REAL router
 * databases and probed the REAL router ports 20128/30128 (read-only, but still
 * a DECISIONS 2026-10-14-04 violation: no real router access without owner
 * command). This harness makes every daemon start hermetic:
 *
 * - a throwaway directory under `os.tmpdir()` with fixture SQLite DBs
 *   (exactly 1 combo `routersync-fast` using model `m1`, on BOTH routers),
 * - a `routersync.yaml` fixture in the tmp dir pointing at the tmp DBs,
 * - explicit env overrides: ROUTERSYNC_CONFIG, OMNIROUTE_DB_PATH,
 *   NINEROUTER_DB_PATH, OMNIROUTE_URL, NINEROUTER_URL, ROUTERSYNC_STATE_DIR,
 * - probe URLs point at closed loopback ports (nothing listens there),
 * - AT-127 guard `assertDaemonEnvIsHermetic()` throws when the resolved DB
 *   paths escape `os.tmpdir()`, a probe URL uses port 20128/30128, the config
 *   is not a tmp file, or any override is missing.
 *
 * `restore()` puts the original environment back and removes the tmp dir.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    exec(sql: string): void;
    close(): void;
  };
};

/** Real router ports that hermetic tests must NEVER touch (DECISIONS 2026-10-14-04). */
export const REAL_ROUTER_PORTS: readonly number[] = [20128, 30128];

/** Env vars the harness owns (sets on setup, restores on teardown). */
export const DAEMON_FIXTURE_ENV_KEYS = [
  'ROUTERSYNC_CONFIG',
  'OMNIROUTE_DB_PATH',
  'NINEROUTER_DB_PATH',
  'OMNIROUTE_URL',
  'NINEROUTER_URL',
  'ROUTERSYNC_STATE_DIR',
] as const;

export type DaemonFixtureEnvKey = (typeof DAEMON_FIXTURE_ENV_KEYS)[number];

export interface DaemonFixtureProbePorts {
  /** Port for OMNIROUTE_URL (a mock server the test owns, or a closed port). */
  omni?: number;
  /** Port for NINEROUTER_URL (a mock server the test owns, or a closed port). */
  nine?: number;
}

export interface DaemonFixture {
  tmpDir: string;
  stateDir: string;
  omniDbPath: string;
  nineDbPath: string;
  configPath: string;
  omniProbeUrl: string;
  nineProbeUrl: string;
  /** Restores the original environment and removes the tmp dir. */
  restore(): void;
}

interface EnvSnapshotEntry {
  hadValue: boolean;
  value?: string | undefined;
}

/**
 * Returns true when `p` resolves inside `os.tmpdir()` (case-normalized via
 * realpath so Windows drive-letter casing and 8.3 names cannot fool it).
 * Exported for AT-127's negative assertions.
 */
export function isPathUnderTmpDir(p: string): boolean {
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(p));
  } catch {
    return false; // non-existent path can never be proven hermetic
  }
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const rel = path.relative(tmpRoot, resolved);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** True when `urlStr` is a loopback http URL on a port that is not a real router port. */
export function isHermeticProbeUrl(urlStr: string): boolean {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (!loopbackHosts.has(url.hostname)) return false;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  if (REAL_ROUTER_PORTS.includes(port)) return false;
  return true;
}

/**
 * AT-127 guard (R11-0.3): validates the CURRENT process.env so that no daemon
 * started by the test suite can touch real state. Throws with an explicit
 * reason when any invariant is violated:
 *  - all 6 override env vars must be set and non-empty,
 *  - config + both DB paths + state dir must resolve under os.tmpdir(),
 *  - both probe URLs must be loopback http URLs NOT on ports 20128/30128.
 */
export function assertDaemonEnvIsHermetic(): void {
  for (const key of DAEMON_FIXTURE_ENV_KEYS) {
    const val = process.env[key];
    if (val === undefined || val.trim() === '') {
      throw new Error(
        `[AT-127] hermetic guard: env ${key} is not set. ` +
          `Daemon tests must call setupDaemonFixture() and keep every override explicit ` +
          `(missing overrides silently fall back to the owner's real router state).`
      );
    }
  }

  const pathKeys: DaemonFixtureEnvKey[] = [
    'ROUTERSYNC_CONFIG',
    'OMNIROUTE_DB_PATH',
    'NINEROUTER_DB_PATH',
    'ROUTERSYNC_STATE_DIR',
  ];
  for (const key of pathKeys) {
    const p = process.env[key] as string;
    if (!isPathUnderTmpDir(p)) {
      throw new Error(
        `[AT-127] hermetic guard: ${key}=${p} does not resolve under os.tmpdir(). ` +
          `Refusing to run: the daemon would read/write outside the throwaway fixture.`
      );
    }
  }

  const urlKeys: DaemonFixtureEnvKey[] = ['OMNIROUTE_URL', 'NINEROUTER_URL'];
  for (const key of urlKeys) {
    const urlStr = process.env[key] as string;
    if (!isHermeticProbeUrl(urlStr)) {
      throw new Error(
        `[AT-127] hermetic guard: ${key}=${urlStr} is not a loopback http URL on a non-real port ` +
          `(real router ports ${REAL_ROUTER_PORTS.join('/')} are forbidden; ` +
          `DECISIONS 2026-10-14-04: no real router access without owner command).`
      );
    }
  }
}

/**
 * Binds port 0 on loopback, reads the assigned port, then closes the listener
 * so the port is (transiently) closed. Resolves only after close() completed.
 * Retries when the OS hands back a real router port (paranoia).
 */
async function reserveClosedLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const assigned = addr && typeof addr === 'object' ? addr.port : 0;
        srv.close(() => {
          resolve(assigned);
        });
      });
    });
    if (!REAL_ROUTER_PORTS.includes(port)) {
      return port;
    }
  }
  throw new Error('[daemon-fixture] could not reserve a closed loopback port');
}

function createOmniFixtureDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE combos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL
    );`);
    db.exec(
      `INSERT INTO combos (id, name, data) VALUES ('routersync-fast', 'routersync-fast', ` +
        `'{"strategy":"priority","models":["m1"],"managed":true}');`
    );
  } finally {
    db.close();
  }
}

function createNineFixtureDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    // R16-1 (AT-143): a real 9Router DB has a `settings` table next to
    // `combos` — that is exactly where `comboStrategies` lives, and where the
    // R15 crash came from. The fixture now carries it too, so the daemon
    // reader is exercised on the real shape instead of on a DB without it.
    db.exec(`CREATE TABLE combos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT,
      models TEXT,
      createdAt TEXT NOT NULL DEFAULT '',
      updatedAt TEXT NOT NULL DEFAULT ''
    );`);
    db.exec(`CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );`);
    db.exec(
      `INSERT INTO combos (id, name, kind, models) VALUES ('routersync-fast', 'routersync-fast', 'managed', '["m1"]');`
    );
    db.exec(
      `INSERT INTO settings (id, data) VALUES (1, '{"theme":"dark","port":20128,"comboStrategies":{"routersync-fast":"priority"}}');`
    );
  } finally {
    db.close();
  }
}

function snapshotAndApplyEnv(
  configPath: string,
  omniDbPath: string,
  nineDbPath: string,
  omniProbeUrl: string,
  nineProbeUrl: string,
  stateDir: string
): Map<DaemonFixtureEnvKey, EnvSnapshotEntry> {
  const snapshot = new Map<DaemonFixtureEnvKey, EnvSnapshotEntry>();
  for (const key of DAEMON_FIXTURE_ENV_KEYS) {
    snapshot.set(key, { hadValue: process.env[key] !== undefined, value: process.env[key] });
  }

  process.env['ROUTERSYNC_CONFIG'] = configPath;
  process.env['OMNIROUTE_DB_PATH'] = omniDbPath;
  process.env['NINEROUTER_DB_PATH'] = nineDbPath;
  process.env['OMNIROUTE_URL'] = omniProbeUrl;
  process.env['NINEROUTER_URL'] = nineProbeUrl;
  process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
  return snapshot;
}

function restoreEnvFromSnapshot(snapshot: Map<DaemonFixtureEnvKey, EnvSnapshotEntry>): void {
  for (const key of DAEMON_FIXTURE_ENV_KEYS) {
    const entry = snapshot.get(key);
    if (entry?.hadValue) {
      process.env[key] = entry.value;
    } else {
      delete process.env[key];
    }
  }
}

/**
 * Creates the hermetic fixture and applies the env overrides. Call
 * `fixture.restore()` in afterAll. When `probePorts` is given, the probe URLs
 * point at those ports (used by AT-125's router-UP case that owns mock
 * servers); otherwise both probe URLs point at closed loopback ports.
 */
export async function setupDaemonFixture(opts?: {
  probePorts?: DaemonFixtureProbePorts;
}): Promise<DaemonFixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routersync-daemon-fixture-'));
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const omniDbPath = path.join(tmpDir, 'omniroute-fixture.sqlite');
  const nineDbPath = path.join(tmpDir, '9router-fixture.sqlite');
  createOmniFixtureDb(omniDbPath);
  createNineFixtureDb(nineDbPath);

  let omniPort = opts?.probePorts?.omni ?? (await reserveClosedLoopbackPort());
  let ninePort = opts?.probePorts?.nine ?? (await reserveClosedLoopbackPort());
  if (omniPort === ninePort) {
    // Two routers sharing one probe target would cross-contaminate cache keys.
    ninePort = await reserveClosedLoopbackPort();
    if (ninePort === omniPort) {
      throw new Error('[daemon-fixture] could not reserve two distinct loopback ports');
    }
  }
  const omniProbeUrl = `http://127.0.0.1:${omniPort}`;
  const nineProbeUrl = `http://127.0.0.1:${ninePort}`;

  const configPath = path.join(tmpDir, 'routersync.yaml');
  fs.writeFileSync(
    configPath,
    `policy:\n` +
      `  mode: manual\n` +
      `routers:\n` +
      `  - id: omniroute\n` +
      `    baseUrl: '${omniProbeUrl}'\n` +
      `    path: '${omniDbPath.replace(/\\/g, '/')}'\n` +
      `  - id: 9router\n` +
      `    baseUrl: '${nineProbeUrl}'\n` +
      `    path: '${nineDbPath.replace(/\\/g, '/')}'\n`,
    'utf8'
  );

  const snapshot = snapshotAndApplyEnv(
    configPath,
    omniDbPath,
    nineDbPath,
    omniProbeUrl,
    nineProbeUrl,
    stateDir
  );

  // Fail fast: a mis-wired harness must explode in beforeAll, not silently
  // read real state (R11-0). On failure, roll the env back and remove the
  // tmp dir so a red guard leaves no state behind.
  try {
    assertDaemonEnvIsHermetic();
  } catch (err) {
    restoreEnvFromSnapshot(snapshot);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    throw err;
  }

  return {
    tmpDir,
    stateDir,
    omniDbPath,
    nineDbPath,
    configPath,
    omniProbeUrl,
    nineProbeUrl,
    restore(): void {
      restoreEnvFromSnapshot(snapshot);
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // tmp cleanup is best-effort; env restoration is the important part
      }
    },
  };
}
