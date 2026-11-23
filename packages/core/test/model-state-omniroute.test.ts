/**
 * packages/core/test/model-state-omniroute.test.ts
 *
 * M1-02: OmniRoute `readRouterModelState` merges active `comboModels` into
 * `availableModels` when `!options.excludeComboModelsFromAvailability`,
 * respects disabled/tombstoned models, ignores malformed combo step entries,
 * preserves `excludeComboModelsFromAvailability: true` for stale checks,
 * and never mutates the SQLite file on disk.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBetterSqlite3, readRouterModelState } from '../src/index.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-omni-m102-'));
  tempDirs.push(dir);
  return dir;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeComboOnlyOmniDb(): string {
  const dir = createTempDir();
  const dbPath = path.join(dir, 'storage.sqlite');
  const db = openBetterSqlite3(dbPath);

  db.exec(`
    CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT);
    CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, data TEXT);
    CREATE TABLE radar_local_model_state (
      provider TEXT,
      model_id TEXT,
      enabled INTEGER,
      tombstoned INTEGER
    );
  `);

  // Hidden custom model -> disabled, while syncedAvailableModels stays empty.
  db.prepare('INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)').run(
    'customModels',
    'gamma',
    JSON.stringify([{ id: 'hidden-custom', isHidden: true }])
  );

  // Disabled via radar_local_model_state (both plain and models/-prefixed).
  const insertRadar = db.prepare(
    'INSERT INTO radar_local_model_state (provider, model_id, enabled, tombstoned) VALUES (?, ?, ?, ?)'
  );
  insertRadar.run('alpha', 'disabled-step', 0, 0);
  insertRadar.run('beta', 'models/prefixed-disabled', 1, 1);

  // Combo payload mixes valid steps, disabled steps, models/-prefixed steps, and malformed entries.
  const comboPayload = JSON.stringify({
    models: [
      { id: 's1', kind: 'model', providerId: 'alpha', model: 'active-one' },
      { id: 's2', kind: 'model', providerId: 'beta', model: 'models/prefixed-active' },
      { id: 's3', kind: 'model', providerId: 'alpha', model: 'disabled-step' },
      { id: 's4', kind: 'model', providerId: 'beta', model: 'prefixed-disabled' },
      { id: 's5', kind: 'model', providerId: 'gamma', model: 'hidden-custom' },
      null,
      '',
      '   ',
      {},
      { id: 's-missing-model', kind: 'model', providerId: 'alpha' },
      { id: 's-missing-provider', kind: 'model', model: 'orphan-model' },
      { id: 's-null-fields', providerId: null, model: null },
      'alpha/',
      '/missing-provider',
    ],
  });
  db.prepare('INSERT INTO combos (id, name, data) VALUES (?, ?, ?)').run('c1', 'omni-combo', comboPayload);
  db.close();
  return dbPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }
});

describe('M1-02: OmniRoute readRouterModelState comboModels availability merge', () => {
  it('merges active comboModels into availableModels by default, excludes disabled models, ignores malformed steps, and preserves DB sha256', () => {
    const dbPath = makeComboOnlyOmniDb();
    const beforeHash = sha256File(dbPath);

    const stateDefault = readRouterModelState('omniroute', { dbPath });
    const stateExplicitFalse = readRouterModelState('omniroute', {
      dbPath,
      excludeComboModelsFromAvailability: false,
    });

    const afterHash = sha256File(dbPath);
    expect(afterHash).toBe(beforeHash);

    for (const state of [stateDefault, stateExplicitFalse]) {
      expect(state.availableModels.size).toBeGreaterThan(0);
      expect(state.availableModels.has('alpha/active-one')).toBe(true);
      expect(state.availableModels.has('beta/prefixed-active')).toBe(true);
      expect(state.availableModels.has('beta/models/prefixed-active')).toBe(true);

      // Disabled / hidden models must never survive in availableModels or enabledModels.
      expect(state.availableModels.has('alpha/disabled-step')).toBe(false);
      expect(state.availableModels.has('beta/prefixed-disabled')).toBe(false);
      expect(state.availableModels.has('beta/models/prefixed-disabled')).toBe(false);
      expect(state.availableModels.has('gamma/hidden-custom')).toBe(false);
      expect(state.enabledModels.has('alpha/disabled-step')).toBe(false);
      expect(state.enabledModels.has('beta/prefixed-disabled')).toBe(false);
      expect(state.enabledModels.has('gamma/hidden-custom')).toBe(false);

      // Malformed entries (e.g. step id without model, empty strings, nulls) must not leak in.
      expect(state.comboModels.has('alpha/s-missing-model')).toBe(false);
      expect(state.availableModels.has('alpha/s-missing-model')).toBe(false);
      expect(state.availableModels.has('orphan-model')).toBe(false);

      // Combo-only providers must not fabricate synced provider evidence.
      expect(state.availabilityProviders.has('alpha')).toBe(false);
      expect(state.availabilityProviders.has('beta')).toBe(false);
    }
  });

  it('does NOT merge comboModels into availableModels when excludeComboModelsFromAvailability is true', () => {
    const dbPath = makeComboOnlyOmniDb();
    const beforeHash = sha256File(dbPath);

    const state = readRouterModelState('omniroute', {
      dbPath,
      availabilitySource: 'direct',
      excludeComboModelsFromAvailability: true,
    });

    const afterHash = sha256File(dbPath);
    expect(afterHash).toBe(beforeHash);

    // Active combo references are still captured in comboModels for staleness inspection,
    // but availableModels stays empty because syncedAvailableModels/aliases have no active entries.
    expect(state.comboModels.has('alpha/active-one')).toBe(true);
    expect(state.availableModels.size).toBe(0);
    expect(state.availabilityProviders.has('alpha')).toBe(false);
    expect(state.availabilityProviders.has('beta')).toBe(false);
  });
});
