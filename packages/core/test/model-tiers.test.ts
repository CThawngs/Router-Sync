import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  classifyModelTier,
  buildProviderModelUniverse,
  ProviderModelUniverseSchema,
  TieredModelEntrySchema,
  ModelTierSchema,
  PlanActionTypeSchema,
  readRouterModelState,
  openBetterSqlite3,
  NINE_ROUTER_EXPECTED_APP_VERSION,
} from '../src/index.js';

describe('Model Tier Architecture (3-Tier Universe: R3)', () => {
  it('validates ModelTier and PlanActionType schemas', () => {
    expect(ModelTierSchema.parse('A')).toBe('A');
    expect(ModelTierSchema.parse('B')).toBe('B');
    expect(ModelTierSchema.parse('C')).toBe('C');
    expect(ModelTierSchema.parse('UNKNOWN')).toBe('UNKNOWN');
    expect(() => ModelTierSchema.parse('D')).toThrow();

    expect(PlanActionTypeSchema.parse('REMOVE_MODEL')).toBe('REMOVE_MODEL');
    expect(PlanActionTypeSchema.parse('ENABLE_MODEL')).toBe('ENABLE_MODEL');
    expect(PlanActionTypeSchema.parse('ADD_MODEL')).toBe('ADD_MODEL');
    expect(PlanActionTypeSchema.parse('DISABLE_MODEL')).toBe('DISABLE_MODEL');
    expect(() => PlanActionTypeSchema.parse('UNKNOWN')).toThrow();
  });

  it('classifies models into Tier A, B, and C correctly with decoupled inCombo', () => {
    // 1. Tier A: active in router even when not in combo
    expect(classifyModelTier('gemini-2.5-flash', { isActive: true, inCombo: false })).toBe('A');
    expect(classifyModelTier('gemini-2.5-flash', { isActive: true, inCombo: true })).toBe('A');

    // 2. Tier B: model in disabledModels
    expect(classifyModelTier('gemini-3.7-flash', { isDisabled: true, inCombo: false })).toBe('B');
    expect(classifyModelTier('gemini-3.7-flash', { isDisabled: true, inCombo: true })).toBe('B');

    // 3. Tier B: catalog-only model / known in router but inactive
    expect(classifyModelTier('gemini-catalog', { isKnownInRouter: true, inCombo: false })).toBe('B');
    expect(classifyModelTier('gemini-old', { isDeprecated: true, inCombo: false })).toBe('B');

    // 4. Tier C: unconfigured model discovered in provider registry or web
    expect(classifyModelTier('gemini-4-unreleased', { isDiscovered: true, inCombo: false })).toBe('C');
    expect(classifyModelTier('gemini-unknown', { inCombo: false })).toBe('C');
  });

  it('preserves decoupled inCombo field on TieredModelEntrySchema', () => {
    const entryActiveNoCombo = TieredModelEntrySchema.parse({
      modelId: 'gemini-active-standalone',
      provider: 'gemini',
      tier: 'A',
      inCombo: false,
    });
    expect(entryActiveNoCombo.tier).toBe('A');
    expect(entryActiveNoCombo.inCombo).toBe(false);

    const entryActiveInCombo = TieredModelEntrySchema.parse({
      modelId: 'gemini-active-combo',
      provider: 'gemini',
      tier: 'A',
      inCombo: true,
    });
    expect(entryActiveInCombo.tier).toBe('A');
    expect(entryActiveInCombo.inCombo).toBe(true);

    const entryDisabled = TieredModelEntrySchema.parse({
      modelId: 'gemini-disabled',
      provider: 'gemini',
      tier: 'B',
      inCombo: false,
      reason: 'in disabledModels kv',
    });
    expect(entryDisabled.tier).toBe('B');
    expect(entryDisabled.inCombo).toBe(false);

    const entryTierC = TieredModelEntrySchema.parse({
      modelId: 'gemini-unconfigured-external',
      provider: 'gemini',
      tier: 'C',
      inCombo: false,
      source: 'official_docs',
    });
    expect(entryTierC.tier).toBe('C');
    expect(entryTierC.inCombo).toBe(false);
  });

  it('builds ProviderModelUniverse with consistent counts', () => {
    const universe = buildProviderModelUniverse('test-provider', [
      { modelId: 'm1', provider: 'test-provider', tier: 'A' },
      { modelId: 'm2', provider: 'test-provider', tier: 'B', reason: 'disabled in router' },
      { modelId: 'm3', provider: 'test-provider', tier: 'B', reason: 'deprecated' },
      { modelId: 'm4', provider: 'test-provider', tier: 'C', source: 'public_registry' },
    ]);

    expect(universe.provider).toBe('test-provider');
    expect(universe.counts.A).toBe(1);
    expect(universe.counts.B).toBe(2);
    expect(universe.counts.C).toBe(1);
    expect(universe.counts.total).toBe(4);
    expect(universe.tiers.A).toHaveLength(1);
    expect(universe.tiers.B).toHaveLength(2);
    expect(universe.tiers.C).toHaveLength(1);

    // Schema validation passes
    const validated = ProviderModelUniverseSchema.parse(universe);
    expect(validated.counts.total).toBe(4);
  });

  describe('readRouterModelState', () => {
    it('grounds 9Router model tiers in catalog, disabledModels, customModels, and combos', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-model-state-'));
      const dbPath = path.join(tmpDir, 'data.sqlite');
      const catPath = path.join(tmpDir, 'model-catalog.json');

      fs.writeFileSync(
        catPath,
        JSON.stringify({
          models: {
            'gemini:gemini-catalog-enabled': {},
            'google:gemini-catalog-enabled': {},
            'gemini:gemini-catalog-disabled': {},
          },
        })
      );

      const db = openBetterSqlite3(dbPath);
      db.exec(`
        CREATE TABLE _meta (key TEXT, value TEXT);
        INSERT INTO _meta VALUES ('appVersion', '0.5.119');
        CREATE TABLE kv (scope TEXT, key TEXT, value TEXT);
        CREATE TABLE combos (id TEXT, name TEXT, models TEXT);
        INSERT INTO kv VALUES ('disabledModels', 'gemini', '["gemini-catalog-disabled", "gemini-custom-disabled"]');
        INSERT INTO kv VALUES ('customModels', 'gemini|gemini-custom-active|llm', '{"id":"gemini-custom-active"}');
        INSERT INTO kv VALUES ('customModels', 'gemini|gemini-custom-disabled|llm', '{"id":"gemini-custom-disabled"}');
        INSERT INTO combos VALUES ('c1', 'agent-combo', '["gemini/gemini-catalog-disabled", "gemini/gemini-in-combo-only"]');
      `);
      db.close();

      // 1. By default (catalogImpliesEnabled=false), catalog model not in combo/custom is Tier B (suggested)
      const state = readRouterModelState('9router', { dbPath, catalogPath: catPath });
      const c1Default = state.classify('gemini', 'gemini-catalog-enabled');
      expect(c1Default.tier).toBe('B');
      expect(c1Default.inCombo).toBe(false);
      expect(c1Default.reason).toBe('Suggested in router catalog');

      // 1b. With catalogImpliesEnabled=true, catalog model becomes Tier A (active/enabled)
      const stateImplies = readRouterModelState('9router', { dbPath, catalogPath: catPath, catalogImpliesEnabled: true });
      const c1Implies = stateImplies.classify('gemini', 'gemini-catalog-enabled');
      expect(c1Implies.tier).toBe('A');
      expect(c1Implies.inCombo).toBe(false);
      expect(c1Implies.reason).toBe('Active/enabled in router');

      // Also alias normalization: 'google' should resolve 'gemini' catalog entries and vice versa
      const c1Alias = stateImplies.classify('google', 'gemini-catalog-enabled');
      expect(c1Alias.tier).toBe('A');
      const c1WithPrefix = stateImplies.classify('google', 'models/gemini-catalog-enabled');
      expect(c1WithPrefix.tier).toBe('A');

      // 2. Custom active model -> Tier A
      const c2 = state.classify('gemini', 'gemini-custom-active');
      expect(c2.tier).toBe('A');
      expect(c2.inCombo).toBe(false);

      // 3. Disabled model NOT in combo -> Tier B, inconsistent=false
      const c3 = state.classify('gemini', 'gemini-custom-disabled');
      expect(c3.tier).toBe('B');
      expect(c3.inCombo).toBe(false);
      expect(c3.inconsistent).toBe(false);

      // 4. Disabled model IN combo -> Tier B, inconsistent=true
      const c4 = state.classify('gemini', 'gemini-catalog-disabled');
      expect(c4.tier).toBe('B');
      expect(c4.inCombo).toBe(true);
      expect(c4.inconsistent).toBe(true);

      // 5. In combo only, but NOT in the router's available list -> Tier UNKNOWN
      // with inconsistent=true (C4y). The 9Router provider page lists only
      // the provider registry + custom models + aliases, minus disabled, so a
      // combo reference to anything else is a stale reference.
      const c5 = state.classify('gemini', 'gemini-in-combo-only');
      expect(c5.tier).toBe('UNKNOWN');
      expect(c5.inCombo).toBe(true);
      expect(c5.inconsistent).toBe(true);

      // 6. Model not configured in router -> Tier C
      const c6 = state.classify('gemini', 'unconfigured-model');
      expect(c6.tier).toBe('C');
      expect(c6.inCombo).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('isolates provider collisions with scoped keys (U2)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-prov-collision-'));
      const dbPath = path.join(tmpDir, 'router.sqlite');

      const db = openBetterSqlite3(dbPath);
      db.exec(`
        CREATE TABLE _meta (key TEXT, value TEXT);
        INSERT INTO _meta VALUES ('appVersion', '0.5.119');
        CREATE TABLE kv (scope TEXT, key TEXT, value TEXT);
        CREATE TABLE combos (id TEXT, name TEXT, models TEXT);
        INSERT INTO kv VALUES ('disabledModels', 'openai', '["shared-model-name"]');
        INSERT INTO combos VALUES ('c1', 'agent-combo', '["deepseek/shared-model-name"]');
      `);
      db.close();

      const state = readRouterModelState('9router', { dbPath });

      // deepseek/shared-model-name is in combo but is not in deepseek's
      // available list -> Tier UNKNOWN with inconsistent=true (C4y)
      const deepseekClass = state.classify('deepseek', 'shared-model-name');
      expect(deepseekClass.tier).toBe('UNKNOWN');
      expect(deepseekClass.inCombo).toBe(true);
      expect(deepseekClass.inconsistent).toBe(true);

      // openai/shared-model-name is disabled in kv -> Tier B (not influenced by deepseek combo)
      const openaiClass = state.classify('openai', 'shared-model-name');
      expect(openaiClass.tier).toBe('B');
      expect(openaiClass.inCombo).toBe(false);

      // anthropic/shared-model-name is unconfigured -> Tier C (neither disabled nor in combo)
      const anthropicClass = state.classify('anthropic', 'shared-model-name');
      expect(anthropicClass.tier).toBe('C');
      expect(anthropicClass.inCombo).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('classifies OmniRoute models as Tier A if in combo, otherwise UNKNOWN', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-omni-state-'));
      const dbPath = path.join(tmpDir, 'storage.sqlite');

      const db = openBetterSqlite3(dbPath);
      db.exec(`
        CREATE TABLE combos (id TEXT, name TEXT, models TEXT);
        INSERT INTO combos VALUES ('c1', 'omni-combo', '["openrouter/openai/gpt-4o"]');
      `);
      db.close();

      const state = readRouterModelState('omniroute', { dbPath });

      // In combo -> Tier A
      const c1 = state.classify('openrouter', 'openai/gpt-4o');
      expect(c1.tier).toBe('A');
      expect(c1.inCombo).toBe(true);

      // Outside combo -> UNKNOWN
      const c2 = state.classify('openrouter', 'anthropic/claude-3-5-sonnet');
      expect(c2.tier).toBe('UNKNOWN');
      expect(c2.inCombo).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('M1-03: populates comboNames for 9Router from combos table, parsed JSON name, fallback id, and options without mutating DB sha256', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-m103-9r-'));
      try {
        const dbPath = path.join(tmpDir, 'router.sqlite');
        const db = openBetterSqlite3(dbPath);
        db.exec(`
          CREATE TABLE _meta (key TEXT, value TEXT);
          CREATE TABLE kv (scope TEXT, key TEXT, value TEXT);
          CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, models TEXT);
        `);
        db.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)').run(
          'appVersion',
          NINE_ROUTER_EXPECTED_APP_VERSION
        );
        const insertCombo = db.prepare('INSERT INTO combos (id, name, models) VALUES (?, ?, ?)');
        insertCombo.run('combo-uuid-1', ' 9Router-Coder-1 ', JSON.stringify(['gemini/gemini-2.5-pro']));
        insertCombo.run(
          'combo-obj-id',
          '   ',
          JSON.stringify({ name: ' 9Router-Json-Name ', models: ['gemini/gemini-2.5-flash'] })
        );
        insertCombo.run('combo-fallback-id', '', JSON.stringify(['gemini/gemini-2.5-flash']));
        db.close();

        const beforeSha = createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
        const state = readRouterModelState('9router', {
          dbPath,
          comboNames: [' Seeded-9Router-Combo ', '   '],
        });
        const afterSha = createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');

        expect(afterSha).toBe(beforeSha);
        expect(state.versionMismatch).toBe(false);
        expect(state.comboNames).toBeInstanceOf(Set);
        expect(state.comboNames.has('9Router-Coder-1')).toBe(true);
        expect(state.comboNames.has('9Router-Json-Name')).toBe(true);
        expect(state.comboNames.has('combo-obj-id')).toBe(true);
        expect(state.comboNames.has('combo-fallback-id')).toBe(true);
        expect(state.comboNames.has('Seeded-9Router-Combo')).toBe(true);
        // When row.name is present, row.id is not used as a fallback combo name
        expect(state.comboNames.has('combo-uuid-1')).toBe(false);
        expect(state.comboNames.has('')).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });
  });
});
