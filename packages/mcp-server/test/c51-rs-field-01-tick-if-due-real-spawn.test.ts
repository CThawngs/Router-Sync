/**
 * packages/mcp-server/test/c51-rs-field-01-tick-if-due-real-spawn.test.ts
 *
 * Ticket RS-FIELD-01 (C51): End-to-end Red-First test spawning REAL compiled
 * `packages/cli/dist/index.js tick --mode observe` via `runTickIfDue` against an
 * isolated `os.tmpdir()` stateDir and synthetic offline configuration.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isProcessAlive, openBetterSqlite3 } from '@routersync/core';
import { runTickIfDue } from '../src/tick-if-due.js';

describe('C51 RS-FIELD-01: runTickIfDue real detached CLI child handoff', () => {
  let tmpDir: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c51-f01-spawn-'));
  });

  afterEach(() => {
    process.env = { ...origEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('spawns real CLI tick --mode observe, writes 1 mode=observe line to tick.log, and cleans up tick.lock', async () => {
    const stateDir = path.join(tmpDir, 'state');
    const emptyHome = path.join(tmpDir, 'isolated-home');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(emptyHome, { recursive: true });

    // Pre-seed fresh L2 & L3 cache files in isolated stateDir so child tick makes zero external HTTP calls
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

    // Create isolated empty SQLite DBs for both routers matching full adapter schemas
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
});
