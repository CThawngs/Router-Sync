/**
 * packages/core/test/model-tiers-ui-parity.test.ts
 *
 * C4x: 9Router model tiers must match what the 9Router provider page
 * actually shows.
 *
 * The 9Router provider detail page renders "Available Models" from the
 * provider's built-in model list plus the router's custom models and model
 * aliases, minus the models the operator disabled. The real UI screenshot
 * (2026-11-16) showed exactly 4 available models for Gemini and 9 disabled
 * ones; a provider-model registry snapshot reproduces that count.
 *
 * This test builds its own router database in a temp directory with neutral
 * model names, so it never touches a real router and never depends on the
 * shipped registry snapshot.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRouterModelState, openBetterSqlite3 } from '../src/index.js';

/**
 * Neutral fixture. The provider alias is "provx" and the model names are
 * deliberately meaningless, so a failure points at the logic, not at data.
 */
const FIXTURE_REGISTRY: Record<string, readonly string[]> = {
  provx: [
    'alpha-one',
    'beta-two',
    'gamma-three',
    'delta-four',
    'epsilon-five',
    'zeta-six',
  ],
};

const FIXTURE_ALIASES: Record<string, string> = { provx: 'provx' };

const ALIASED_FIXTURE_REGISTRY: Record<string, readonly string[]> = {
  px: ['alpha-one'],
};

const ALIASED_FIXTURE_ALIASES: Record<string, string> = { provx: 'px' };

/** Build a 9Router-shaped database in a temp dir. */
function makeFixtureDb(dir: string): string {
  const dbPath = path.join(dir, 'router.sqlite');
  const db = openBetterSqlite3(dbPath);
  db.exec(`
    CREATE TABLE _meta (key TEXT, value TEXT);
    INSERT INTO _meta VALUES ('appVersion', '0.5.119');
    CREATE TABLE kv (scope TEXT, key TEXT, value TEXT);
    CREATE TABLE combos (id TEXT, name TEXT, models TEXT);
    CREATE TABLE providerConnections (provider TEXT, name TEXT, data TEXT);

    -- disabled: one built-in model and one custom model
    INSERT INTO kv VALUES ('disabledModels', 'provx', '["epsilon-five", "eta-seven"]');

    -- custom models added by the operator
    INSERT INTO kv VALUES ('customModels', 'provx|eta-seven|llm', '{"providerAlias":"provx","id":"eta-seven","type":"llm","name":"Eta Seven"}');
    INSERT INTO kv VALUES ('customModels', 'provx|theta-eight|llm', '{"providerAlias":"provx","id":"theta-eight","type":"llm","name":"Theta Eight"}');

    -- model alias: the aliased model is shown by the provider page
    INSERT INTO kv VALUES ('modelAliases', 'my-iota-alias', '"provx/iota-nine"');

    -- provider connection evidence read directly from the router database
    INSERT INTO providerConnections VALUES ('provx', 'Prov X', '{"enabledModels":["direct-model"]}');

    -- combos: one available model, one stale reference, and (in a second
    -- combo) one model the operator disabled.
    INSERT INTO combos VALUES ('c1', 'combo-one', '["provx/alpha-one", "provx/kappa-ten"]');
    INSERT INTO combos VALUES ('c2', 'combo-two', '["provx/epsilon-five"]');
  `);
  db.close();
  return dbPath;
}

