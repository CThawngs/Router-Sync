/**
 * test/acceptance/at-162-catalog-store.test.ts
 *
 * Acceptance test for AT-162: Model Catalog SQLite Store (Phase 3a / P1-DEBT-03 / SPEC §23.2).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CatalogStore } from '../../packages/sources/src/index.js';

describe('AT-162: Model Catalog SQLite Store', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: CatalogStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-catalog-'));
    dbPath = path.join(tmpDir, 'catalog.sqlite');
    store = new CatalogStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates tables and performs upsert on providers idempotently', () => {
    store.upsertProvider({
      id: 'deepseek',
      name: 'DeepSeek AI',
      kind: 'openai-compatible',
      endpoint: 'https://api.deepseek.com/v1',
      status: 'active',
    });

    const providers = store.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe('deepseek');
    expect(providers[0]?.name).toBe('DeepSeek AI');

    // Idempotent update
    store.upsertProvider({
      id: 'deepseek',
      name: 'DeepSeek Official',
      kind: 'openai-compatible',
      status: 'active',
      lastSyncAt: '2026-10-23T01:00:00Z',
    });

    const updated = store.listProviders();
    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe('DeepSeek Official');
    expect(updated[0]?.lastSyncAt).toBe('2026-10-23T01:00:00Z');
  });

  it('records model batches and tracks grace cycles across syncs', () => {
    store.upsertProvider({
      id: 'deepseek',
      name: 'DeepSeek AI',
      kind: 'openai-compatible',
      status: 'active',
    });

    // Cycle 1: Two models discovered
    const res1 = store.recordModelBatch('deepseek', [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64 },
      { id: 'deepseek-coder', name: 'DeepSeek Coder', contextWindow: 64 },
    ]);
    expect(res1.recorded).toBe(2);
    expect(res1.frozen).toBe(false);

    let models = store.listModels({ providerId: 'deepseek' });
    expect(models).toHaveLength(2);
    expect(models.every((m) => m.status === 'active')).toBe(true);

    // Cycle 2: deepseek-coder is missing -> enters grace_period
    const res2 = store.recordModelBatch('deepseek', [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    ]);
    expect(res2.frozen).toBe(false);

    models = store.listModels({ providerId: 'deepseek' });
    const coderCycle2 = models.find((m) => m.id === 'deepseek-coder');
    expect(coderCycle2?.status).toBe('grace_period');
    expect(coderCycle2?.consecutiveMissing).toBe(1);

    // Cycle 3: deepseek-coder still missing (consecutive = 2 >= graceCycles) -> enters absent
    const res3 = store.recordModelBatch('deepseek', [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    ]);
    expect(res3.frozen).toBe(false);

    models = store.listModels({ providerId: 'deepseek' });
    const coderCycle3 = models.find((m) => m.id === 'deepseek-coder');
    expect(coderCycle3?.status).toBe('absent');
    expect(coderCycle3?.consecutiveMissing).toBe(2);
  });

  it('triggers shrink guard freeze when incoming count drops severely', () => {
    store.upsertProvider({
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      status: 'active',
    });

    // Populate with 10 models
    const batch10 = Array.from({ length: 10 }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`,
    }));
    store.recordModelBatch('openai', batch10);

    const initial = store.listModels({ providerId: 'openai' });
    expect(initial).toHaveLength(10);

    // Incoming drops from 10 to 2 (80% drop > 30% safety cap)
    const resShrink = store.recordModelBatch('openai', [
      { id: 'model-0' },
      { id: 'model-1' },
    ]);

    expect(resShrink.frozen).toBe(true);
    expect(resShrink.recorded).toBe(0);
    expect(resShrink.reason).toContain('exceeding safety cap of 30%');

    // Confirm existing models remain unharmed
    const afterFreeze = store.listModels({ providerId: 'openai' });
    expect(afterFreeze).toHaveLength(10);
    expect(afterFreeze.filter((m) => m.status === 'active')).toHaveLength(10);
  });

  it('persists data across store reopens cleanly', () => {
    store.upsertProvider({
      id: 'ollama',
      name: 'Local Ollama',
      kind: 'ollama',
      status: 'active',
    });
    store.recordModelBatch('ollama', [{ id: 'llama3:latest' }]);
    store.close();

    // Reopen new store instance on same DB file
    const storeReopened = new CatalogStore({ dbPath });
    const providers = storeReopened.listProviders();
    const models = storeReopened.listModels();

    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe('ollama');
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('llama3:latest');

    storeReopened.close();
  });
});
