/**
 * packages/mcp-server/test/c51-rs-field-01-tick-if-due-real-spawn.test.ts
 *
 * Ticket RS-FIELD-01 & P2-1 (C51): End-to-end tests spawning REAL compiled
 * `packages/cli/dist/index.js tick --mode observe` via `runTickIfDue` and
 * verifying spoofed `ROUTERSYNC_LOCK_HANDOFF_PARENT_PID` without valid nonce
 * is rejected without mutating `<stateDir>/tick.lock`.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCK_HANDOFF_NONCE_ENV,
  LOCK_HANDOFF_PARENT_PID_ENV,
  generateTickLockHandoffNonce,
  isProcessAlive,
  openBetterSqlite3,
  releaseTickLock,
  tryAcquireTickLock,
} from '@routersync/core';
import { runTickIfDue } from '../src/tick-if-due.js';

function createIsolatedTickFixture(tmpDir: string): {
  stateDir: string;
  emptyHome: string;
  nineDbPath: string;
  omniDbPath: string;
  configPath: string;
} {
  const stateDir = path.join(tmpDir, 'state');
  const emptyHome = path.join(tmpDir, 'isolated-home');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(emptyHome, { recursive: true });

  const freshIso = new Date().toISOString();
  fs.writeFileSync(
    path.join(stateDir, 'l2-cache.json'),
    JSON.stringify({ version: 1, updatedAt: freshIso, models: {} }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(stateDir, 'l3-cache.json'),
    JSON.stringify({ version: 1, updatedAt: freshIso, sourceHashes: {}, notices: [] }),
    'utf8'
  );

  const nineDbPath = path.join(tmpDir, 'synth-9router.sqlite');
  const nineDb = openBetterSqlite3(nineDbPath, { restrictToDir: tmpDir });
  nineDb.exec(`
    CREATE TABLE providerConnections (provider TEXT, name TEXT, authType TEXT, isActive INTEGER, data TEXT);
    CREATE TABLE providerNodes (id TEXT, data TEXT);
    CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT);
    CREATE TABLE kv (scope TEXT, key TEXT, value TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  nineDb.close();

  const omniDbPath = path.join(tmpDir, 'synth-omni.sqlite');
  const omniDb = openBetterSqlite3(omniDbPath, { restrictToDir: tmpDir });
  omniDb.exec(`
    CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, name TEXT, auth_type TEXT, is_active INTEGER, api_key TEXT, provider_specific_data TEXT);
    CREATE TABLE provider_nodes (id TEXT PRIMARY KEY, prefix TEXT, base_url TEXT);
    CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT UNIQUE, data TEXT, created_at TEXT, updated_at TEXT, sort_order INTEGER, system_message TEXT);
    CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT);
  `);
  omniDb.close();

  const configPath = path.join(tmpDir, 'routersync-synth.yaml');
  fs.writeFileSync(
    configPath,
    [
      'version: 1',
      'routers:',
      '  - id: synth-omni',
      '    adapter: omniroute',
      '    baseUrl: "http://127.0.0.1:9/v1"',
      '    db:',
      `      path: "${omniDbPath.replace(/\\/g, '/')}"`,
      '    isolated: true',
      'policy:',
      '  mode: shadow',
      '  schedule:',
      '    sync: "every 15m"',
      '    health: "every 5m"',
      'combos: []',
      '',
    ].join('\n'),
    'utf8'
  );

  return { stateDir, emptyHome, nineDbPath, omniDbPath, configPath };
}

describe('C51 RS-FIELD-01 & P2-1: runTickIfDue real detached CLI child handoff & spoof guard', () => {
  let tmpDir: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c51-f01-spawn-'));
  });

  afterEach(() => {
    process.env = { ...origEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('spawns real CLI tick --mode observe with matching nonce, writes 1 mode=observe line to tick.log, and cleans up tick.lock', async () => {
    const { stateDir, emptyHome, nineDbPath, omniDbPath, configPath } =
      createIsolatedTickFixture(tmpDir);

    process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
    process.env['ROUTERSYNC_HOME'] = emptyHome;
    process.env['ROUTERSYNC_9ROUTER_DB'] = nineDbPath;
    process.env['ROUTERSYNC_OMNIROUTE_DB'] = omniDbPath;
    process.env['ROUTERSYNC_PROVIDERS_LOCAL'] = '';

    const res = runTickIfDue({
      stateDir,
      configPath,
      minIntervalMinutes: 15,
    });

    expect(res.triggered).toBe(true);
    expect(res.mode).toBe('observe');
    expect(res.tokensUsed).toBe(0);
    expect(typeof res.pid).toBe('number');
    expect(res.pid!).toBeGreaterThan(0);

    const childPid = res.pid!;
    const tickLogPath = path.join(stateDir, 'tick.log');
    const tickLockPath = path.join(stateDir, 'tick.lock');

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const alive = isProcessAlive(childPid);
      const hasLog =
        fs.existsSync(tickLogPath) && fs.readFileSync(tickLogPath, 'utf8').trim().length > 0;
      const lockGone = !fs.existsSync(tickLockPath);
      if (hasLog && lockGone) {
        break;
      }
      if (!alive) {
        await new Promise((r) => setTimeout(r, 150));
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(fs.existsSync(tickLogPath)).toBe(true);
    const lines = fs
      .readFileSync(tickLogPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('mode=observe');
    expect(lines[0]).toContain('paid-requests=0 tokens=0 llm-calls=0');
    expect(fs.existsSync(tickLockPath)).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'status.json'))).toBe(true);
  }, 20_000);

  it('blocks real CLI child spoofing ROUTERSYNC_LOCK_HANDOFF_PARENT_PID without matching nonce and leaves tick.lock unchanged', () => {
    const { stateDir, emptyHome, nineDbPath, omniDbPath, configPath } =
      createIsolatedTickFixture(tmpDir);

    const realNonce = generateTickLockHandoffNonce();
    const wrongNonce = generateTickLockHandoffNonce();
    const held = tryAcquireTickLock(stateDir, process.pid, Date.now(), undefined, {
      issueNonce: realNonce,
    });
    expect(held.acquired).toBe(true);
    const rawLockBefore = fs.readFileSync(held.lockPath, 'utf8');

    const cliEntry = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
    expect(fs.existsSync(cliEntry)).toBe(true);

    try {
      // 1) Missing nonce
      const noNonceRun = spawnSync(
        process.execPath,
        [cliEntry, 'tick', '--mode', 'observe', '--state-dir', stateDir, '--config', configPath],
        {
          env: {
            ...process.env,
            ROUTERSYNC_STATE_DIR: stateDir,
            ROUTERSYNC_HOME: emptyHome,
            ROUTERSYNC_9ROUTER_DB: nineDbPath,
            ROUTERSYNC_OMNIROUTE_DB: omniDbPath,
            ROUTERSYNC_PROVIDERS_LOCAL: '',
            [LOCK_HANDOFF_PARENT_PID_ENV]: String(process.pid),
            [LOCK_HANDOFF_NONCE_ENV]: '',
          },
          encoding: 'utf8',
          windowsHide: true,
        }
      );
      expect(noNonceRun.status).not.toBe(0);
      expect(fs.readFileSync(held.lockPath, 'utf8')).toBe(rawLockBefore);
      expect(fs.existsSync(path.join(stateDir, 'tick.log'))).toBe(false);

      // 2) Wrong nonce
      const wrongNonceRun = spawnSync(
        process.execPath,
        [cliEntry, 'tick', '--mode', 'observe', '--state-dir', stateDir, '--config', configPath],
        {
          env: {
            ...process.env,
            ROUTERSYNC_STATE_DIR: stateDir,
            ROUTERSYNC_HOME: emptyHome,
            ROUTERSYNC_9ROUTER_DB: nineDbPath,
            ROUTERSYNC_OMNIROUTE_DB: omniDbPath,
            ROUTERSYNC_PROVIDERS_LOCAL: '',
            [LOCK_HANDOFF_PARENT_PID_ENV]: String(process.pid),
            [LOCK_HANDOFF_NONCE_ENV]: wrongNonce,
          },
          encoding: 'utf8',
          windowsHide: true,
        }
      );
      expect(wrongNonceRun.status).not.toBe(0);
      expect(fs.readFileSync(held.lockPath, 'utf8')).toBe(rawLockBefore);
      expect(fs.existsSync(path.join(stateDir, 'tick.log'))).toBe(false);
    } finally {
      releaseTickLock(stateDir, process.pid);
    }
  }, 20_000);
});
