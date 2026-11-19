/**
 * packages/core/src/domain/model-state.ts
 *
 * Centralized reader for Router Model State across 9Router and OmniRoute.
 * Classifies models into Tier A, B, C, or UNKNOWN based on database and catalog grounding.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type SqliteDriver } from '../sqlite/driver.js';
import { openBetterSqlite3, locateRouterDb } from '../sqlite/better-sqlite3.js';
import { type ModelTier } from './schema.js';
import {
  NINE_ROUTER_PROVIDER_ALIASES,
  NINE_ROUTER_PROVIDER_MODELS,
  NINE_ROUTER_EXPECTED_APP_VERSION,
} from './9router-provider-models.js';

export { NINE_ROUTER_EXPECTED_APP_VERSION };

export interface ModelTierClassification {
  tier: ModelTier;
  inCombo: boolean;
  inconsistent?: boolean;
  reason?: string;
}

export const PROVIDER_ALIASES: Record<string, string[]> = {
  google: ['gemini'],
  gemini: ['google'],
};

export function getProviderAliases(provider: string): string[] {
  const norm = provider.trim().toLowerCase();
  const aliases = PROVIDER_ALIASES[norm];
  if (!aliases) return [norm];
  return [norm, ...aliases];
}

function getEquivalentProviderPrefixes(
  provider: string,
  registryAliases: Readonly<Record<string, string>>,
): string[] {
  const prefixes = new Set(getProviderAliases(provider));

  const mappedAlias = registryAliases[provider.trim().toLowerCase()];
  if (mappedAlias) {
    for (const alias of getProviderAliases(mappedAlias)) prefixes.add(alias);
  }

  for (const [providerId, alias] of Object.entries(registryAliases)) {
    if (alias.trim().toLowerCase() !== provider.trim().toLowerCase()) continue;
    for (const candidate of getProviderAliases(providerId)) prefixes.add(candidate);
  }

  return [...prefixes];
}

export interface RouterModelStateOptions {
  dbPath?: string | undefined;
  catalogPath?: string | undefined;
  db?: SqliteDriver | undefined;
  comboModels?: string[] | Set<string> | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  catalogImpliesEnabled?: boolean | undefined;
  appVersion?: string | undefined;
  /**
   * Override for the 9Router built-in provider model registry.
   * Defaults to the registry shipped with this package
   * (domain/9router-provider-models.ts). Tests pass a neutral fixture here.
   */
  providerModels?: Record<string, readonly string[]> | undefined;
  /**
   * Override for the 9Router provider id -> alias map.
   * Defaults to the map shipped with this package.
   */
  providerAliases?: Record<string, string> | undefined;
  /**
   * Evidence source used to build the 9Router available-model list.
   * `direct` uses only evidence read from the router database. `snapshot`
   * also uses the provider registry shipped with this package.
   */
  availabilitySource?: 'direct' | 'snapshot' | undefined;
  /**
   * Exclude combo references from snapshot availability evidence. This is used
   * by stale-reference diagnostics so the record under test cannot validate
   * itself. Other callers keep the existing tier-classification behavior.
   */
  excludeComboModelsFromAvailability?: boolean | undefined;
}

export interface RouterModelState {
  router: string;
  appVersion?: string | undefined;
  versionMismatch?: boolean | undefined;
  enabledModels: Set<string>;
  disabledModels: Set<string>;
  comboModels: Set<string>;
  customModels: Set<string>;
  catalogModels: Set<string>;
  /**
   * Models the router's own UI lists as available for a provider
   * (9Router built-in registry + router custom models + aliases, minus disabled).
   */
  availableModels: Set<string>;
  /**
   * Models that only appear in a provider connection's
   * `providerSpecificData.enabledModels` list. The 9Router provider page does
   * not use that list for its "Available Models" view, so these are reported
   * as Tier B with a matching reason.
   */
  connectionEnabledModels: Set<string>;
  classify(provider: string, modelId: string): ModelTierClassification;
}

/**
 * Reads the actual state of a router (catalog, disabled models, custom models, and combos)
 * to provide authoritative tier classification for models.
 */
