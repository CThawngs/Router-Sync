/**
 * test/acceptance/at-135-reader-schema.test.ts
 *
 * Acceptance Test AT-135: Reader combos table presence check & OmniRoute managed prefix (R13-3).
 *
 * Validates:
 * 1. Missing `combos` table in SQLite DB returns ok: false, meta.source: 'unavailable', meta.reason: 'schema_mismatch'.
 * 2. Daemon GET /api/v1/targets surfaces db.meta.reason: 'schema_mismatch' and omits combosManaged/Adopted.
 * 3. Daemon GET /api/v1/combos returns 0 items for the schema-mismatched router.
 * 4. OmniRoute DB combo with id starting with 'routersync-' and empty/null data is still marked managed: true.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import type * as http from 'node:http';
import { createRequire } from 'node:module';
import { createDaemonServer, clearProbeCache, readRouterCombos } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    exec(sql: string): void;
    close(): void;
  };
};

describe('Acceptance Test AT-135: Reader combos table check & OmniRoute prefix (R13-3)', () => {
  let fixture: DaemonFixture | undefined;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    fixture = await setupDaemonFixture();
    clearProbeCache();
    server = createDaemonServer({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fixture?.restore();
  });

  it('guarantee (a): missing combos table returns ok:false, reason:schema_mismatch, targets omits counts, combos returns 0 items', async () => {
    const noCombosDb = path.join(fixture!.tmpDir, 'no-combos.sqlite');
    const db = new DatabaseSync(noCombosDb);
    try {
      // Create a table that is NOT combos
      db.exec(`CREATE TABLE other_table (id TEXT PRIMARY KEY, value TEXT);`);
    } finally {
      db.close();
    }

    const origOmni = process.env['OMNIROUTE_DB_PATH'];
    process.env['OMNIROUTE_DB_PATH'] = noCombosDb;

    try {
      // 1. Direct readRouterCombos call
      const readRes = readRouterCombos('omniroute');
      expect(readRes.ok).toBe(false);
      expect(readRes.meta.source).toBe('unavailable');
      expect(readRes.meta.reason).toBe('schema_mismatch');

      // 2. Daemon GET /api/v1/targets
      const targetsRes = await fetch(`http://127.0.0.1:${port}/api/v1/targets`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(targetsRes.status).toBe(200);
      const targets = (await targetsRes.json()) as Array<{
        id: string;
        db?: {
          meta: { source: string; reason?: string };
          combosManaged?: number;
          combosAdopted?: number;
        };
      }>;

      const omni = targets.find((t) => t.id === 'omniroute');
      expect(omni).toBeDefined();
      expect(omni?.db?.meta.source).toBe('unavailable');
      expect(omni?.db?.meta.reason).toBe('schema_mismatch');
      expect(omni?.db?.combosManaged).toBeUndefined();
      expect(omni?.db?.combosAdopted).toBeUndefined();

      // 3. Daemon GET /api/v1/combos
      const combosRes = await fetch(`http://127.0.0.1:${port}/api/v1/combos`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(combosRes.status).toBe(200);
      const combosPayload = (await combosRes.json()) as
        | Array<{ id: string; targets: string[] }>
        | { combos: Array<{ id: string; targets: string[] }> };

      const comboList = Array.isArray(combosPayload)
        ? combosPayload
        : combosPayload.combos;

      const omniItems = comboList.filter((item) => item.targets.includes('omniroute'));
      expect(omniItems).toHaveLength(0);
    } finally {
      process.env['OMNIROUTE_DB_PATH'] = origOmni;
    }
  });

  it('guarantee (b): omniroute combo with routersync- prefix and empty/corrupted data marks managed: true', () => {
    const omniDbWithEmpty = path.join(fixture!.tmpDir, 'omni-empty-data.sqlite');
    const db = new DatabaseSync(omniDbWithEmpty);
    try {
      db.exec(`CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT);`);
      db.exec(`INSERT INTO combos (id, name, data) VALUES ('routersync-custom', 'routersync-custom', '');`);
    } finally {
      db.close();
    }

    const origOmni = process.env['OMNIROUTE_DB_PATH'];
    process.env['OMNIROUTE_DB_PATH'] = omniDbWithEmpty;

    try {
      const readRes = readRouterCombos('omniroute');
      expect(readRes.ok).toBe(true);
      expect(readRes.data).toBeDefined();
      expect(readRes.data?.length).toBe(1);

      const item = readRes.data?.[0];
      expect(item?.id).toBe('routersync-custom');
      expect(item?.managed).toBe(true);
    } finally {
      process.env['OMNIROUTE_DB_PATH'] = origOmni;
    }
  });

  /**
   * R14-5 (SPEC Cổng L mục 4): the managed marker for 9Router is the
   * `routersync-` id prefix (plus the RouterSync managed-id ledger) — NOT
   * `kind`. A legacy row with kind='custom' and a non-prefixed id belongs to
   * the user, so it must be counted as ADOPTED, never as managed.
   */
  it('guarantee (c): 9router row with kind=custom and no routersync- prefix is adopted, not managed', async () => {
    const nineDb = path.join(fixture!.tmpDir, '9router-custom-kind.sqlite');
    const db = new DatabaseSync(nineDb);
    try {
      db.exec(`CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT,
        models TEXT
      );`);
      db.exec(
        `INSERT INTO combos (id, name, kind, models) VALUES ('routersync-fast', 'routersync-fast', 'managed', '["m1"]');`
      );
      db.exec(
        `INSERT INTO combos (id, name, kind, models) VALUES ('my-legacy-combo', 'my-legacy-combo', 'custom', '["m2"]');`
      );
    } finally {
      db.close();
    }

    const origNine = process.env['NINEROUTER_DB_PATH'];
    process.env['NINEROUTER_DB_PATH'] = nineDb;

    try {
      // 1. Direct reader: managed must be decided by the id prefix only.
      const readRes = readRouterCombos('9router');
      expect(readRes.ok).toBe(true);
      expect(readRes.data).toHaveLength(2);

      const managedRow = readRes.data?.find((c) => c.id === 'routersync-fast');
      const customRow = readRes.data?.find((c) => c.id === 'my-legacy-combo');
      expect(managedRow?.managed).toBe(true);
      expect(customRow?.managed).toBe(false);

      // 2. Daemon /api/v1/targets: combosManaged must not count the custom row,
      //    combosAdopted must count it.
      const targetsRes = await fetch(`http://127.0.0.1:${port}/api/v1/targets`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(targetsRes.status).toBe(200);
      const targets = (await targetsRes.json()) as Array<{
        id: string;
        db?: { combosManaged?: number; combosAdopted?: number };
      }>;

      const nine = targets.find((t) => t.id === '9router');
      expect(nine).toBeDefined();
      expect(nine?.db?.combosManaged).toBe(1);
      expect(nine?.db?.combosAdopted).toBe(1);
    } finally {
      process.env['NINEROUTER_DB_PATH'] = origNine;
    }
  });
});
