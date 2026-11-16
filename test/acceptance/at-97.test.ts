/**
 * test/acceptance/at-97.test.ts
 *
 * AT-97 Acceptance Test:
 *  - Router has a schema not matching the known fingerprint:
 *    adapter refuses write, keeps read-only, clearly reports mismatch,
 *    and no changes are written to the database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { OmniRouteAdapter } from '../../packages/adapter-omniroute/src/index.js';
import { NineRouterAdapter } from '../../packages/adapter-9router/src/index.js';
import { openBetterSqlite3 } from '../../packages/core/src/index.js';
import type { Plan } from '@routersync/adapter-sdk';

describe('Acceptance Test AT-97: Unknown or Modified Schema Write Protection', () => {
  let tmpOmniPath: string;
  let tmpNinePath: string;

  beforeEach(() => {
    tmpOmniPath = path.join(
      os.tmpdir(),
      `at97_omni_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sqlite`
    );
    tmpNinePath = path.join(
      os.tmpdir(),
      `at97_nine_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sqlite`
    );
  });

  afterEach(() => {
    for (const f of [tmpOmniPath, tmpNinePath]) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  });

  it('OmniRoute: refuses write when schema is missing required columns, zero DB changes', async () => {
    // Corrupt schema: missing `data` column
    const db = openBetterSqlite3(tmpOmniPath);
    db.exec(`
      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        system_message TEXT DEFAULT NULL
      );
    `);
    db.close();

    const adapter = new OmniRouteAdapter({ dbPath: tmpOmniPath });

    const plan: Plan = {
      id: 'plan_at97_1',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'new-combo',
          name: 'New Combo',
          strategy: 'priority',
          models: ['m1'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const res = await adapter.applyPlan(plan);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/schema mismatch/i);
    expect(res.error).toMatch(/data/i);

    // Verify ZERO changes in DB
    const dbVerify = openBetterSqlite3(tmpOmniPath, { readOnly: true });
    const count = (dbVerify.prepare('SELECT count(*) as c FROM combos').get() as { c: number }).c;
    expect(count).toBe(0);
    dbVerify.close();
  });

  it('9Router: refuses write when settings table is missing, zero DB changes', async () => {
    // Only combos table exists, settings table is missing
    const db = openBetterSqlite3(tmpNinePath);
    db.exec(`
      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        models TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    db.close();

    const adapter = new NineRouterAdapter({ dbPath: tmpNinePath, isolated: true });

    const plan: Plan = {
      id: 'plan_at97_2',
      target: '9router',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'combo-nine',
          name: 'Nine Combo',
          strategy: 'round-robin',
          models: ['m1'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const res = await adapter.applyPlan(plan);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/schema mismatch/i);
    expect(res.error).toMatch(/settings/i);

    // Verify ZERO changes in DB
    const dbVerify = openBetterSqlite3(tmpNinePath, { readOnly: true });
    const count = (dbVerify.prepare('SELECT count(*) as c FROM combos').get() as { c: number }).c;
    expect(count).toBe(0);
    dbVerify.close();
  });
});
