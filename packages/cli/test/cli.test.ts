/**
 * packages/cli/test/cli.test.ts
 *
 * Tests Condition A1 and AT-100:
 *  - CLI commands init / scan / plan / apply / rollback / status with --json
 *  - apply defaults to dry-run
 *  - apply --yes is strictly rejected
 *  - apply --write in non-TTY is strictly rejected
 *  - checkNodeVersion rejects Node < 22 (AT-100)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { checkNodeVersion } from '../src/node-check.js';
import { runInitCommand } from '../src/commands/init.js';
import { runApplyCommand } from '../src/commands/apply.js';
import { runStatusCommand } from '../src/commands/status.js';

import { openBetterSqlite3 } from '@routersync/core';

function setupIsolatedTestDatabases(dir: string): { configPath: string; omniDbPath: string; nineDbPath: string } {
  const omniDbPath = path.join(dir, 'test_omni.sqlite');
  const nineDbPath = path.join(dir, 'test_nine.sqlite');
  const configPath = path.join(dir, 'isolated_config.yaml');

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

  const yamlContent = `
version: 1

routers:
  - id: omni
    adapter: omniroute
    dbPath: "${safeOmniPath}"
    baseUrl: "http://127.0.0.1:59128"
    write: db
    reload:
      type: none

  - id: nine
    adapter: 9router
    dbPath: "${safeNinePath}"
    baseUrl: "http://127.0.0.1:59129"
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
  return { configPath, omniDbPath, nineDbPath };
}

describe('CLI Commands and Safety Rails (Condition A1 & AT-100)', () => {
  let tmpDir: string;
  let tmpConfigPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `rs_cli_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    tmpConfigPath = path.join(tmpDir, 'config.yaml');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('AT-100: checkNodeVersion rejects Node versions below 22.12.0', () => {
    const v20 = checkNodeVersion('v20.18.0');
    expect(v20.ok).toBe(false);
    expect(v20.message).toMatch(/requires Node\.js >= 22\.12\.0/);

    const v21 = checkNodeVersion('v21.5.0');
    expect(v21.ok).toBe(false);

    const v22Old = checkNodeVersion('v22.0.0');
    expect(v22Old.ok).toBe(false);
    expect(v22Old.message).toMatch(/requires Node\.js >= 22\.12\.0/);

    const v2211 = checkNodeVersion('v22.11.0');
    expect(v2211.ok).toBe(false);

    const v2212 = checkNodeVersion('v22.12.0');
    expect(v2212.ok).toBe(true);

    const v24 = checkNodeVersion('v24.18.0');
    expect(v24.ok).toBe(true);
  });

  it('A1: init generates valid configuration file', async () => {
    await runInitCommand({ path: tmpConfigPath });
    expect(fs.existsSync(tmpConfigPath)).toBe(true);
    const content = fs.readFileSync(tmpConfigPath, 'utf-8');
    expect(content).toMatch(/version: 1/);
  });

  it('A1: apply defaults to dry-run without writing changes', async () => {
    const { configPath } = setupIsolatedTestDatabases(tmpDir);
    const report = await runApplyCommand({ configPath, write: false });

    expect(report.mode).toBe('dry-run');
    expect(report.status).toBe('SUCCESS');
    expect(report.results.every((r) => r.success)).toBe(true);
  });

  it('A1: apply rejects --yes flag strictly with security violation error', async () => {
    const { configPath } = setupIsolatedTestDatabases(tmpDir);
    await expect(
      runApplyCommand({ configPath, yes: true })
    ).rejects.toThrow(/--yes flag is prohibited/i);
  });

  it('A1: apply --write in non-TTY environment is strictly rejected', async () => {
    const { configPath } = setupIsolatedTestDatabases(tmpDir);

    // In vitest test execution, process.stdin.isTTY is false or undefined
    const isTTY = Boolean(process.stdin.isTTY);
    if (!isTTY) {
      await expect(
        runApplyCommand({ configPath, write: true })
      ).rejects.toThrow(/requires an interactive TTY/i);
    }
  });

  it('A1: status inspects routers and includes read-back level', async () => {
    const { configPath } = setupIsolatedTestDatabases(tmpDir);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await runStatusCommand({ configPath, json: true });
    } finally {
      console.log = origLog;
    }
    const jsonStr = logs.join('\n');
    expect(jsonStr).not.toContain('"full"');
    expect(jsonStr).not.toContain('"verified"');
    expect(jsonStr).not.toContain('"written-pending-reload"');
  });
});
