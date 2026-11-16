/**
 * packages/cli/test/router-db-path.test.ts
 *
 * C4n/N5: the database a read path and a write path resolve MUST be the same
 * file.
 *
 * Before this change `scan` read the database named by `routers[].db.path` in
 * config.yaml while `rank --apply` / `sync --apply` wrote the platform
 * default: the plan shown to the owner described one database and the write
 * landed in another.
 *
 * The test builds TWO fake 9Router databases in a temp directory:
 *   - one at the "default" location (pointed at by ROUTERSYNC_9ROUTER_DB)
 *   - one at a custom path declared in the test config
 * and proves that every read path and the write target use the CONFIGURED one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  clearConfiguredRouterDbPaths,
  setConfiguredRouterDbPaths,
  locateRouterDb,
  isPathInsideDir,
} from '@routersync/core';
import {
  clearInstalledRouterDbPaths,
  installRouterDbPaths,
  installConfiguredRouterDbPaths,
  loadConfigFile,
  resolveRouterDbPath,
  resolveRouterDbPathForAdapter,
} from '../src/config/loader.js';
import { RouterSyncConfigSchema } from '../src/config/schema.js';
import { readComboModels } from '../src/sync/write.js';
import { runTickCommand } from '../src/commands/tick.js';
import { runDoctorCommand } from '../src/commands/doctor.js';
import { runStatusCommand } from '../src/commands/status.js';

let tmpDir = '';

/** A fake 9Router database with one combo, so a reader can tell them apart. */
function makeFake9RouterDb(file: string, comboName: string, comboModels: string[]): void {
  const db = new Database(file);
  db.exec('CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT)');
  db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT)');
  db.exec('CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT, name TEXT, authType TEXT, isActive INTEGER, data TEXT)');
  db.exec('CREATE TABLE providerNodes (id TEXT PRIMARY KEY, data TEXT)');
  db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({ comboStrategies: {} }));
  db.prepare('INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    `routersync-${comboName}`,
    comboName,
    'custom',
    JSON.stringify(comboModels),
    new Date().toISOString(),
    new Date().toISOString()
  );
  db.close();
}

function writeConfigFile(file: string, dbPath: string): void {
  const yaml = [
    'version: 1',
    'routers:',
    '  - id: nine',
    '    adapter: 9router',
    `    db:`,
    `      path: ${dbPath.replace(/\\/g, '/')}`,
    '    write: db',
    '    reload:',
    '      type: none',
    'policy:',
    '  mode: manual',
    'combos:',
    '  - name: rs-coder',
    '    role: coding',
    '    routers:',
    '      - nine',
    '    size: 3',
    'adopt: []',
    '',
  ].join('\n');
  fs.writeFileSync(file, yaml, 'utf-8');
}

