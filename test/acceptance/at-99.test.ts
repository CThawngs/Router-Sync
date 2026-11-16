/**
 * test/acceptance/at-99.test.ts
 *
 * Acceptance Test AT-99 (Condition A6 & Spec §31.9):
 *  - Enforces write guard: all write drivers must target paths strictly inside os.tmpdir().
 *  - Live router DBs are opened strictly read-only or copied via SQLite backup API.
 *  - Temporary test copies created inside a dedicated mkdtemp directory and wiped in afterAll/finally.
 *  - Strictly asserts LOGICAL HASH (canonical JSON of combos and settings.comboStrategies sorted by id)
 *    of live DBs before and after the entire test suite are 100% identical.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { OmniRouteAdapter } from '../../packages/adapter-omniroute/src/index.js';
import { NineRouterAdapter } from '../../packages/adapter-9router/src/index.js';
import { backupAsync, openBetterSqlite3 } from '../../packages/core/src/index.js';
import type { Plan } from '@routersync/adapter-sdk';

function assertWriteDirSafe(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  const tmpDirResolved = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tmpDirResolved)) {
    throw new Error(`[AT-99 SAFETY GUARD] Write operation disallowed outside os.tmpdir(): ${targetPath}`);
  }
}

function computeOmniLogicalHash(dbPath: string): string {
  if (!fs.existsSync(dbPath)) return 'FILE_NOT_FOUND';
  const db = openBetterSqlite3(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT id, name, data, sort_order, system_message FROM combos ORDER BY id ASC')
      .all();
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  } finally {
    db.close();
  }
}

function computeNineLogicalHash(dbPath: string): string {
  if (!fs.existsSync(dbPath)) return 'FILE_NOT_FOUND';
  const db = openBetterSqlite3(dbPath, { readOnly: true });
  try {
    const combos = db
      .prepare('SELECT id, name, kind, models FROM combos ORDER BY id ASC')
      .all();
    let comboStrategies: Record<string, unknown> = {};
    const settingsRow = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
    if (settingsRow) {
      try {
        const parsed = JSON.parse(settingsRow.data) as Record<string, unknown>;
        comboStrategies = (parsed['comboStrategies'] as Record<string, unknown>) ?? {};
      } catch {}
    }
    const payload = { combos, comboStrategies };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  } finally {
    db.close();
  }
}

describe('Acceptance Test AT-99: Real DB Copy Contract Test & Zero Live Modification Verification', () => {
  const liveOmniDb = path.join(os.homedir(), '.omniroute', 'storage.sqlite');
  const liveNineDb = path.join(
    process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    '9router',
    'db',
    'data.sqlite'
  );

  let preOmniLogicalHash = '';
  let preNineLogicalHash = '';

  let testTmpDir = '';
  let tmpOmniCopy = '';
  let tmpNineCopy = '';

  beforeAll(async () => {
    // 1. Create dedicated mkdtemp directory for isolated test execution
    testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_at99_work_'));
    tmpOmniCopy = path.join(testTmpDir, 'omni_copy.sqlite');
    tmpNineCopy = path.join(testTmpDir, 'nine_copy.sqlite');

    // 2. Assert safety guard on write targets
    assertWriteDirSafe(tmpOmniCopy);
    assertWriteDirSafe(tmpNineCopy);

    // 3. Record pre-test logical hashes of live DBs
    preOmniLogicalHash = computeOmniLogicalHash(liveOmniDb);
    preNineLogicalHash = computeNineLogicalHash(liveNineDb);

    console.log(`[AT-99] Pre-test live OmniRoute logical hash: ${preOmniLogicalHash.slice(0, 16)}...`);
    console.log(`[AT-99] Pre-test live 9Router logical hash:   ${preNineLogicalHash.slice(0, 16)}...`);

    // 4. Safe read-only copy of OmniRoute DB via SQLite backup API
    if (fs.existsSync(liveOmniDb)) {
      await backupAsync(liveOmniDb, tmpOmniCopy);
      console.log(`[AT-99] OmniRoute: backed up live DB using SQLite backup API to tmpdir`);
    } else {
      const db = openBetterSqlite3(tmpOmniCopy);
      db.exec(`
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
      db.close();
      console.log(`[AT-99] OmniRoute: live DB not found, created schema fixture (FIXTURE-ONLY)`);
    }

    // 5. Safe read-only copy of 9Router DB via SQLite backup API
    if (fs.existsSync(liveNineDb)) {
      await backupAsync(liveNineDb, tmpNineCopy);
      console.log(`[AT-99] 9Router: backed up live DB using SQLite backup API to tmpdir`);
    } else {
      const db = openBetterSqlite3(tmpNineCopy);
      db.exec(`
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
        INSERT INTO settings (id, data) VALUES (1, '{}');
      `);
      db.close();
      console.log(`[AT-99] 9Router: live DB not found, created schema fixture (FIXTURE-ONLY)`);
    }
  }, 30000);

  afterAll(() => {
    // 6. Record post-test logical hashes of live DBs and verify STRICT EQUALITY
    const postOmniLogicalHash = computeOmniLogicalHash(liveOmniDb);
    const postNineLogicalHash = computeNineLogicalHash(liveNineDb);

    console.log(`[AT-99] Post-test live OmniRoute logical hash: ${postOmniLogicalHash.slice(0, 16)}...`);
    console.log(`[AT-99] Post-test live 9Router logical hash:   ${postNineLogicalHash.slice(0, 16)}...`);

    try {
      if (fs.existsSync(liveOmniDb)) {
        expect(postOmniLogicalHash).toBe(preOmniLogicalHash);
      }
      if (fs.existsSync(liveNineDb)) {
        expect(postNineLogicalHash).toBe(preNineLogicalHash);
      }
    } finally {
      // 7. Clean up temporary directory
      if (testTmpDir && fs.existsSync(testTmpDir)) {
        try {
          fs.rmSync(testTmpDir, { recursive: true, force: true });
        } catch {}
      }
    }
  }, 30000);

  it('runs full contract test on OmniRoute copy in tmpdir', async () => {
    assertWriteDirSafe(tmpOmniCopy);
    const adapter = new OmniRouteAdapter({ dbPath: tmpOmniCopy });

    // Snapshot
    const snapshot = await adapter.createSnapshot();
    expect(snapshot.target).toBe('omniroute');

    // Read combos
    const initialCombos = await adapter.readCombos();
    expect(Array.isArray(initialCombos)).toBe(true);

    // Write a test combo into tmp copy
    const testId = `contract_test_${Date.now()}`;
    const plan: Plan = {
      id: 'plan_contract_omni',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: testId,
          name: `Contract Test Omni ${Date.now()}`,
          strategy: 'priority',
          models: ['provider/model-x'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const res = await adapter.applyPlan(plan);
    expect(res.success).toBe(true);
    expect(res.readBackVerified).toBe(true);

    // Rollback tmp copy to initial snapshot
    const rolledBack = await adapter.rollback(snapshot);
    expect(rolledBack).toBe(true);

    const afterRollback = await adapter.readCombos();
    expect(afterRollback.length).toBe(initialCombos.length);
  });

  it('runs full contract test on 9Router copy in tmpdir', async () => {
    assertWriteDirSafe(tmpNineCopy);
    const adapter = new NineRouterAdapter({ dbPath: tmpNineCopy, isolated: true });

    // Snapshot
    const snapshot = await adapter.createSnapshot();
    expect(snapshot.target).toBe('9router');

    // Read combos
    const initialCombos = await adapter.readCombos();
    expect(Array.isArray(initialCombos)).toBe(true);

    // Write a test combo into tmp copy
    const testId = `contract_test_${Date.now()}`;
    const plan: Plan = {
      id: 'plan_contract_nine',
      target: '9router',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: testId,
          name: `Contract Test Nine ${Date.now()}`,
          strategy: 'fallback',
          models: ['oc/space-bunny-free'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const res = await adapter.applyPlan(plan);
    expect(res.success).toBe(true);
    expect(res.readBackVerified).toBe(true);

    // Rollback tmp copy to initial snapshot
    const rolledBack = await adapter.rollback(snapshot);
    expect(rolledBack).toBe(true);

    const afterRollback = await adapter.readCombos();
    expect(afterRollback.length).toBe(initialCombos.length);
  });
});
