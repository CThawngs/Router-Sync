/**
 * test/acceptance/at-171-omniroute-strategy-integrity.test.ts
 *
 * Acceptance Test AT-171: OmniRoute Strategy Write-Path Integrity (R29-4.4).
 *
 * Verifies that:
 * 1. An OmniRoute row whose `data` does not contain `strategy` does NOT have
 *    a `strategy` key injected when going through plan -> apply.
 * 2. On rollback from snapshot, the raw `data` string is preserved byte-for-byte.
 *
 * Mutation contract (r29-mut-omniroute-default-priority):
 * Setting `strategy: z.string().min(1).default('priority')` in OmniRouteDataPayloadSchema
 * causes `strategy: 'priority'` to be injected into applied rows, making this test FAIL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { OmniRouteAdapter } from '../../packages/adapter-omniroute/src/index.js';
import { openBetterSqlite3 } from '../../packages/core/src/index.js';
import type { Plan } from '../../packages/adapter-sdk/src/index.js';

const OMNI_DDL = `
CREATE TABLE IF NOT EXISTS combos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  system_message TEXT
);
`;

describe('Acceptance Test AT-171: OmniRoute Strategy Write-Path Integrity (R29-4.4)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-at171-'));
    dbPath = path.join(tmpDir, 'storage.sqlite');
    const db = openBetterSqlite3(dbPath, { busyTimeoutMs: 2000, allowLiveDbWrite: true });
    try {
      db.exec(OMNI_DDL);
    } finally {
      db.close();
    }
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('row with no strategy preserves byte-exact raw data on rollback and never injects strategy on apply', async () => {
    const rawDataBefore = '{"models":["gpt-4o"],"managed":true}';
    const comboId = 'routersync-fast';
    const comboName = 'RS Fast';

    // 1. Seed database with raw row lacking strategy
    const seedDb = openBetterSqlite3(dbPath, { busyTimeoutMs: 2000, allowLiveDbWrite: true });
    try {
      seedDb.prepare(
        'INSERT INTO combos (id, name, data, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(comboId, comboName, rawDataBefore, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z', 0);
    } finally {
      seedDb.close();
    }

    const adapter = new OmniRouteAdapter({ dbPath });

    // 2. Read combo and verify strategy is omitted (undefined)
    const combos = await adapter.readCombos();
    expect(combos).toHaveLength(1);
    expect(combos[0]?.strategy).toBeUndefined();

    // 3. Create snapshot before any write
    const snapshot = await adapter.createSnapshot();

    // 4. Construct plan modifying the combo
    const targetCombo = combos[0]!;
    const plan: Plan = {
      id: 'plan-at171',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      reasons: { 'routersync-fast': 'test modification without strategy' },
      additions: [],
      modifications: [
        {
          ...targetCombo,
          models: ['gpt-4o', 'claude-3-5-sonnet'],
        },
      ],
      deletions: [],
    };

    // 5. Apply plan to tmp DB
    const applyResult = await adapter.applyPlan(plan);
    expect(applyResult.success).toBe(true);

    // 6. Inspect DB row: verify strategy was NOT injected
    const verifyDb = openBetterSqlite3(dbPath, { busyTimeoutMs: 2000, readOnly: true });
    let appliedRawData = '';
    try {
      const row = verifyDb.prepare('SELECT data FROM combos WHERE id = ?').get(comboId) as { data: string } | undefined;
      expect(row).toBeDefined();
      appliedRawData = row!.data;
      const parsedApplied = JSON.parse(appliedRawData) as Record<string, unknown>;
      // Invariant: strategy must NOT be added if originally missing
      expect(parsedApplied).not.toHaveProperty('strategy');
      expect(appliedRawData).not.toContain('"strategy"');
    } finally {
      verifyDb.close();
    }

    // 7. Rollback from snapshot
    const rollbackSuccess = await adapter.rollback(snapshot);
    expect(rollbackSuccess).toBe(true);

    // 8. Inspect DB row: verify byte-exact raw data restoration
    const rollbackDb = openBetterSqlite3(dbPath, { busyTimeoutMs: 2000, readOnly: true });
    try {
      const row = rollbackDb.prepare('SELECT data FROM combos WHERE id = ?').get(comboId) as { data: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.data).toBe(rawDataBefore);
    } finally {
      rollbackDb.close();
    }
  });
});
