/**
 * packages/cli/test/status-down.test.ts
 *
 * Test D7 & R7B-3:
 * When router API is down / unreachable:
 *  - readBackLevel degrades to 'db-only (degraded)' (never 'full' or 'existence-only')
 *  - applyState is 'written-pending-reload' (never 'verified')
 *  - Status JSON output contains neither "full" nor "verified"
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { runStatusCommand } from '../src/commands/status.js';
import { runScanCommand } from '../src/commands/scan.js';
import { openBetterSqlite3, saveSnapshot } from '@routersync/core';

function setupMockDatabases(dir: string): { configPath: string; omniPort: number; ninePort: number } {
  const omniDbPath = path.join(dir, 'test_omni.sqlite');
  const nineDbPath = path.join(dir, 'test_nine.sqlite');
  const configPath = path.join(dir, 'test_config.yaml');

  const omniDb = openBetterSqlite3(omniDbPath);
  omniDb.exec(`
    CREATE TABLE combos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      system_message TEXT DEFAULT NULL
    );
  `);
  omniDb.close();

  const nineDb = openBetterSqlite3(nineDbPath);
  nineDb.exec(`
    CREATE TABLE combos (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      kind TEXT,
      models TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
    INSERT INTO settings (id, data) VALUES (1, '{"comboStrategies":{}}');
  `);
  nineDb.close();

  const safeOmniPath = omniDbPath.replace(/\\/g, '/');
  const safeNinePath = nineDbPath.replace(/\\/g, '/');

  // Ports that are NOT running any server
  const omniPort = 59881;
  const ninePort = 59882;

  const yamlContent = `
version: 1

routers:
  - id: omni
    adapter: omniroute
    dbPath: "${safeOmniPath}"
    baseUrl: "http://127.0.0.1:${omniPort}"
    write: db
    reload:
      type: none

  - id: nine
    adapter: 9router
    dbPath: "${safeNinePath}"
    baseUrl: "http://127.0.0.1:${ninePort}"
    write: db
    reload:
      type: none

sources:
  providers:
    enabled: true
  aggregators: []
  community_registry: false
  news_signals:
    enabled: false

policy:
  mode: manual

combos: []
adopt: []
`;

  fs.writeFileSync(configPath, yamlContent, 'utf-8');
  return { configPath, omniPort, ninePort };
}

describe('D7 & R7B-3: router reachability reflects in readBackLevel and applyState', () => {
  let tmpDir: string;
  let stateDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `rs_d7_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    // R19-2: the state directory is where the evidence of a write lives
    // (snapshots + the managed-id ledger). Without this override the command
    // would read the REAL state directory of the machine.
    stateDir = path.join(tmpDir, 'state');
    process.env.ROUTERSYNC_STATE_DIR = stateDir;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('D7: when mock routers are down, JSON output contains neither "full" nor "verified"', async () => {
    // Configure keys that would statically indicate 'full' or 'existence-only'
    process.env.OMNIROUTE_API_KEY = 'test-omni-key';
    process.env.NINEROUTER_CLIENT_KEY = 'test-nine-key';

    const { configPath } = setupMockDatabases(tmpDir);

    const logLines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };

    try {
      await runStatusCommand({ configPath, json: true });
    } finally {
      console.log = origLog;
    }

    const jsonString = logLines.join('\n');
    const parsed = JSON.parse(jsonString);

    expect(parsed.ok).toBe(true);
    expect(parsed.routers).toHaveLength(2);

    // Strict D7 / R8-5 assertion: JSON output string contains neither "full", "verified", nor "written-pending-reload"
    expect(jsonString).not.toContain('"full"');
    expect(jsonString).not.toContain('"verified"');
    expect(jsonString).not.toContain('"written-pending-reload"');

    // Detailed per-router assertions
    for (const router of parsed.routers) {
      expect(router.health.ok).toBe(false);
      expect(router.health.status).toBe('down');
      expect(router.readBackLevel).toBe('db-only (degraded)');
      expect(router.applyState).toBeUndefined();
      expect(router.degradedReason).toMatch(/Router API unreachable/);
    }
  });

  it('D7: scan command also degrades readBackLevel when router is down', async () => {
    process.env.OMNIROUTE_API_KEY = 'test-omni-key';
    const { configPath } = setupMockDatabases(tmpDir);

    const logLines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };

    try {
      await runScanCommand({ configPath, json: true });
    } finally {
      console.log = origLog;
    }

    const jsonString = logLines.join('\n');
    const parsed = JSON.parse(jsonString);

    expect(jsonString).not.toContain('"full"');
    for (const router of parsed.routers) {
      expect(router.readBackLevel).toBe('db-only (degraded)');
    }
  });

  it('D7: when mock router is healthy, readBackLevel and applyState reflect configured capability', async () => {
    // Start a mock HTTP server responding 200 OK for health
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };

    try {
      process.env.OMNIROUTE_API_KEY = 'test-omni-key';

      const omniDbPath = path.join(tmpDir, 'healthy_omni.sqlite');
      const omniDb = openBetterSqlite3(omniDbPath);
      omniDb.exec(`
        CREATE TABLE combos (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          system_message TEXT DEFAULT NULL
        );
      `);
      omniDb.close();

      const safeOmniPath = omniDbPath.replace(/\\/g, '/');
      const configPath = path.join(tmpDir, 'healthy_config.yaml');
      const yamlContent = `
version: 1
routers:
  - id: omni-healthy
    adapter: omniroute
    dbPath: "${safeOmniPath}"
    baseUrl: "http://127.0.0.1:${address.port}"
    write: db
    reload:
      type: none
sources:
  providers:
    enabled: true
policy:
  mode: manual
combos: []
`;
      fs.writeFileSync(configPath, yamlContent, 'utf-8');

      const logLines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };

      // R19-2 (DECISIONS 2026-10-18-01): 'verified' describes a WRITE, so it
      // needs evidence. The evidence of a write of this target is a snapshot
      // of that target in the state directory. It is written BEFORE the
      // command runs: the command must find it.
      saveSnapshot({
        id: 'snap_status_down_healthy',
        target: 'omniroute',
        timestamp: new Date().toISOString(),
        combos: [],
      });

      try {
        await runStatusCommand({ configPath, json: true });
      } finally {
        console.log = origLog;
      }

      const jsonString = logLines.join('\n');
      const parsed = JSON.parse(jsonString);

      expect(parsed.routers[0].health.ok).toBe(true);
      expect(parsed.routers[0].readBackLevel).toBe('full');
      expect(parsed.routers[0].applyState).toBe('verified');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('D7: a healthy router WITHOUT evidence of a write is "unwritten" (R19-2)', async () => {
    // The same healthy router, but nothing was ever written: the state
    // directory is empty, so there is no snapshot and no managed-id entry.
    // 'verified' would be a lie: it claims a write that never happened.
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };

    try {
      process.env.OMNIROUTE_API_KEY = 'test-omni-key';

      const omniDbPath = path.join(tmpDir, 'healthy_omni2.sqlite');
      const omniDb = openBetterSqlite3(omniDbPath);
      omniDb.exec(`
        CREATE TABLE combos (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          system_message TEXT DEFAULT NULL
        );
      `);
      omniDb.close();

      const safeOmniPath = omniDbPath.replace(/\\/g, '/');
      const configPath = path.join(tmpDir, 'healthy_config2.yaml');
      fs.writeFileSync(
        configPath,
        `version: 1
routers:
  - id: omni-healthy
    adapter: omniroute
    dbPath: "${safeOmniPath}"
    baseUrl: "http://127.0.0.1:${address.port}"
    write: db
    reload:
      type: none
sources:
  providers:
    enabled: true
policy:
  mode: manual
combos: []
`,
        'utf-8',
      );

      const logLines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };

      try {
        await runStatusCommand({ configPath, json: true });
      } finally {
        console.log = origLog;
      }

      const parsed = JSON.parse(logLines.join('\n'));

      expect(parsed.routers[0].health.ok).toBe(true);
      expect(parsed.routers[0].readBackLevel).toBe('full');
      expect(parsed.routers[0].applyState).toBe('unwritten');
      expect(parsed.routers[0].applyState).not.toBe('verified');
      expect(parsed.routers[0].applyState).not.toBe('written-pending-reload');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
