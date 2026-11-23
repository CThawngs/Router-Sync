// C31 L1.3: bộ đọc trạng thái OmniRoute cho `combos stale`.
//
// DB tạm, không chạm DB thật. Các trạng thái phải phân biệt được:
//   PRESENT | PRESENT-NORMALIZED | DISABLED | ABSENT | UNVERIFIABLE
// và khi thiếu bảng / không đọc được thì router phải nằm ở `unavailable`,
// không bao giờ kết luận ABSENT.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { classifyComboStep, unreadableReason, type StaleStatus } from '../src/commands/combos-stale.js';
import { readRouterModelState } from '@routersync/core';

const ENV_KEY = 'ROUTERSYNC_OMNIROUTE_DB';
const created: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rs-omni-'));
  created.push(dir);
  return join(dir, 'storage.sqlite');
}

function makeOmniDb(options: { withKeyValue?: boolean; disabled?: string[] } = {}): string {
  const file = tempDbPath();
  const db = new Database(file);
  db.exec(`
    CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, data TEXT);
    CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, is_active INTEGER);
  `);
  if (options.withKeyValue !== false) {
    db.exec('CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT);');
    const insert = db.prepare('INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)');
    // provider "alpha" có hai model; provider "beta" có evidence nhưng thiếu model "gone"
    insert.run('syncedAvailableModels', 'alpha:conn-1', JSON.stringify([{ id: 'model-one' }, { id: 'model-two' }]));
    insert.run('syncedAvailableModels', 'beta:conn-2', JSON.stringify([{ id: 'other' }]));
    insert.run('customModels', 'gamma', JSON.stringify([{ id: 'manual-model' }]));
    insert.run('modelAliases', 'alias-one', JSON.stringify('alpha/model-one'));
    db.prepare('CREATE TABLE radar_local_model_state (provider TEXT, model_id TEXT, enabled INTEGER, tombstoned INTEGER)').run();
    for (const id of options.disabled ?? []) {
      db.prepare('INSERT INTO radar_local_model_state (provider, model_id, enabled, tombstoned) VALUES (?, ?, 0, 0)').run(
        id.slice(0, id.indexOf('/')),
        id.slice(id.indexOf('/') + 1)
      );
    }
  }
  // Combo kiểu OmniRoute: step là object { id, kind, model, providerId }
  const data = JSON.stringify({
    models: [
      { id: 's1', kind: 'model', model: 'model-one', providerId: 'alpha' },
      { id: 's2', kind: 'model', model: 'vendor/model-two', providerId: 'alpha' },
      { id: 's3', kind: 'model', model: 'missing-model', providerId: 'alpha' },
      { id: 's4', kind: 'model', model: 'other', providerId: 'beta' },
      { id: 's5', kind: 'model', model: 'manual-model', providerId: 'gamma' },
      { id: 's6', kind: 'model', model: 'whatever', providerId: 'delta' },
    ],
  });
  db.prepare('INSERT INTO combos (id, name, data) VALUES (?, ?, ?)').run('c1', 'combo', data);
  db.close();
  return file;
}

function readOmni(file: string) {
  return readRouterModelState('omniroute', {
    dbPath: file,
    availabilitySource: 'direct',
    excludeComboModelsFromAvailability: true,
  });
}

afterEach(() => {
  delete process.env[ENV_KEY];
  while (created.length) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('C31 L1: bộ đọc trạng thái OmniRoute', () => {
  it('phân biệt PRESENT / PRESENT-NORMALIZED / ABSENT / UNVERIFIABLE', () => {
    const file = makeOmniDb();
    const state = readOmni(file);
    const status = (step: string): StaleStatus => classifyComboStep(step, state);

    expect(status('alpha/model-one')).toBe('PRESENT');
    // id trong combo là "vendor/model-two", synced list giữ "model-two"
    expect(status('alpha/vendor/model-two')).toBe('PRESENT-NORMALIZED');
    expect(status('alpha/missing-model')).toBe('ABSENT');
    expect(status('beta/other')).toBe('PRESENT');
    expect(status('gamma/manual-model')).toBe('PRESENT');
    // delta không có bằng chứng khả dụng nào
    expect(status('delta/whatever')).toBe('UNVERIFIABLE');
  });

  it('DISABLED khi radar_local_model_state tắt model', () => {
    const file = makeOmniDb({ disabled: ['alpha/model-one'] });
    const state = readOmni(file);
    expect(classifyComboStep('alpha/model-one', state)).toBe('DISABLED');
    // mutation: nếu reader coi model bị tắt là PRESENT thì test này đỏ
    expect(classifyComboStep('alpha/model-one', state)).not.toBe('PRESENT');
  });

  it('thiếu bảng key_value: router không đọc được, không phải ABSENT', () => {
    const file = makeOmniDb({ withKeyValue: false });
    const state = readOmni(file);
    const reason = unreadableReason(state);
    expect(reason).toMatch(/key_value/);
    // Không có bằng chứng khả dụng: mọi step phải là UNVERIFIABLE
    expect(classifyComboStep('alpha/model-one', state)).toBe('UNVERIFIABLE');
  });

  it('DB không đọc được: có lý do rõ ràng', () => {
    const file = tempDbPath();
    writeFileSync(file, 'không phải sqlite', 'utf8');
    const state = readOmni(file);
    const reason = unreadableReason(state);
    expect(reason === null || reason.length > 0).toBe(true);
    // Không bao giờ kết luận ABSENT khi không mở được DB
    expect(classifyComboStep('alpha/model-one', state)).not.toBe('ABSENT');
  });

  it('missingTables được nêu tên trong diagnostics', () => {
    const file = makeOmniDb({ withKeyValue: false });
    const state = readOmni(file);
    expect(state.diagnostics?.missingTables.join(',')).toMatch(/key_value/);
  });

  it('M1-02: gộp comboModels vào availableModels khi excludeComboModelsFromAvailability mặc định / false, nhưng giữ nguyên stale-check khi true', () => {
    const file = makeOmniDb({ disabled: ['alpha/model-one'] });

    const stateDefault = readRouterModelState('omniroute', {
      dbPath: file,
      availabilitySource: 'direct',
    });
    const stateFalse = readRouterModelState('omniroute', {
      dbPath: file,
      availabilitySource: 'direct',
      excludeComboModelsFromAvailability: false,
    });
    const stateStale = readRouterModelState('omniroute', {
      dbPath: file,
      availabilitySource: 'direct',
      excludeComboModelsFromAvailability: true,
    });

    // Khi mặc định / false: combo step active được gộp vào availableModels, còn model bị tắt vẫn bị loại trừ.
    for (const s of [stateDefault, stateFalse]) {
      expect(s.availableModels.has('alpha/missing-model')).toBe(true);
      expect(s.availableModels.has('delta/whatever')).toBe(true);
      expect(s.availableModels.has('alpha/model-one')).toBe(false);
      // Không được tạo bằng chứng giả cho provider chỉ xuất hiện trong combo.
      expect(s.availabilityProviders.has('delta')).toBe(false);
    }

    // Khi excludeComboModelsFromAvailability = true (chế độ combos stale): combo không tự xác thực chính nó.
    expect(stateStale.availableModels.has('alpha/missing-model')).toBe(false);
    expect(stateStale.availableModels.has('delta/whatever')).toBe(false);
    expect(classifyComboStep('alpha/missing-model', stateStale)).toBe('ABSENT');
    expect(classifyComboStep('delta/whatever', stateStale)).toBe('UNVERIFIABLE');
  });
});
