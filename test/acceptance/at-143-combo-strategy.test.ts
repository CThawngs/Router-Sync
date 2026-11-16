/**
 * test/acceptance/at-143-combo-strategy.test.ts
 *
 * Acceptance Test AT-143: combo `strategy` normalisation in the S1 daemon (R16-1).
 *
 * Background (real bug found on a real router in R15, reproduced here):
 * 9Router stores `settings.comboStrategies` INCONSISTENTLY. A combo created
 * long ago stores a plain string; a combo created by a newer 9Router stores
 * the object `{ fallbackStrategy: string }`. The daemon used to copy that
 * value straight into the `strategy: string` field, so `/api/v1/combos`
 * shipped an OBJECT where the contract promises a string, and the React
 * screen crashed with "Objects are not valid as a React child".
 *
 * What this test locks:
 *  1. A raw form that carries a strategy collapses to a plain string:
 *     a plain string, or `{ fallbackStrategy: string }`.
 *  2. R17-0.2: a raw form that carries NO usable strategy (object with unknown
 *     keys, null, number, array, `{ fallbackStrategy: undefined }`) and a combo
 *     with NO entry at all leave `strategy` ABSENT. The daemon used to
 *     substitute the constant 'round-robin', which the UI then printed as if
 *     the router had stored it. No repository evidence says 'round-robin' is
 *     9Router's default, so the value is not claimed.
 *  3. `strategy` is NEVER an object / array / number.
 *  4. Cross-check: for every combo where the daemon DID measure a strategy,
 *     `adapter-9router` reports the same string. The combos with no measured
 *     strategy are excluded on purpose: the adapter still applies its own
 *     constant, and this test must not paper over that difference.
 *
 * Hermetic: the fixture DB lives under os.tmpdir() and is removed afterwards.
 * No router, no real port, no token.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { readRouterCombos } from '@routersync/daemon';
import { NineRouterAdapter } from '../../packages/adapter-9router/src/index.js';
import { OmniRouteAdapter } from '../../packages/adapter-omniroute/src/index.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): void };
    close(): void;
  };
};

describe('Acceptance Test AT-143: 9Router combo strategy normalisation (R16-1)', () => {
  let tmpDir: string;
  let dbPath: string;
  let originalNineDbPath: string | undefined;

  /** The raw `comboStrategies` map 9Router may store, with every shape. */
  const RAW_STRATEGIES: Record<string, unknown> = {
    'Combo Plain String': 'priority',
    'Combo Object Form': { fallbackStrategy: 'fallback' },
    'Combo Object Unknown Key': { x: 1 },
    'Combo Null Value': null,
    'Combo Number Value': 7,
    'Combo Array Value': ['priority', 'fallback'],
    'Combo Object No Fallback Key': { fallbackStrategy: undefined },
  };

  /** Combo rows; one per raw shape plus one combo with NO settings entry. */
  const COMBO_NAMES = [
    ...Object.keys(RAW_STRATEGIES),
    'Combo Missing Entry',
  ];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routersync-at143-'));
    dbPath = path.join(tmpDir, '9router-at143.sqlite');

    const db = new DatabaseSync(dbPath);
    try {
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
      `);
      const now = new Date().toISOString();
      for (const name of COMBO_NAMES) {
        db.prepare(
          `INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(name, name, 'custom', JSON.stringify(['m1', 'm2']), now, now);
      }
      db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(
        JSON.stringify({ theme: 'dark', port: 20128, comboStrategies: RAW_STRATEGIES })
      );
    } finally {
      db.close();
    }

    originalNineDbPath = process.env['NINEROUTER_DB_PATH'];
    process.env['NINEROUTER_DB_PATH'] = dbPath;
  });

  afterAll(() => {
    if (originalNineDbPath === undefined) {
      delete process.env['NINEROUTER_DB_PATH'];
    } else {
      process.env['NINEROUTER_DB_PATH'] = originalNineDbPath;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it('keeps a measured strategy and omits an unmeasured one', () => {
    const res = readRouterCombos('9router');
    expect(res.ok).toBe(true);
    expect(res.data).toBeDefined();

    const byName = new Map((res.data ?? []).map((c) => [c.name, c]));

    // Measured: the router stored a usable value.
    expect(byName.get('Combo Plain String')?.strategy).toBe('priority');
    expect(byName.get('Combo Object Form')?.strategy).toBe('fallback');

    // Not measured: the field is ABSENT, never a guessed default.
    for (const name of [
      'Combo Object Unknown Key',
      'Combo Null Value',
      'Combo Number Value',
      'Combo Array Value',
      'Combo Object No Fallback Key',
      'Combo Missing Entry',
    ]) {
      const combo = byName.get(name);
      expect(combo, `combo "${name}" must still be returned`).toBeDefined();
      expect(
        Object.prototype.hasOwnProperty.call(combo, 'strategy'),
        `combo "${name}" must not carry a strategy field at all`
      ).toBe(false);
    }
  });

  it('never emits an object, array or number as `strategy`', () => {
    const res = readRouterCombos('9router');
    expect(res.ok).toBe(true);
    const combos = res.data ?? [];

    expect(combos.length).toBe(COMBO_NAMES.length);
    for (const combo of combos) {
      if (combo.strategy === undefined) continue;
      expect(typeof combo.strategy).toBe('string');
      expect(combo.strategy.length).toBeGreaterThan(0);
    }
    // A JSON round-trip proves the payload carries no nested object and that
    // an absent strategy stays absent (undefined is not serialised).
    const parsed = JSON.parse(JSON.stringify(res.data)) as Array<{ strategy?: unknown }>;
    for (const combo of parsed) {
      if (!Object.prototype.hasOwnProperty.call(combo, 'strategy')) continue;
      expect(typeof combo.strategy).toBe('string');
    }
  });

  it('agrees with adapter-9router for every combo (cross-check)', async () => {
    const daemon = readRouterCombos('9router');
    expect(daemon.ok).toBe(true);
    const daemonMap = new Map((daemon.data ?? []).map((c) => [c.name, c.strategy]));

    const adapter = new NineRouterAdapter({ dbPath });
    const adapterCombos = await adapter.readCombos();
    const adapterMap = new Map(adapterCombos.map((c) => [c.name, c.strategy]));

    expect(adapterMap.size).toBe(daemonMap.size);
    // R17-0.2: only the combos the daemon actually measured are compared. For
    // the rest the daemon says "not measured" while the adapter still applies
    // its own constant, and this test must not hide that difference.
    let compared = 0;
    for (const [name, strategy] of daemonMap) {
      if (strategy === undefined) continue;
      compared += 1;
      expect(
        adapterMap.get(name),
        `daemon and adapter disagree about the strategy of "${name}"`
      ).toBe(strategy);
    }
    expect(compared).toBe(2);

    // The two shared shapes are worth naming explicitly.
    expect(daemonMap.get('Combo Plain String')).toBe('priority');
    expect(daemonMap.get('Combo Object Form')).toBe('fallback');
  });
});

/**
 * R18-2 (AT-143 extension): the same question for OmniRoute, where the answer
 * is different and must be recorded instead of smoothed over.
 *
 * Where each side reads the strategy from — both from the SAME place, the top
 * level of the JSON payload in `combos.data`:
 *   - daemon:  packages/daemon/src/db/reader.ts, `parsed['strategy']`,
 *              accepted only when it is a non-empty string (R17-0.2);
 *   - adapter: packages/adapter-omniroute/src/index.ts:85,
 *              `strategy: z.string().default('priority')`.
 *
 * The adapter therefore REPORTS `'priority'` for a row that stored nothing.
 * That `'priority'` is a constant inside RouterSync's own schema, not a value
 * read from OmniRoute — the same trap R17 removed from the reader for 9Router.
 * The test pins the difference so nobody "fixes" it by accident in either
 * direction, and so the day the payload really stores the key, the first
 * assertion already covers it.
 *
 * Hermetic: the fixture DB lives under os.tmpdir() and is removed afterwards.
 */
describe('Acceptance Test AT-143 (R18-2): OmniRoute combo strategy is read, never invented', () => {
  let tmpDir: string;
  let dbPath: string;
  let originalOmniDbPath: string | undefined;

  /** Row id -> the JSON payload put in `combos.data`. */
  const PAYLOADS: Record<string, string> = {
    'omni-with-strategy': '{"strategy":"weighted","models":["m1","m2"],"managed":true}',
    'omni-without-strategy': '{"models":["m3"],"managed":false}',
    'omni-object-strategy': '{"strategy":{"fallbackStrategy":"x"},"models":["m4"]}',
    'omni-empty-strategy': '{"strategy":"","models":["m5"]}',
  };

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routersync-at143-omni-'));
    dbPath = path.join(tmpDir, 'omniroute-at143.sqlite');

    const db = new DatabaseSync(dbPath);
    try {
      // Column set taken from the adapter's own schema fingerprint
      // (packages/adapter-omniroute/src/index.ts, `tableName: 'combos'`).
      db.exec(`
        CREATE TABLE combos (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          system_message TEXT DEFAULT NULL,
          tool_filter_regex TEXT DEFAULT NULL,
          context_cache_protection INTEGER DEFAULT 0
        );
      `);
      const now = new Date().toISOString();
      for (const [id, payload] of Object.entries(PAYLOADS)) {
        db.prepare(
          `INSERT INTO combos (id, name, data, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, id, payload, now, now, 0);
      }
    } finally {
      db.close();
    }

    originalOmniDbPath = process.env['OMNIROUTE_DB_PATH'];
    process.env['OMNIROUTE_DB_PATH'] = dbPath;
  });

  afterAll(() => {
    if (originalOmniDbPath === undefined) {
      delete process.env['OMNIROUTE_DB_PATH'];
    } else {
      process.env['OMNIROUTE_DB_PATH'] = originalOmniDbPath;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it('reports the stored strategy and omits the ones that are missing or unusable', () => {
    const res = readRouterCombos('omniroute');
    expect(res.ok).toBe(true);
    const byId = new Map((res.data ?? []).map((c) => [c.id, c]));

    expect(byId.get('omni-with-strategy')?.strategy).toBe('weighted');

    for (const id of ['omni-without-strategy', 'omni-object-strategy', 'omni-empty-strategy']) {
      const combo = byId.get(id);
      expect(combo, `combo "${id}" must still be returned`).toBeDefined();
      expect(
        Object.prototype.hasOwnProperty.call(combo, 'strategy'),
        `combo "${id}" must not carry a strategy field at all`
      ).toBe(false);
    }
  });

  it('records agreement with adapter-omniroute: missing or invalid strategy is omitted, never invented', async () => {
    const daemon = readRouterCombos('omniroute');
    const daemonMap = new Map((daemon.data ?? []).map((c) => [c.id, c.strategy]));

    const adapter = new OmniRouteAdapter({ dbPath });
    const adapterMap = new Map((await adapter.readCombos()).map((c) => [c.id, c.strategy]));

    // Agreement where the router really stored a string.
    expect(adapterMap.get('omni-with-strategy')).toBe('weighted');
    expect(daemonMap.get('omni-with-strategy')).toBe('weighted');

    // R21-1 (DECISIONS 2026-10-22-02 resolved): Both adapter and daemon omit strategy
    // when not stored. The adapter no longer invents 'priority'.
    expect(adapterMap.get('omni-without-strategy')).toBeUndefined();
    expect(daemonMap.get('omni-without-strategy')).toBeUndefined();

    // A payload whose `strategy` is not a string fails Zod validation:
    // the adapter now omits strategy instead of substituting 'priority'.
    expect(adapterMap.get('omni-object-strategy')).toBeUndefined();
    expect(daemonMap.get('omni-object-strategy')).toBeUndefined();

    expect(adapterMap.get('omni-empty-strategy')).toBeUndefined();
    expect(daemonMap.get('omni-empty-strategy')).toBeUndefined();
  });
});
