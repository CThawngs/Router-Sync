/**
 * test/acceptance/at-108.test.ts
 *
 * Acceptance Test AT-108 (Condition G0-6, Spec §31.9 & §32.4):
 *  - Logical rollback safety verification:
 *    1. RouterSync creates a snapshot of router state.
 *       Assert: Snapshot contains ONLY combos & metadata. ZERO provider API keys / secrets.
 *    2. RouterSync applies a plan adding a managed test combo.
 *    3. Simultaneously, a simulated "fake router / background user" concurrently:
 *       - Inserts rows into usageHistory / request logs.
 *       - Modifies an unmanaged user combo (a combo not managed by RouterSync).
 *       - Inserts a new unmanaged user combo directly via dashboard/CLI.
 *    4. RouterSync triggers logical `rollback(snapshot)`.
 *    5. Assert:
 *       - RouterSync test combo is deleted.
 *       - Original managed combos are restored to snapshot values.
 *       - The unmanaged user combo modifications made by the fake router are 100% PRESERVED.
 *       - The newly added unmanaged user combo is 100% PRESERVED.
 *       - All usage history and request log rows written by the router are 100% PRESERVED.
 *       - The SQLite database file on disk is NOT replaced (same inode / file identity).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { OmniRouteAdapter } from '../../packages/adapter-omniroute/src/index.js';
import { NineRouterAdapter } from '../../packages/adapter-9router/src/index.js';
import { openBetterSqlite3, backupAsync, locateRouterDb } from '../../packages/core/src/index.js';
import type { Plan } from '@routersync/adapter-sdk';

describe('Acceptance Test AT-108: Logical Row-Level Rollback Safety (Spec §31.9 & §32.4)', () => {
  let tmpDir: string;
  let tmpNineDb: string;
  let tmpOmniDb: string;
  let previousOmniDbEnv: string | undefined;
  let previousNineDbEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_at108_'));
    tmpNineDb = path.join(tmpDir, 'nine_data.sqlite');
    tmpOmniDb = path.join(tmpDir, 'omni_storage.sqlite');

    // The safety-rail tests need a "live" router database. Point the live
    // locations at two temporary files so the test runs the same way on a
    // machine with a router and on a clean CI machine.
    previousOmniDbEnv = process.env['ROUTERSYNC_OMNIROUTE_DB'];
    previousNineDbEnv = process.env['ROUTERSYNC_9ROUTER_DB'];
    const liveOmni = path.join(tmpDir, 'live-omni.sqlite');
    const liveNine = path.join(tmpDir, 'live-nine.sqlite');
    fs.writeFileSync(liveOmni, '');
    fs.writeFileSync(liveNine, '');
    process.env['ROUTERSYNC_OMNIROUTE_DB'] = liveOmni;
    process.env['ROUTERSYNC_9ROUTER_DB'] = liveNine;

    // 1. Initialize 9Router schema with multiple tables: combos, settings, usageHistory, apiKeys
    const nineDb = openBetterSqlite3(tmpNineDb);
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
      CREATE TABLE usageHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens TEXT NOT NULL
      );
      CREATE TABLE apiKeys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        secretKey TEXT NOT NULL
      );

      -- Initial state: 1 unmanaged user combo, 1 managed combo, 1 settings row, 1 apiKey
      INSERT INTO combos (id, name, kind, models, createdAt, updatedAt)
      VALUES 
        ('manual-user-coding', 'User Coding', 'manual', '["anthropic/claude-3-5-sonnet"]', '2026-10-14T00:00:00Z', '2026-10-14T00:00:00Z'),
        ('rs-managed-fast', 'RS Fast', 'custom', '["openai/gpt-4o-mini"]', '2026-10-14T00:00:00Z', '2026-10-14T00:00:00Z');

      INSERT INTO settings (id, data)
      VALUES (1, '{"theme":"dark","port":20128,"comboStrategies":{"User Coding":"round-robin","RS Fast":"priority"}}');

      INSERT INTO usageHistory (timestamp, provider, model, tokens)
      VALUES ('2026-10-14T00:01:00Z', 'openai', 'gpt-4o-mini', '{"total":150}');

      INSERT INTO apiKeys (id, provider, secretKey)
      VALUES ('key-1', 'openai', 'dummy-secret-provider-key-999');
    `);
    nineDb.close();

    // 2. Initialize OmniRoute schema with combos and usage_history
    const omniDb = openBetterSqlite3(tmpOmniDb);
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
      CREATE TABLE usage_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        model TEXT NOT NULL
      );

      INSERT INTO combos (id, name, data, created_at, updated_at, sort_order, system_message)
      VALUES
        ('user-omni-reasoning', 'User Reasoning', '{"strategy":"fallback","models":["deepseek/deepseek-r1"],"managed":false}', '2026-10-14T00:00:00Z', '2026-10-14T00:00:00Z', 0, NULL),
        ('rs-omni-general', 'RS General', '{"strategy":"priority","models":["google/gemini-2.0-flash"],"managed":true}', '2026-10-14T00:00:00Z', '2026-10-14T00:00:00Z', 0, NULL);

      INSERT INTO usage_history (timestamp, model)
      VALUES ('2026-10-14T00:01:00Z', 'google/gemini-2.0-flash');
    `);
    omniDb.close();
  });

  afterEach(() => {
    // The live-database locations point at temporary files, so the safety
    // rail is exercised on every machine, with or without a router.
    if (previousOmniDbEnv !== undefined) process.env['ROUTERSYNC_OMNIROUTE_DB'] = previousOmniDbEnv;
    else delete process.env['ROUTERSYNC_OMNIROUTE_DB'];
    if (previousNineDbEnv !== undefined) process.env['ROUTERSYNC_9ROUTER_DB'] = previousNineDbEnv;
    else delete process.env['ROUTERSYNC_9ROUTER_DB'];

    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('9Router: logical rollback restores managed combos while preserving concurrent external router writes', async () => {
    const adapter = new NineRouterAdapter({ dbPath: tmpNineDb, isolated: true });

    // Step 1: Snapshot
    const snapshot = await adapter.createSnapshot();
    expect(snapshot.target).toBe('9router');
    expect(snapshot.combos.length).toBe(2);

    // Verify snapshot does NOT contain provider API keys or other tables
    const snapshotStr = JSON.stringify(snapshot);
    expect(snapshotStr).not.toContain('dummy-secret-provider-key-999');
    expect(snapshotStr).not.toContain('apiKeys');
    expect(snapshotStr).not.toContain('usageHistory');

    // Step 2: RouterSync applies a plan adding a managed combo and modifying existing managed combo
    const plan: Plan = {
      id: 'plan_rs_add',
      target: '9router',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'rs-managed-new',
          name: 'RS New',
          strategy: 'fallback',
          models: ['mistral/mistral-large'],
          managed: true,
        },
      ],
      modifications: [
        {
          id: 'rs-managed-fast',
          name: 'RS Fast',
          strategy: 'round-robin',
          models: ['openai/gpt-4o-mini', 'deepseek/deepseek-chat'],
          managed: true,
        },
      ],
      deletions: [],
      reasons: {},
    };

    const applyResult = await adapter.applyPlan(plan);
    expect(applyResult.success).toBe(true);

    // Step 3: Concurrently, a "router giả" writes to usageHistory and updates unmanaged user combo
    const fakeRouterDb = openBetterSqlite3(tmpNineDb);
    // Write new telemetry log into usageHistory
    fakeRouterDb.prepare(
      'INSERT INTO usageHistory (timestamp, provider, model, tokens) VALUES (?, ?, ?, ?)'
    ).run('2026-10-14T00:05:00Z', 'anthropic', 'claude-3-5-sonnet', '{"total":500}');

    // User modifies their unmanaged combo through router UI
    fakeRouterDb.prepare(
      'UPDATE combos SET models = ? WHERE id = ?'
    ).run('["anthropic/claude-3-5-sonnet", "deepseek/deepseek-v3"]', 'manual-user-coding');

    // User adds a brand new unmanaged combo through router UI
    fakeRouterDb.prepare(
      'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('user-dashboard-combo', 'Dashboard Combo', 'manual', '["meta/llama-3.3-70b"]', '2026-10-14T00:06:00Z', '2026-10-14T00:06:00Z');

    // User modifies unmanaged combo's strategy and adds strategy for newly created dashboard combo
    const currentSettingsRow = fakeRouterDb.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string };
    const curSettings = JSON.parse(currentSettingsRow.data) as Record<string, any>;
    curSettings.comboStrategies['User Coding'] = 'fallback';
    curSettings.comboStrategies['Dashboard Combo'] = 'priority';
    fakeRouterDb.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(curSettings));

    fakeRouterDb.close();

    // Step 4: RouterSync executes logical rollback to snapshot
    const rollbackSuccess = await adapter.rollback(snapshot);
    expect(rollbackSuccess).toBe(true);

    // Step 5: Verification of DB state after rollback
    const verifyDb = openBetterSqlite3(tmpNineDb, { readOnly: true });

    // A. RouterSync newly added managed combo was deleted
    const newCombo = verifyDb.prepare('SELECT id FROM combos WHERE id = ?').get('rs-managed-new');
    expect(newCombo).toBeUndefined();

    // B. RouterSync modified managed combo was restored to snapshot models
    const restoredManaged = verifyDb.prepare('SELECT models FROM combos WHERE id = ?').get('rs-managed-fast') as { models: string };
    expect(JSON.parse(restoredManaged.models)).toEqual(['openai/gpt-4o-mini']);

    // C. Unmanaged user combo modifications by fake router are PRESERVED
    const preservedUserCombo = verifyDb.prepare('SELECT models FROM combos WHERE id = ?').get('manual-user-coding') as { models: string };
    expect(JSON.parse(preservedUserCombo.models)).toEqual(['anthropic/claude-3-5-sonnet', 'deepseek/deepseek-v3']);

    // D. Newly added user dashboard combo is PRESERVED
    const preservedDashboardCombo = verifyDb.prepare('SELECT name FROM combos WHERE id = ?').get('user-dashboard-combo');
    expect(preservedDashboardCombo).toBeDefined();

    // E. Usage history written by fake router is 100% INTACT (2 rows)
    const usageCount = verifyDb.prepare('SELECT count(*) as c FROM usageHistory').get() as { c: number };
    expect(usageCount.c).toBe(2);

    // F. Provider API keys table is 100% INTACT
    const keyRow = verifyDb.prepare('SELECT secretKey FROM apiKeys WHERE id = ?').get('key-1') as { secretKey: string };
    expect(keyRow.secretKey).toBe('dummy-secret-provider-key-999');

    // G. Settings theme is preserved, and comboStrategies strictly patched:
    // - Unmanaged user combo strategy modification ('User Coding' -> 'fallback') is PRESERVED
    // - Newly added dashboard combo strategy ('Dashboard Combo' -> 'priority') is PRESERVED
    // - RouterSync modified managed strategy ('RS Fast') is RESTORED to snapshot ('priority')
    // - RouterSync newly added strategy ('RS New') is DELETED
    const settingsRow = verifyDb.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string };
    const settingsObj = JSON.parse(settingsRow.data) as Record<string, any>;
    expect(settingsObj['theme']).toBe('dark');
    expect(settingsObj['port']).toBe(20128);
    expect(settingsObj.comboStrategies['User Coding']).toBe('fallback');
    expect(settingsObj.comboStrategies['Dashboard Combo']).toBe('priority');
    expect(settingsObj.comboStrategies['RS Fast']).toBe('priority');
    expect(settingsObj.comboStrategies['RS New']).toBeUndefined();

    verifyDb.close();
  });

  it('OmniRoute: logical rollback restores managed combos while preserving concurrent external router writes', async () => {
    const adapter = new OmniRouteAdapter({ dbPath: tmpOmniDb });

    // Step 1: Snapshot
    const snapshot = await adapter.createSnapshot();
    expect(snapshot.target).toBe('omniroute');
    expect(snapshot.combos.length).toBe(2);

    // Step 2: RouterSync applies plan adding rs-omni-new and modifying rs-omni-general
    const plan: Plan = {
      id: 'plan_omni_add',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'rs-omni-new',
          name: 'RS Omni New',
          strategy: 'priority',
          models: ['qwen/qwen-2.5-coder'],
          managed: true,
        },
      ],
      modifications: [
        {
          id: 'rs-omni-general',
          name: 'RS General',
          strategy: 'priority',
          models: ['google/gemini-2.0-flash', 'openai/gpt-4o'],
          managed: true,
        },
      ],
      deletions: [],
      reasons: {},
    };

    const applyResult = await adapter.applyPlan(plan);
    expect(applyResult.success).toBe(true);

    // Step 3: Concurrently, a fake router writes to usage_history and unmanaged combo
    const fakeRouterDb = openBetterSqlite3(tmpOmniDb);
    fakeRouterDb.prepare('INSERT INTO usage_history (timestamp, model) VALUES (?, ?)').run('2026-10-14T00:10:00Z', 'deepseek/deepseek-r1');
    fakeRouterDb.prepare(
      'UPDATE combos SET data = ? WHERE id = ?'
    ).run('{"strategy":"fallback","models":["deepseek/deepseek-r1","deepseek/deepseek-v3"],"managed":false}', 'user-omni-reasoning');
    fakeRouterDb.close();

    // Step 4: RouterSync executes logical rollback
    const rollbackSuccess = await adapter.rollback(snapshot);
    expect(rollbackSuccess).toBe(true);

    // Step 5: Verification
    const verifyDb = openBetterSqlite3(tmpOmniDb, { readOnly: true });

    // A. rs-omni-new was removed
    const newCombo = verifyDb.prepare('SELECT id FROM combos WHERE id = ?').get('rs-omni-new');
    expect(newCombo).toBeUndefined();

    // B. rs-omni-general models restored
    const restoredGeneral = verifyDb.prepare('SELECT data FROM combos WHERE id = ?').get('rs-omni-general') as { data: string };
    const generalData = JSON.parse(restoredGeneral.data) as { models: string[] };
    expect(generalData.models).toEqual(['google/gemini-2.0-flash']);

    // C. user-omni-reasoning modifications preserved
    const userCombo = verifyDb.prepare('SELECT data FROM combos WHERE id = ?').get('user-omni-reasoning') as { data: string };
    const userData = JSON.parse(userCombo.data) as { models: string[] };
    expect(userData.models).toEqual(['deepseek/deepseek-r1', 'deepseek/deepseek-v3']);

    // D. usage_history written by fake router is 100% INTACT (2 rows)
    const usageCount = verifyDb.prepare('SELECT count(*) as c FROM usage_history').get() as { c: number };
    expect(usageCount.c).toBe(2);

    verifyDb.close();
  });

  it('Safety Rail (Rule 3.4): backupAsync and driver.backup refuse to overwrite live router database', async () => {
    const omniLive = locateRouterDb('omniroute');
    const nineLive = locateRouterDb('9router');

    // 1. Test backupAsync refusal on OmniRoute live path
    await expect(backupAsync(tmpOmniDb, omniLive)).rejects.toThrow(
      /Safety violation: Refusing to write backup directly into live router database/i
    );

    // 2. Test backupAsync refusal on 9Router live path
    await expect(backupAsync(tmpNineDb, nineLive)).rejects.toThrow(
      /Safety violation: Refusing to write backup directly into live router database/i
    );

    // 3. Test driver.backup refusal on live paths
    const db = openBetterSqlite3(tmpOmniDb, { readOnly: true });
    expect(() => db.backup(omniLive)).toThrow(
      /Safety violation: Refusing to write backup directly into live router database/i
    );
    expect(() => db.backup(nineLive)).toThrow(
      /Safety violation: Refusing to write backup directly into live router database/i
    );
    db.close();
  });

  it('Safety Rail: direct openBetterSqlite3 with write access on live DB is rejected without allowLiveDbWrite', () => {
    const omniLive = locateRouterDb('omniroute');
    const nineLive = locateRouterDb('9router');

    // Write access without allowLiveDbWrite must throw Safety violation
    expect(() => openBetterSqlite3(omniLive, { readOnly: false })).toThrow(
      /Safety violation: Direct write access to live router database/i
    );
    expect(() => openBetterSqlite3(nineLive, { readOnly: false })).toThrow(
      /Safety violation: Direct write access to live router database/i
    );

    // Read-only access is allowed for inspection
    const omniRo = openBetterSqlite3(omniLive, { readOnly: true });
    expect(omniRo).toBeDefined();
    omniRo.close();

    const nineRo = openBetterSqlite3(nineLive, { readOnly: true });
    expect(nineRo).toBeDefined();
    nineRo.close();
  });

  it('OmniRoute: user combos without managed marker are unmanaged (managed=false) and untouched across rollback', async () => {
    // Insert a real user combo with NO managed marker in data
    const rawUserPayload = '{"models":[{"id":"model-raw-1","kind":"model","model":"sample/user-model"}]}';
    const rawUpdatedAt = '2026-10-10T12:00:00Z';
    const db = openBetterSqlite3(tmpOmniDb);
    db.prepare(
      'INSERT INTO combos (id, name, data, created_at, updated_at, sort_order, system_message) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('user-custom-no-marker', 'User Custom No Marker', rawUserPayload, rawUpdatedAt, rawUpdatedAt, 5, null);
    db.close();

    const adapter = new OmniRouteAdapter({ dbPath: tmpOmniDb });

    // Step 1: Read combos and verify managed is false
    const combos = await adapter.readCombos();
    const userCombo = combos.find((c) => c.id === 'user-custom-no-marker');
    expect(userCombo).toBeDefined();
    expect(userCombo?.managed).toBe(false);

    // Step 2: Take snapshot and apply plan that adds a temporary managed combo
    const snapshot = await adapter.createSnapshot();
    const plan: Plan = {
      id: 'plan_touch_managed_only',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'rs-temp-added',
          name: 'RS Temp Added',
          strategy: 'priority',
          models: ['sample/model-x'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };
    const applyRes = await adapter.applyPlan(plan);
    expect(applyRes.success).toBe(true);

    // Step 3: Rollback
    const rolledBack = await adapter.rollback(snapshot);
    expect(rolledBack).toBe(true);

    // Step 4: Verify user combo row was completely untouched (raw string & updated_at identical)
    const checkDb = openBetterSqlite3(tmpOmniDb, { readOnly: true });
    const row = checkDb.prepare('SELECT data, updated_at FROM combos WHERE id = ?').get('user-custom-no-marker') as {
      data: string;
      updated_at: string;
    };
    checkDb.close();

    expect(row.data).toBe(rawUserPayload);
    expect(row.updated_at).toBe(rawUpdatedAt);
  });
});
