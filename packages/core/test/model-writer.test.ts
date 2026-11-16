import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  enableModel9Router,
  disableModel9Router,
  addCustomModel9Router,
  rollback9RouterDisabled,
  setOmniRouteModelStatus,
  openBetterSqlite3,
  setConfiguredRouterDbPaths,
  clearConfiguredRouterDbPaths,
} from '../src/index.js';

describe('Narrow Model Writers (packages/core/src/writers/model-writer.ts)', () => {
  let tmpDir: string;
  let test9RouterDb: string;
  let testOmniRouteDb: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-writer-test-'));
    test9RouterDb = path.join(tmpDir, '9router-data.sqlite');
    testOmniRouteDb = path.join(tmpDir, 'omniroute-storage.sqlite');

    // Setup mock 9Router database
    const db9 = openBetterSqlite3(test9RouterDb);
    db9.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        createdAt TEXT,
        updatedAt TEXT,
        PRIMARY KEY (scope, key)
      );
      INSERT INTO kv (scope, key, value) VALUES
        ('disabledModels', 'fake-provider', '["model-disabled-1", "model-disabled-2"]');
    `);
    db9.close();

    // Setup mock OmniRoute database
    const dbOmni = openBetterSqlite3(testOmniRouteDb);
    dbOmni.exec(`
      CREATE TABLE IF NOT EXISTS model_capabilities (
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        status TEXT,
        PRIMARY KEY (provider, model_id)
      );
      INSERT INTO model_capabilities (provider, model_id, status) VALUES
        ('fake-provider', 'model-1', NULL),
        ('fake-provider', 'model-2', 'deprecated');
    `);
    dbOmni.close();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Live DB Safety Protection', () => {
    it('refuses to operate on live router database paths (defaults)', () => {
      // Mock APPDATA / HOME path pointing to live router
      const isWin = process.platform === 'win32';
      const livePath = isWin
        ? path.join(process.env['APPDATA'] || 'C:\\Users\\Mock\\AppData\\Roaming', '9router', 'db', 'data.sqlite') // no-secrets:allow: synthetic test path
        : path.join(os.homedir(), '.9router', 'db', 'data.sqlite');

      expect(() => {
        enableModel9Router({
          dbPath: livePath,
          provider: 'fake-provider',
          modelId: 'model-disabled-1',
        });
      }).toThrow(/Refusing to write backup directly into live router database/i);
    });

    it('refuses to operate on paths configured via environment variables (ROUTERSYNC_9ROUTER_DB)', () => {
      const origEnv = process.env['ROUTERSYNC_9ROUTER_DB'];
      const protectedPath = path.join(tmpDir, 'env-protected-live.sqlite');
      process.env['ROUTERSYNC_9ROUTER_DB'] = protectedPath;
      try {
        expect(() => {
          disableModel9Router({
            dbPath: protectedPath,
            provider: 'fake-provider',
            modelId: 'model-x',
          });
        }).toThrow(/Refusing to write backup directly into live router database/i);
      } finally {
        if (origEnv !== undefined) process.env['ROUTERSYNC_9ROUTER_DB'] = origEnv;
        else delete process.env['ROUTERSYNC_9ROUTER_DB'];
      }
    });

    it('refuses to operate on paths configured via config.yaml (setConfiguredRouterDbPaths)', () => {
      const protectedPath = path.join(tmpDir, 'config-protected-live.sqlite');
      setConfiguredRouterDbPaths({ '9router': protectedPath }, { source: 'config' });
      try {
        expect(() => {
          addCustomModel9Router({
            dbPath: protectedPath,
            provider: 'fake-provider',
            modelId: 'model-custom',
          });
        }).toThrow(/Refusing to write backup directly into live router database/i);
      } finally {
        clearConfiguredRouterDbPaths();
      }
    });
  });

  describe('9Router enableModel9Router', () => {
    it('dryRun=true calculates changes without altering database', () => {
      const res = enableModel9Router({
        dbPath: test9RouterDb,
        provider: 'fake-provider',
        modelId: 'model-disabled-1',
        dryRun: true,
      });

      expect(res.success).toBe(true);
      expect(res.changed).toBe(true);
      expect(res.dryRun).toBe(true);
      expect(res.previousState).toEqual(['model-disabled-1', 'model-disabled-2']);
      expect(res.newState).toEqual(['model-disabled-2']);

      // Verify DB was NOT modified
      const db = openBetterSqlite3(test9RouterDb, { readOnly: true });
      const row = db.prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?").get('fake-provider') as { value: string };
      expect(JSON.parse(row.value)).toEqual(['model-disabled-1', 'model-disabled-2']);
      db.close();
    });

    it('dryRun=false removes model from disabled list and verifies read-back', () => {
      const res = enableModel9Router({
        dbPath: test9RouterDb,
        provider: 'fake-provider',
        modelId: 'model-disabled-1',
        dryRun: false,
      });

      expect(res.success).toBe(true);
      expect(res.changed).toBe(true);
      expect(res.dryRun).toBe(false);
      expect(res.readBackVerified).toBe(true);
      expect(res.newState).toEqual(['model-disabled-2']);

      // Verify DB was modified
      const db = openBetterSqlite3(test9RouterDb, { readOnly: true });
      const row = db.prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?").get('fake-provider') as { value: string };
      expect(JSON.parse(row.value)).toEqual(['model-disabled-2']);
      db.close();
    });

    it('returns changed=false when model is already enabled', () => {
      const res = enableModel9Router({
        dbPath: test9RouterDb,
        provider: 'fake-provider',
        modelId: 'non-disabled-model',
        dryRun: false,
      });

      expect(res.success).toBe(true);
      expect(res.changed).toBe(false);
      expect(res.readBackVerified).toBe(true);
    });
  });

  describe('9Router disableModel9Router', () => {
    it('appends model to disabled list and supports verified rollback', () => {
      const res = disableModel9Router({
        dbPath: test9RouterDb,
        provider: 'fake-provider',
        modelId: 'model-active-to-disable',
        dryRun: false,
      });

      expect(res.success).toBe(true);
      expect(res.changed).toBe(true);
      expect(res.readBackVerified).toBe(true);
      expect(res.newState).toEqual(['model-disabled-1', 'model-disabled-2', 'model-active-to-disable']);

      // Rollback to previous state with verified read-back
      const rollbackOk = rollback9RouterDisabled({
        dbPath: test9RouterDb,
        provider: 'fake-provider',
        previousState: res.previousState,
        dryRun: false,
      });
      expect(rollbackOk).toBe(true);

      // Verify DB restored
      const db = openBetterSqlite3(test9RouterDb, { readOnly: true });
      const row = db.prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?").get('fake-provider') as { value: string };
      expect(JSON.parse(row.value)).toEqual(['model-disabled-1', 'model-disabled-2']);
      db.close();

      // Rollback on non-existent provider returns false
      const nonExistentRollback = rollback9RouterDisabled({
        dbPath: test9RouterDb,
        provider: 'non-existent-provider',
        previousState: ['some-model'],
        dryRun: false,
      });
      expect(nonExistentRollback).toBe(false);
    });

    it('creates row when provider had no previous disabledModels, and rollback deletes the row', () => {
      const res = disableModel9Router({
        dbPath: test9RouterDb,
        provider: 'brand-new-provider',
        modelId: 'first-disabled-model',
        dryRun: false,
      });

      expect(res.success).toBe(true);
      expect(res.changed).toBe(true);
      expect(res.previousState).toBeNull();
      expect(res.newState).toEqual(['first-disabled-model']);
      expect(res.readBackVerified).toBe(true);

      // Verify row exists in DB
      let db = openBetterSqlite3(test9RouterDb, { readOnly: true });
      let row = db.prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?").get('brand-new-provider');
      expect(row).toBeDefined();
      db.close();

      // Rollback with null previousState should delete the row
      const rollbackOk = rollback9RouterDisabled({
        dbPath: test9RouterDb,
        provider: 'brand-new-provider',
        previousState: res.previousState, // null
        dryRun: false,
      });
      expect(rollbackOk).toBe(true);

      // Verify row is cleanly deleted from kv
      db = openBetterSqlite3(test9RouterDb, { readOnly: true });
      row = db.prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?").get('brand-new-provider');
      expect(row).toBeUndefined();
      db.close();
    });

    it('handles row with null or empty value properly without duplicate key insert error', () => {
      // Setup row with null value
      const dbInit = openBetterSqlite3(test9RouterDb);
      dbInit.prepare("INSERT INTO kv (scope, key, value, createdAt, updatedAt) VALUES ('disabledModels', 'null-provider', null, '2026-01-01', '2026-01-01')").run();
      dbInit.close();

      const res = disableModel9Router({
        dbPath: test9RouterDb,
        provider: 'null-provider',
        modelId: 'new-dis-model',
        dryRun: false,
      });

      expect(res.success).toBe(true);
      expect(res.changed).toBe(true);
      expect(res.newState).toEqual(['new-dis-model']);
      expect(res.readBackVerified).toBe(true);
    });

    it('aborts transaction and leaves database unchanged when an error occurs during write', () => {
      const db = openBetterSqlite3(test9RouterDb);
      // Attempting transaction that throws
      expect(() => {
        db.transaction(() => {
          db.prepare("INSERT INTO kv (scope, key, value, createdAt, updatedAt) VALUES ('disabledModels', 'abort-prov', '[\"m1\"]', '2026-01-01', '2026-01-01')").run();
          throw new Error('Simulated write failure inside transaction');
        });
      }).toThrow('Simulated write failure inside transaction');

      // Verify row was rolled back and does not exist
      const row = db.prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?").get('abort-prov');
      expect(row).toBeUndefined();
      db.close();
    });

    it('writer-level rollback: aborts transaction and leaves database unchanged when writer encounters error mid-transaction', () => {
      const db = openBetterSqlite3(test9RouterDb);
      db.exec("CREATE TRIGGER fail_on_update BEFORE UPDATE ON kv BEGIN SELECT RAISE(FAIL, 'Simulated DB trigger failure mid-transaction'); END;");
      db.close();

      expect(() => {
        enableModel9Router({
          dbPath: test9RouterDb,
          provider: 'fake-provider',
          modelId: 'model-disabled-1',
          dryRun: false,
        });
      }).toThrow(/Simulated DB trigger failure mid-transaction/);

      // Verify row is unchanged in database
      const dbCheck = openBetterSqlite3(test9RouterDb, { readOnly: true });
      const row = dbCheck.prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?").get('fake-provider') as { value: string };
      expect(JSON.parse(row.value)).toEqual(['model-disabled-1', 'model-disabled-2']);
      dbCheck.close();

      // Clean up trigger
      const dbCleanup = openBetterSqlite3(test9RouterDb);
      dbCleanup.exec("DROP TRIGGER fail_on_update;");
      dbCleanup.close();
    });
  });

  describe('9Router addCustomModel9Router', () => {
    it('inserts custom model into customModels kv scope', () => {
      const res = addCustomModel9Router({
        dbPath: test9RouterDb,
        provider: 'fake-provider',
        modelId: 'custom-model-x',
        displayName: 'Custom Model X',
        type: 'llm',
        capabilities: { contextWindow: 128000 },
        dryRun: false,
      });

      expect(res.success).toBe(true);
      expect(res.changed).toBe(true);
      expect(res.readBackVerified).toBe(true);

      const db = openBetterSqlite3(test9RouterDb, { readOnly: true });
      const row = db.prepare("SELECT value FROM kv WHERE scope = 'customModels' AND key = ?").get('fake-provider|custom-model-x|llm') as { value: string };
      expect(row).toBeTruthy();
      const val = JSON.parse(row.value);
      expect(val.id).toBe('custom-model-x');
      expect(val.name).toBe('Custom Model X');
      expect(val.capabilities.contextWindow).toBe(128000);
      db.close();
    });
  });

  describe('OmniRoute setOmniRouteModelStatus', () => {
    it('throws unsupported error because radar_local_model_state is unverified with 0 rows', () => {
      expect(() =>
        setOmniRouteModelStatus({
          dbPath: testOmniRouteDb,
          provider: 'fake-provider',
          modelId: 'model-1',
          status: 'deprecated',
          dryRun: false,
        })
      ).toThrow(/unsupported.*radar_local_model_state/i);
    });
  });
});