describe('9Router tier parity with the provider page (C4x)', () => {
  it('marks exactly the models the 9Router UI lists as available as Tier A', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ui-parity-'));
    try {
      const dbPath = makeFixtureDb(tmpDir);
      const state = readRouterModelState('9router', {
        dbPath,
        providerModels: FIXTURE_REGISTRY,
        providerAliases: FIXTURE_ALIASES,
      });

      // The 9Router provider page shows, for this provider:
      //   built-in models (6) + custom models (2) + aliased models (1) - disabled (2)
      // = 7 available models.
      const expectedAvailable = [
        'alpha-one',
        'beta-two',
        'gamma-three',
        'delta-four',
        'zeta-six',
        'theta-eight',
        'iota-nine',
      ].sort();

      const actualAvailable: string[] = [];
      for (const id of [
        'alpha-one',
        'beta-two',
        'gamma-three',
        'delta-four',
        'epsilon-five',
        'zeta-six',
        'eta-seven',
        'theta-eight',
        'iota-nine',
        'kappa-ten',
      ]) {
        const c = state.classify('provx', id);
        if (c.tier === 'A') actualAvailable.push(id);
      }
      expect(actualAvailable.sort()).toEqual(expectedAvailable);

      // The exact set, as an explicit equality check on the router's own list.
      expect([...state.availableModels].sort()).toEqual(
        expectedAvailable.map((id) => `provx/${id}`).sort()
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps direct router evidence separate from the shipped provider snapshot', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-availability-source-'));
    try {
      const dbPath = makeFixtureDb(tmpDir);
      const direct = readRouterModelState('9router', {
        dbPath,
        providerModels: FIXTURE_REGISTRY,
        providerAliases: FIXTURE_ALIASES,
        availabilitySource: 'direct',
      });
      const snapshot = readRouterModelState('9router', {
        dbPath,
        providerModels: FIXTURE_REGISTRY,
        providerAliases: FIXTURE_ALIASES,
        availabilitySource: 'snapshot',
      });

      expect([...direct.availableModels].sort()).toEqual([
        'provx/direct-model',
        'provx/iota-nine',
        'provx/theta-eight',
      ]);
      expect(direct.availableModels.has('provx/alpha-one')).toBe(false);

      expect(snapshot.availableModels.has('provx/alpha-one')).toBe(true);
      expect(snapshot.availableModels.has('provx/direct-model')).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('maps direct connection aliases to every equivalent provider prefix', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-availability-alias-'));
    try {
      const dbPath = makeFixtureDb(tmpDir);
      const db = openBetterSqlite3(dbPath);
      db.exec(`
        INSERT INTO providerConnections VALUES ('px', 'Provider X', '{"enabledModels":["reverse-model","disabled-reverse"]}');
        INSERT INTO kv VALUES ('disabledModels', 'provx', '["disabled-reverse"]');
        INSERT INTO combos VALUES ('c1', 'aliased-disabled', '["px/disabled-reverse"]');
      `);
      db.close();

      const state = readRouterModelState('9router', {
        dbPath,
        providerModels: ALIASED_FIXTURE_REGISTRY,
        providerAliases: ALIASED_FIXTURE_ALIASES,
        availabilitySource: 'direct',
      });

      expect(state.availableModels.has('px/direct-model')).toBe(true);
      expect(state.availableModels.has('provx/direct-model')).toBe(true);
      expect(state.availableModels.has('px/reverse-model')).toBe(true);
      expect(state.availableModels.has('provx/reverse-model')).toBe(true);
      expect(state.availableModels.has('px/disabled-reverse')).toBe(false);
      expect(state.availableModels.has('provx/disabled-reverse')).toBe(false);
      expect(state.disabledModels.has('px/disabled-reverse')).toBe(true);
      expect(state.disabledModels.has('provx/disabled-reverse')).toBe(true);

      const disabledByAlias = state.classify('px', 'disabled-reverse');
      expect(disabledByAlias.tier).toBe('B');
      expect(disabledByAlias.inCombo).toBe(true);
      expect(disabledByAlias.inconsistent).toBe(true);

      const disabledByProviderId = state.classify('provx', 'disabled-reverse');
      expect(disabledByProviderId.tier).toBe('B');
      expect(disabledByProviderId.inCombo).toBe(true);
      expect(disabledByProviderId.inconsistent).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('can exclude a custom-provider combo reference from stale diagnostics', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-custom-combo-source-'));
    try {
      const dbPath = makeFixtureDb(tmpDir);
      const db = openBetterSqlite3(dbPath);
      db.exec(`
        INSERT INTO combos VALUES ('c3', 'custom-combo', '["customx/combo-only"]');
        INSERT INTO providerConnections VALUES ('customx', 'Custom X', '{"enabledModels":["live-model"]}');
      `);
      db.close();

      const direct = readRouterModelState('9router', {
        dbPath,
        providerModels: FIXTURE_REGISTRY,
        providerAliases: FIXTURE_ALIASES,
        availabilitySource: 'direct',
      });
      const snapshot = readRouterModelState('9router', {
        dbPath,
        providerModels: FIXTURE_REGISTRY,
        providerAliases: FIXTURE_ALIASES,
        availabilitySource: 'snapshot',
        excludeComboModelsFromAvailability: true,
      });
      const legacySnapshot = readRouterModelState('9router', {
        dbPath,
        providerModels: FIXTURE_REGISTRY,
        providerAliases: FIXTURE_ALIASES,
        availabilitySource: 'snapshot',
      });

      expect(direct.comboModels.has('customx/combo-only')).toBe(true);
      expect(direct.availableModels.has('customx/combo-only')).toBe(false);
      expect(snapshot.availableModels.has('customx/live-model')).toBe(true);
      expect(snapshot.availableModels.has('customx/combo-only')).toBe(false);
      expect(legacySnapshot.availableModels.has('customx/combo-only')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('marks disabled models as Tier B and disabled-and-combo models as inconsistent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ui-parity-'));
    try {
      const dbPath = makeFixtureDb(tmpDir);
      const state = readRouterModelState('9router', {
        dbPath,
        providerModels: FIXTURE_REGISTRY,
        providerAliases: FIXTURE_ALIASES,
      });

      // Disabled and in a combo: Tier B with inconsistent=true.
      const disabledInCombo = state.classify('provx', 'epsilon-five');
      expect(disabledInCombo.tier).toBe('B');
      expect(disabledInCombo.inCombo).toBe(true);
      expect(disabledInCombo.inconsistent).toBe(true);
      expect(disabledInCombo.reason).toMatch(/disabled in router kv/);

      // A custom model that the operator disabled is Tier B, not Tier A.
      const disabledCustom = state.classify('provx', 'eta-seven');
      expect(disabledCustom.tier).toBe('B');
      expect(disabledCustom.inCombo).toBe(false);
      expect(disabledCustom.inconsistent).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('flags a combo reference to a model the router does not offer as inconsistent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ui-parity-'));
    try {
      const dbPath = makeFixtureDb(tmpDir);
      const state = readRouterModelState('9router', {
        dbPath,
        providerModels: FIXTURE_REGISTRY,
        providerAliases: FIXTURE_ALIASES,
      });

      // "kappa-ten" is only referenced by a combo; the router does not list
      // it as available for that provider.
      const stale = state.classify('provx', 'kappa-ten');
      expect(stale.tier).toBe('UNKNOWN');
      expect(stale.inCombo).toBe(true);
      expect(stale.inconsistent).toBe(true);
      expect(stale.reason).toMatch(/not in the router available model list/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports inCombo on a model the provider page lists as available', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ui-parity-'));
    try {
      const dbPath = makeFixtureDb(tmpDir);
      const state = readRouterModelState('9router', {
        dbPath,
        providerModels: FIXTURE_REGISTRY,
        providerAliases: FIXTURE_ALIASES,
      });

      const inComboAvailable = state.classify('provx', 'alpha-one');
      expect(inComboAvailable.tier).toBe('A');
      expect(inComboAvailable.inCombo).toBe(true);
      expect(inComboAvailable.inconsistent).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps the alias direction provider-scoped', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ui-parity-'));
    try {
      const dbPath = makeFixtureDb(tmpDir);
      const state = readRouterModelState('9router', {
        dbPath,
        providerModels: FIXTURE_REGISTRY,
        providerAliases: FIXTURE_ALIASES,
      });

      // The aliased model belongs to provx only.
      const aliased = state.classify('provx', 'iota-nine');
      expect(aliased.tier).toBe('A');

      const otherProvider = state.classify('otherprov', 'iota-nine');
      expect(otherProvider.tier).not.toBe('A');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces 9Router appVersion check against 0.5.119 and classifies non-kv models as UNKNOWN on mismatch (Z2)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-version-check-'));
    try {
      const dbPath = path.join(tmpDir, 'router.sqlite');
      const db = openBetterSqlite3(dbPath);
      db.exec(`
        CREATE TABLE _meta (key TEXT, value TEXT);
        CREATE TABLE kv (scope TEXT, key TEXT, value TEXT);
        CREATE TABLE combos (id TEXT, name TEXT, models TEXT);
        CREATE TABLE providerConnections (provider TEXT, name TEXT, data TEXT);

        INSERT INTO _meta VALUES ('appVersion', '0.6.0');
        INSERT INTO kv VALUES ('disabledModels', 'provx', '["disabled-model-1"]');
        INSERT INTO kv VALUES ('customModels', 'provx|custom-model-1|llm', '{"providerAlias":"provx","id":"custom-model-1","type":"llm"}');
        INSERT INTO kv VALUES ('modelAliases', 'my-alias', '"provx/aliased-model-1"');
        INSERT INTO providerConnections VALUES ('provx', 'Prov X', '{"enabledModels":["fallback-model-1"]}');
        INSERT INTO combos VALUES ('c1', 'combo-one', '["provx/combo-model-1"]');
      `);
      db.close();

      // Without explicit providerModels override, versionMismatch triggers UNKNOWN for non-kv models
      const stateMismatched = readRouterModelState('9router', { dbPath });
      expect(stateMismatched.appVersion).toBe('0.6.0');
      expect(stateMismatched.versionMismatch).toBe(true);

      // kv disabled models stay Tier B
      const disabledClass = stateMismatched.classify('provx', 'disabled-model-1');
      expect(disabledClass.tier).toBe('B');
      expect(disabledClass.reason).toBe('Disabled in router kv');

      // kv custom models stay Tier A
      const customClass = stateMismatched.classify('provx', 'custom-model-1');
      expect(customClass.tier).toBe('A');

      // kv alias models stay Tier A
      const aliasClass = stateMismatched.classify('provx', 'aliased-model-1');
      expect(aliasClass.tier).toBe('A');

      // Models NOT in kv (connection enabled, combo only, unconfigured) become UNKNOWN with snapshot-version-mismatch
      const fallbackClass = stateMismatched.classify('provx', 'fallback-model-1');
      expect(fallbackClass.tier).toBe('UNKNOWN');
      expect(fallbackClass.reason).toBe('snapshot-version-mismatch');

      const comboOnlyClass = stateMismatched.classify('provx', 'combo-model-1');
      expect(comboOnlyClass.tier).toBe('UNKNOWN');
      expect(comboOnlyClass.inCombo).toBe(true);
      expect(comboOnlyClass.reason).toBe('snapshot-version-mismatch');

      const unconfClass = stateMismatched.classify('provx', 'unconfigured-model');
      expect(unconfClass.tier).toBe('UNKNOWN');
      expect(unconfClass.reason).toBe('snapshot-version-mismatch');

      // Missing _meta table or missing appVersion key must also be treated as versionMismatch = true
      const dbNoMetaPath = path.join(tmpDir, 'router-nometa.sqlite');
      const dbNoMeta = openBetterSqlite3(dbNoMetaPath);
      dbNoMeta.exec(`
        CREATE TABLE kv (scope TEXT, key TEXT, value TEXT);
      `);
      dbNoMeta.close();

      const stateNoMeta = readRouterModelState('9router', { dbPath: dbNoMetaPath });
      expect(stateNoMeta.appVersion).toBeUndefined();
      expect(stateNoMeta.versionMismatch).toBe(true);
      const noMetaClass = stateNoMeta.classify('provx', 'any-model');
      expect(noMetaClass.tier).toBe('UNKNOWN');
      expect(noMetaClass.reason).toBe('snapshot-version-mismatch');

      // When appVersion matches 0.5.119
      const db2Path = path.join(tmpDir, 'router2.sqlite');
      const db2 = openBetterSqlite3(db2Path);
      db2.exec(`
        CREATE TABLE _meta (key TEXT, value TEXT);
        INSERT INTO _meta VALUES ('appVersion', '0.5.119');
      `);
      db2.close();

      const stateMatched = readRouterModelState('9router', { dbPath: db2Path });
      expect(stateMatched.appVersion).toBe('0.5.119');
      expect(stateMatched.versionMismatch).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