describe('C4n/N5: read path and write path resolve the same database', () => {
  const origEnvDb = process.env['ROUTERSYNC_9ROUTER_DB'];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c4n-dbpath-'));
    clearInstalledRouterDbPaths();
    clearConfiguredRouterDbPaths();
  });

  afterEach(() => {
    if (origEnvDb === undefined) delete process.env['ROUTERSYNC_9ROUTER_DB'];
    else process.env['ROUTERSYNC_9ROUTER_DB'] = origEnvDb;
    clearInstalledRouterDbPaths();
    clearConfiguredRouterDbPaths();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('the configured db.path wins over the env default for readers and writers', () => {
    const defaultDb = path.join(tmpDir, 'default.sqlite');
    const configuredDb = path.join(tmpDir, 'configured.sqlite');
    makeFake9RouterDb(defaultDb, 'combo-from-default', ['default/model']);
    makeFake9RouterDb(configuredDb, 'combo-from-configured', ['configured/model']);

    // The env var points at the DEFAULT database ...
    process.env['ROUTERSYNC_9ROUTER_DB'] = defaultDb;
    expect(locateRouterDb('9router')).toBe(path.resolve(defaultDb));

    // ... but the config names a different one.
    const configPath = path.join(tmpDir, 'config.yaml');
    writeConfigFile(configPath, configuredDb);
    const { config } = loadConfigFile(configPath);
    expect(config.routers[0]?.db?.path).toBe(configuredDb.replace(/\\/g, '/'));

    // The read path (what `scan` and `rank` use) follows the config.
    expect(resolveRouterDbPath(config.routers[0]!)).toBe(path.resolve(configuredDb));
    expect(locateRouterDb('9router')).toBe(path.resolve(configuredDb));

    // The reader really opens the CONFIGURED database: only its combo is seen.
    const combos = readComboModels('9router');
    expect([...combos.keys()]).toEqual(['combo-from-configured']);
    expect(combos.get('combo-from-configured')).toEqual(['configured/model']);
  });

  it('the writer target equals the read target after a config load', () => {
    const defaultDb = path.join(tmpDir, 'default.sqlite');
    const configuredDb = path.join(tmpDir, 'configured.sqlite');
    makeFake9RouterDb(defaultDb, 'combo-from-default', ['default/model']);
    makeFake9RouterDb(configuredDb, 'combo-from-configured', ['configured/model']);

    process.env['ROUTERSYNC_9ROUTER_DB'] = defaultDb;
    const configPath = path.join(tmpDir, 'config.yaml');
    writeConfigFile(configPath, configuredDb);
    loadConfigFile(configPath);

    // locateRouterDb is what write.ts uses for every write and read-back.
    const writeTarget = locateRouterDb('9router');
    const readTarget = resolveRouterDbPathForAdapter('9router');
    expect(writeTarget).toBe(path.resolve(configuredDb));
    expect(readTarget).toBe(path.resolve(configuredDb));
    expect(writeTarget).toBe(readTarget);
  });

  it('installRouterDbPaths installs only the explicit db.path, env override still applies otherwise', () => {
    const envOnlyDb = path.join(tmpDir, 'env-only.sqlite');
    makeFake9RouterDb(envOnlyDb, 'combo-from-env', ['env/model']);
    process.env['ROUTERSYNC_9ROUTER_DB'] = envOnlyDb;

    // A router WITHOUT db.path keeps resolving through the env override.
    installRouterDbPaths({
      routers: [{ id: 'nine', adapter: '9router', write: 'db', validated: false, isolated: false }],
    } as never);
    expect(locateRouterDb('9router')).toBe(path.resolve(envOnlyDb));
  });

  it('a config without any db.path leaves the platform/env resolution untouched', () => {
    const envOnlyDb = path.join(tmpDir, 'env-only.sqlite');
    makeFake9RouterDb(envOnlyDb, 'combo-from-env', ['env/model']);
    process.env['ROUTERSYNC_9ROUTER_DB'] = envOnlyDb;

    installRouterDbPaths({
      routers: [{ id: 'nine', adapter: '9router', write: 'db', validated: false, isolated: false }],
    } as never);
    expect(locateRouterDb('9router')).toBe(path.resolve(envOnlyDb));
    expect(resolveRouterDbPathForAdapter('9router')).toBe(path.resolve(envOnlyDb));
  });

  it('C4o/O1: tick combo resolution reads from configured DB path even in fresh process state (cleared paths)', async () => {
    const defaultDb = path.join(tmpDir, 'tick-default.sqlite');
    const configuredDb = path.join(tmpDir, 'tick-configured.sqlite');
    makeFake9RouterDb(defaultDb, 'combo-from-default', ['default/model']);
    makeFake9RouterDb(configuredDb, 'combo-from-configured', ['configured/model']);

    // Point default env var at defaultDb
    process.env['ROUTERSYNC_9ROUTER_DB'] = defaultDb;

    // Explicitly CLEAR installed and configured paths to simulate brand-new process start
    clearInstalledRouterDbPaths();
    clearConfiguredRouterDbPaths();
    expect(locateRouterDb('9router')).toBe(path.resolve(defaultDb));

    const configPath = path.join(tmpDir, 'tick-config.yaml');
    writeConfigFile(configPath, configuredDb);

    const tickDir = path.join(tmpDir, 'tick-state');
    // Run tick command with fresh process simulation
    const summary = await runTickCommand({
      configPath,
      stateDir: tickDir,
      mode: 'observe',
      fetchFn: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    });

    // After tick runs, configured DB path was installed first and used
    expect(locateRouterDb('9router')).toBe(path.resolve(configuredDb));
    expect(summary.mode).toBe('observe');
    expect(fs.existsSync(path.join(tickDir, 'status.json'))).toBe(true);
    const vsPath = path.join(tickDir, 'verify-status.json');
    expect(fs.existsSync(vsPath)).toBe(true);
    const vs = JSON.parse(fs.readFileSync(vsPath, 'utf8'));
    const verifiedSteps = vs.records.map((r: { fullStep?: string }) => r.fullStep);
    expect(verifiedSteps).toContain('configured/model');
    expect(verifiedSteps).not.toContain('default/model');
  });

  it('C4o/O2: rank preview, tick, doctor, and status all resolve the same configured database path', async () => {
    clearInstalledRouterDbPaths();
    clearConfiguredRouterDbPaths();

    const defaultDb = path.join(tmpDir, 'o2-default.sqlite');
    const configuredDb = path.join(tmpDir, 'o2-configured.sqlite');
    makeFake9RouterDb(defaultDb, 'combo-from-default', ['default/model']);
    makeFake9RouterDb(configuredDb, 'combo-from-configured', ['configured/model']);
    process.env['ROUTERSYNC_9ROUTER_DB'] = defaultDb;

    const configPath = path.join(tmpDir, 'o2-config.yaml');
    writeConfigFile(configPath, configuredDb);

    // 1. Unified installation hook installs configured DB paths
    installConfiguredRouterDbPaths(configPath);
    expect(locateRouterDb('9router')).toBe(path.resolve(configuredDb));

    // 2. Rank preview mode reads combo models from configured DB
    const rankCombos = readComboModels('9router');
    expect([...rankCombos.keys()]).toEqual(['combo-from-configured']);
    expect(rankCombos.get('combo-from-configured')).toEqual(['configured/model']);

    // 3. Status command
    await runStatusCommand({ configPath, json: true });
    expect(locateRouterDb('9router')).toBe(path.resolve(configuredDb));

    // 4. Doctor command
    await runDoctorCommand({ configPath, json: true });
    expect(locateRouterDb('9router')).toBe(path.resolve(configuredDb));

    // 5. Tick command
    const tickDir = path.join(tmpDir, 'o2-tick-state');
    await runTickCommand({
      configPath,
      stateDir: tickDir,
      mode: 'observe',
      fetchFn: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    });
    expect(locateRouterDb('9router')).toBe(path.resolve(configuredDb));
  });

  it('C4o/O2: schema rejects config with multiple routers sharing the same adapter', () => {
    const invalidConfig = {
      version: 1,
      routers: [
        { id: 'nine-1', adapter: '9router', write: 'db' },
        { id: 'nine-2', adapter: '9router', write: 'db' },
      ],
      combos: [],
    };
    const result = RouterSyncConfigSchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'routers');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('Multiple routers with the same adapter "9router" are not supported');
    }
  });

  it('C4o/O5: isPathInsideDir allows files starting with two dots inside the directory', () => {
    const baseDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(baseDir, { recursive: true });
    const dotDotFile = path.join(baseDir, '..data.sqlite');
    expect(isPathInsideDir(dotDotFile, baseDir)).toBe(true);

    const normalFile = path.join(baseDir, 'data.sqlite');
    expect(isPathInsideDir(normalFile, baseDir)).toBe(true);

    const outsideFile = path.join(baseDir, '..', 'outside.sqlite');
    expect(isPathInsideDir(outsideFile, baseDir)).toBe(false);
  });
});