export function readRouterModelState(
  router: string,
  options: RouterModelStateOptions = {}
): RouterModelState {
  const normRouter = router.toLowerCase();
  const enabledModels = new Set<string>();
  const disabledModels = new Set<string>();
  const comboModels = new Set<string>();
  const customModels = new Set<string>();
  const catalogModels = new Set<string>();
  const availableModels = new Set<string>();
  const aliasModels = new Set<string>();
  const connectionEnabledModels = new Set<string>();

  // Seed comboModels if explicitly provided in options
  if (options.comboModels) {
    for (const m of options.comboModels) {
      if (typeof m === 'string' && m.trim().length > 0) {
        if (m.includes('/')) {
          const slashIdx = m.indexOf('/');
          const prov = m.slice(0, slashIdx);
          const mId = m.slice(slashIdx + 1);
          const normId = mId.startsWith('models/') ? mId.slice('models/'.length) : mId;
          for (const alias of getProviderAliases(prov)) {
            comboModels.add(`${alias}/${mId}`);
            comboModels.add(`${alias}/${normId}`);
          }
        } else {
          comboModels.add(m);
        }
      }
    }
  }

  const is9Router = normRouter === '9router';
  const isOmniRoute = normRouter === 'omniroute';

  // Opt-in: treat a model that only appears in the router catalog as active.
  // Default is false, so a catalog-only model stays Tier B (suggested).
  const catalogImpliesEnabled = Boolean(options.catalogImpliesEnabled);
  const availabilitySource = options.availabilitySource ?? 'snapshot';
  const registryAliases = options.providerAliases ?? NINE_ROUTER_PROVIDER_ALIASES;

  let appVersion = options.appVersion;
  let versionMismatch = false;

  let db: SqliteDriver | undefined = options.db;
  let shouldCloseDb = false;
  let resolvedDbPath = options.dbPath;

  try {
    if (!db) {
      if (!resolvedDbPath && (is9Router || isOmniRoute)) {
        try {
          resolvedDbPath = locateRouterDb(is9Router ? '9router' : 'omniroute', options.env, options.platform);
        } catch {
          // ignore locate failure
        }
      }
      if (resolvedDbPath && fs.existsSync(resolvedDbPath)) {
        try {
          db = openBetterSqlite3(resolvedDbPath, { readOnly: true });
          shouldCloseDb = true;
        } catch {
          db = undefined;
        }
      }
    }

    if (is9Router) {
      if (db) {
        try {
          const metaCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_meta'").get();
          if (metaCheck) {
            const row = db.prepare("SELECT value FROM _meta WHERE key = 'appVersion'").get() as { value?: string } | undefined;
            if (row && typeof row.value === 'string' && row.value.trim().length > 0) {
              appVersion = row.value.trim();
            }
          }
        } catch {
          // ignore _meta query error
        }
        if (!appVersion || appVersion !== NINE_ROUTER_EXPECTED_APP_VERSION) {
          versionMismatch = true;
        }
      } else if (appVersion && appVersion !== NINE_ROUTER_EXPECTED_APP_VERSION) {
        versionMismatch = true;
      }
    }

    // 1. Read Combos (common across routers)
    if (db) {
      try {
        const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combos'").get();
        if (tableCheck) {
          const rows = db.prepare('SELECT * FROM combos').all() as Array<Record<string, unknown>>;
          for (const row of rows) {
            const rawModels = (row['models'] ?? row['data']) as string | undefined;
            if (rawModels && typeof rawModels === 'string') {
              try {
                const parsed = JSON.parse(rawModels);
                const list = Array.isArray(parsed)
                  ? parsed
                  : Array.isArray((parsed as Record<string, unknown>)?.models)
                  ? (parsed as Record<string, unknown>).models
                  : [];
                if (Array.isArray(list)) {
                  for (const m of list) {
                    if (typeof m === 'string' && m.trim().length > 0) {
                      if (m.includes('/')) {
                        const slashIdx = m.indexOf('/');
                        const prov = m.slice(0, slashIdx);
                        const mId = m.slice(slashIdx + 1);
                        const normId = mId.startsWith('models/') ? mId.slice('models/'.length) : mId;
                        for (const alias of getProviderAliases(prov)) {
                          comboModels.add(`${alias}/${mId}`);
                          comboModels.add(`${alias}/${normId}`);
                        }
                      } else {
                        comboModels.add(m);
                      }
                    }
                  }
                }
              } catch {
                // ignore parse failure
              }
            }
          }
        }
      } catch {
        // ignore combo read error
      }
    }

    // 2. Specific logic for 9Router
    if (is9Router) {
      // 2a. Catalog lookup
      let catPath = options.catalogPath;
      if (!catPath && resolvedDbPath) {
        const candidate = path.resolve(path.dirname(resolvedDbPath), '..', 'model-catalog.json');
        if (fs.existsSync(candidate)) {
          catPath = candidate;
        }
      }
      if (!catPath) {
        const appData = options.env?.['APPDATA'] ?? process.env['APPDATA'];
        if (appData) {
          const candidate = path.join(appData, '9router', 'model-catalog.json');
          if (fs.existsSync(candidate)) catPath = candidate;
        } else {
          const home = options.env?.['HOME'] ?? process.env['HOME'];
          if (home) {
            const candidate = path.join(home, '.9router', 'model-catalog.json');
            if (fs.existsSync(candidate)) catPath = candidate;
          }
        }
      }

      if (catPath && fs.existsSync(catPath)) {
        try {
          const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
          if (cat && typeof cat === 'object' && cat.models && typeof cat.models === 'object') {
            for (const key of Object.keys(cat.models)) {
              let prov = '';
              let mId = '';
              const colonIdx = key.indexOf(':');
              if (colonIdx > 0) {
                prov = key.slice(0, colonIdx);
                mId = key.slice(colonIdx + 1);
              } else if (key.includes('/')) {
                const slashIdx = key.indexOf('/');
                prov = key.slice(0, slashIdx);
                mId = key.slice(slashIdx + 1);
              }
              if (prov && mId) {
                const normId = mId.startsWith('models/') ? mId.slice('models/'.length) : mId;
                for (const alias of getProviderAliases(prov)) {
                  catalogModels.add(`${alias}/${mId}`);
                  catalogModels.add(`${alias}/${normId}`);
                }
              }
            }
          }
        } catch {
          // ignore catalog parse failure
        }
      }

      if (db) {
        // 2b. Disabled models from kv table
        try {
          const kvCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").get();
          if (kvCheck) {
            const disRows = db.prepare("SELECT key, value FROM kv WHERE scope = 'disabledModels'").all() as Array<{ key: string; value: string }>;
            for (const r of disRows) {
              try {
                const arr = JSON.parse(r.value);
                if (Array.isArray(arr)) {
                  for (const m of arr) {
                    if (typeof m === 'string') {
                      const normId = m.startsWith('models/') ? m.slice('models/'.length) : m;
                      for (const alias of getEquivalentProviderPrefixes(r.key, registryAliases)) {
                        disabledModels.add(`${alias}/${m}`);
                        disabledModels.add(`${alias}/${normId}`);
                      }
                    }
                  }
                }
              } catch {}
            }

            // 2c. Custom models from kv table
            const customRows = db.prepare("SELECT key, value FROM kv WHERE scope = 'customModels'").all() as Array<{ key: string; value: string }>;
            for (const r of customRows) {
              if (r.key.includes('|')) {
                const parts = r.key.split('|');
                const prov = parts[0] ?? '';
                const mId = parts[1] ?? '';
                if (prov && mId) {
                  const normId = mId.startsWith('models/') ? mId.slice('models/'.length) : mId;
                  for (const alias of getProviderAliases(prov)) {
                    customModels.add(`${alias}/${mId}`);
                    customModels.add(`${alias}/${normId}`);
                  }
                }
              }
            }

            // 2c-bis. Model aliases from kv table.
            // The 9Router UI lists an aliased model under its provider page
            // ("Available Models"), so an alias entry makes the aliased model
            // available for that provider.
            const aliasRows = db.prepare("SELECT key, value FROM kv WHERE scope = 'modelAliases'").all() as Array<{ key: string; value: string }>;
            for (const r of aliasRows) {
              let target: string | undefined;
              try {
                const parsed: unknown = JSON.parse(r.value);
                if (typeof parsed === 'string') target = parsed;
              } catch {
                // value may be stored unquoted
                target = r.value;
              }
              if (!target || !target.includes('/')) continue;
              const slashIdx = target.indexOf('/');
              const prov = target.slice(0, slashIdx);
              const mId = target.slice(slashIdx + 1);
              if (!prov || !mId) continue;
              const normId = mId.startsWith('models/') ? mId.slice('models/'.length) : mId;
              for (const alias of getProviderAliases(prov)) {
                aliasModels.add(`${alias}/${mId}`);
                aliasModels.add(`${alias}/${normId}`);
              }
            }
          }
        } catch {
          // ignore kv table query error
        }

        // 2d. Provider connections (e.g. custom openai-compatible nodes or enabledModels)
        //
        // NOTE (C4x): the connection's `enabledModels` list is NOT the set the
        // 9Router provider page shows as "Available Models". The page renders
        // the provider's built-in registry list plus the router's custom
        // models and aliases, minus the disabled ones. The connection list is
        // kept in its own set so a model listed there only can be reported as
        // "not in the router available list" instead of as active.
        try {
          const connCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providerConnections'").get();
          if (connCheck) {
            const conns = db.prepare('SELECT provider, name, data FROM providerConnections').all() as Array<{ provider: string; name: string; data: string }>;
            for (const c of conns) {
              try {
                const parsed = JSON.parse(c.data);
                const emList = parsed?.providerSpecificData?.enabledModels ?? parsed?.enabledModels;
                if (Array.isArray(emList)) {
                  for (const m of emList) {
                    if (typeof m === 'string') {
                      const normId = m.startsWith('models/') ? m.slice('models/'.length) : m;
                      for (const alias of getProviderAliases(c.provider)) {
                        enabledModels.add(`${alias}/${m}`);
                        enabledModels.add(`${alias}/${normId}`);
                        connectionEnabledModels.add(`${alias}/${m}`);
                        connectionEnabledModels.add(`${alias}/${normId}`);
                      }
                    }
                  }
                }
              } catch {}
            }
          }
        } catch {
          // ignore providerConnections query error
        }
      }

      // Compute the 9Router "available models" set from an explicit evidence
      // source. `direct` contains only model availability read from the router
      // database. `snapshot` mirrors the provider page by adding the provider
      // registry shipped with this package.
      const registryModels = options.providerModels ?? NINE_ROUTER_PROVIDER_MODELS;
      const registryHasProviders = Object.keys(registryModels).length > 0;
      const useBuiltInRegistry =
        registryHasProviders && (!versionMismatch || options.providerModels !== undefined);
      const providerPrefixes = new Set<string>();
      for (const provider of Object.keys(registryModels)) {
        for (const alias of getProviderAliases(provider)) providerPrefixes.add(alias);
      }
      for (const [provider, alias] of Object.entries(registryAliases)) {
        for (const candidate of getProviderAliases(provider)) providerPrefixes.add(candidate);
        for (const candidate of getProviderAliases(alias)) providerPrefixes.add(candidate);
      }

      if (availabilitySource === 'direct') {
        // providerConnections.enabledModels is live router evidence. Combo
        // references are deliberately excluded because they are the records
        // being checked for staleness.
        for (const model of enabledModels) {
          const slashIndex = model.indexOf('/');
          if (slashIndex <= 0) {
            availableModels.add(model);
            continue;
          }
          const provider = model.slice(0, slashIndex);
          const modelId = model.slice(slashIndex + 1);
          for (const prefix of getEquivalentProviderPrefixes(provider, registryAliases)) {
            availableModels.add(`${prefix}/${modelId}`);
          }
        }
      } else if (useBuiltInRegistry) {
        for (const [alias, ids] of Object.entries(registryModels)) {
          for (const id of ids) {
            for (const a of getProviderAliases(alias)) {
              availableModels.add(`${a}/${id}`);
            }
          }
        }
        // A provider id (for example "antigravity") maps to the alias the
        // 9Router UI uses as prefix (for example "ag"), so both spellings
        // resolve to the same built-in list.
        for (const [providerId, alias] of Object.entries(registryAliases)) {
          const ids = registryModels[alias];
          if (!ids) continue;
          for (const id of ids) {
            for (const a of getProviderAliases(providerId)) {
              availableModels.add(`${a}/${id}`);
            }
          }
        }

        // For custom providers not vendored into the built-in registry:
        // their available models are normally driven by connection
        // enabledModels and comboModels. Stale-reference diagnostics can opt
        // out of comboModels so the record under test cannot validate itself.
        const builtInProviders = providerPrefixes;

        for (const m of enabledModels) {
          const slashIdx = m.indexOf('/');
          if (slashIdx > 0 && !builtInProviders.has(m.slice(0, slashIdx))) {
            availableModels.add(m);
          }
        }
        if (!options.excludeComboModelsFromAvailability) {
          for (const m of comboModels) {
            const slashIdx = m.indexOf('/');
            if (slashIdx > 0 && !builtInProviders.has(m.slice(0, slashIdx))) {
              availableModels.add(m);
            }
          }
        }
      } else {
        // Fallback: when versionMismatch is true or built-in registry is unavailable,
        // do not guess available models from connection enabledModels or comboModels.
        // Only explicit router kv custom models and alias models are added below.
      }

      for (const m of customModels) {
        availableModels.add(m);
      }

      for (const m of aliasModels) {
        availableModels.add(m);
      }

      // A disabled model is not available, whatever else lists it. Disabled
      // keys can use the provider id while availability uses the UI alias, so
      // compare equivalent prefixes instead of exact full strings.
      for (const m of [...availableModels]) {
        const slashIndex = m.indexOf('/');
        const provider = slashIndex > 0 ? m.slice(0, slashIndex) : '';
        const modelId = slashIndex > 0 ? m.slice(slashIndex + 1) : m;
        const equivalentProviders = provider
          ? getEquivalentProviderPrefixes(provider, registryAliases)
          : [];
        const isDisabled = equivalentProviders.some(
          (alias) =>
            disabledModels.has(`${alias}/${modelId}`) ||
            disabledModels.has(`${alias}/models/${modelId.replace(/^models\//, '')}`)
        );
        if (isDisabled) {
          availableModels.delete(m);
        }
      }

      // Compute standard enabled models:
      // If catalogImpliesEnabled is true, add catalogModels not in disabledModels to enabledModels.
      // Default (catalogImpliesEnabled = false): models only in catalog remain Tier B (suggested).
      if (catalogImpliesEnabled) {
        for (const m of catalogModels) {
          if (!disabledModels.has(m)) {
            enabledModels.add(m);
          }
        }
      }
      for (const m of customModels) {
        if (!disabledModels.has(m)) {
          enabledModels.add(m);
        }
      }
      for (const m of availableModels) {
        enabledModels.add(m);
      }
    }
  } finally {
    if (shouldCloseDb && db) {
      db.close();
    }
  }

  return {
    router: normRouter,
    appVersion,
    versionMismatch,
    enabledModels,
    disabledModels,
    comboModels,
    customModels,
    catalogModels,
    availableModels,
    connectionEnabledModels,
    classify(provider: string, modelId: string): ModelTierClassification {
      const cleanProv = provider.trim().toLowerCase();
      const normId = modelId.startsWith('models/') ? modelId.slice('models/'.length) : modelId;
      const aliases = getEquivalentProviderPrefixes(cleanProv, registryAliases);

      const inCombo = aliases.some(
        (a) => comboModels.has(`${a}/${modelId}`) || comboModels.has(`${a}/${normId}`)
      );

      if (isOmniRoute) {
        if (inCombo) {
          return { tier: 'A', inCombo: true, inconsistent: false, reason: 'Active in OmniRoute combo' };
        }
        return {
          tier: 'UNKNOWN',
          inCombo: false,
          inconsistent: false,
          reason: 'OmniRoute model status unverified outside combos',
        };
      }

      if (is9Router) {
        const isDisabled = aliases.some(
          (a) => disabledModels.has(`${a}/${modelId}`) || disabledModels.has(`${a}/${normId}`)
        );

        if (isDisabled) {
          return {
            tier: 'B',
            inCombo,
            inconsistent: inCombo,
            reason: inCombo
              ? 'Inconsistent: disabled in router kv but configured in active combo'
              : 'Disabled in router kv',
          };
        }

        // When version mismatch is detected: models NOT in kv disabled, customModels, or aliases
        // MUST be classified as UNKNOWN with reason 'snapshot-version-mismatch' (Condition Z2).
        if (versionMismatch) {
          const isCustomOrAlias = aliases.some(
            (a) =>
              customModels.has(`${a}/${modelId}`) ||
              customModels.has(`${a}/${normId}`) ||
              aliasModels.has(`${a}/${modelId}`) ||
              aliasModels.has(`${a}/${normId}`)
          );
          if (isCustomOrAlias) {
            return {
              tier: 'A',
              inCombo,
              inconsistent: false,
              reason: inCombo
                ? 'Available in router UI and configured in active combo'
                : 'Available in router UI (custom model or alias)',
            };
          }
          return {
            tier: 'UNKNOWN',
            inCombo,
            inconsistent: false,
            reason: 'snapshot-version-mismatch',
          };
        }

        // C4x: Tier A is the set the 9Router UI renders as "Available Models"
        // for this provider, i.e. built-in registry + router custom models
        // + router model aliases, minus the disabled ones.
        const isAvailable = aliases.some(
          (a) => availableModels.has(`${a}/${modelId}`) || availableModels.has(`${a}/${normId}`)
        );

        if (isAvailable) {
          return {
            tier: 'A',
            inCombo,
            inconsistent: false,
            reason: inCombo
              ? 'Available in router UI and configured in active combo'
              : 'Available in router UI (provider registry, custom model, or alias)',
          };
        }

        // A model that is only in a combo but not in the router's
        // available list is a stale / inconsistent reference: the combo points
        // at a model the router does not offer for that provider.
        if (inCombo) {
          return {
            tier: 'UNKNOWN',
            inCombo: true,
            inconsistent: true,
            reason:
              'Inconsistent: configured in active combo but not in the router available model list',
          };
        }

        // Opt-in: catalogImpliesEnabled promotes a catalog-only model to Tier A.
        if (catalogImpliesEnabled) {
          const isCatalogEnabled = aliases.some(
            (a) => catalogModels.has(`${a}/${modelId}`) || catalogModels.has(`${a}/${normId}`)
          );
          if (isCatalogEnabled) {
            return {
              tier: 'A',
              inCombo: false,
              inconsistent: false,
              reason: 'Active/enabled in router',
            };
          }
        }

        // C4x: a model that only shows up in a connection's
        // `providerSpecificData.enabledModels` list is NOT Tier A. The
        // 9Router provider page builds its "Available Models" list from the
        // provider registry plus the router's own custom models and aliases,
        // so a connection list entry alone does not make a model active.
        const isConnectionEnabled = aliases.some(
          (a) =>
            connectionEnabledModels.has(`${a}/${modelId}`) ||
            connectionEnabledModels.has(`${a}/${normId}`)
        );

        if (isConnectionEnabled) {
          return {
            tier: 'B',
            inCombo: false,
            inconsistent: false,
            reason:
              'Listed in a connection enabledModels set but not in the router available model list',
          };
        }

        const isInCatalog = aliases.some(
          (a) => catalogModels.has(`${a}/${modelId}`) || catalogModels.has(`${a}/${normId}`)
        );

        if (isInCatalog) {
          return {
            tier: 'B',
            inCombo: false,
            inconsistent: false,
            reason: 'Suggested in router catalog',
          };
        }

        return { tier: 'C', inCombo: false, inconsistent: false, reason: 'Unconfigured in router' };
      }

      if (inCombo) {
        return { tier: 'A', inCombo: true, inconsistent: false, reason: 'Configured in combo' };
      }
      return { tier: 'UNKNOWN', inCombo: false, inconsistent: false, reason: 'Unknown router state' };
    },
  };
}
