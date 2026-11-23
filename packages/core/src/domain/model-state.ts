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

/**
 * C19 W7 (G3): the single default for tier classification. It stays `snapshot`
 * because tier parity with the 9Router provider page is defined against the
 * shipped registry (see packages/core/test/model-tiers-ui-parity.test.ts).
 * Staleness diagnostics deliberately do not use this constant: `combos stale`
 * uses `direct` (DEFAULT_STALE_SOURCE) so a combo cannot validate itself.
 */
export const DEFAULT_AVAILABILITY_SOURCE: 'direct' | 'snapshot' = 'snapshot';

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
  comboNames?: Iterable<string> | undefined;
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

export type ReadRouterModelStateOptions = RouterModelStateOptions;

export interface RouterModelDiagnostics {
  /** True when a database path was resolved (configured or auto-located). */
  dbResolved: boolean;
  /** True when the database file opened read-only. */
  dbOpened: boolean;
  /** Table names the reader expected and did not find. */
  missingTables: string[];
  /** Count of values that failed to parse (combo lists, kv rows, catalog). */
  parseErrors: number;
  /** True when the router app version differs from the shipped snapshot. */
  versionMismatch: boolean;
  /** Evidence source used for the available-model set. */
  availabilitySource: 'direct' | 'snapshot';
  /** Basename only; never a full personal path. */
  dbName?: string | undefined;
}

export interface RouterModelState {
  router: string;
  appVersion?: string | undefined;
  versionMismatch?: boolean | undefined;
  enabledModels: Set<string>;
  disabledModels: Set<string>;
  comboModels: Set<string>;
  comboNames: Set<string>;
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
  /** Provider prefixes that actually carried availability evidence. */
  availabilityProviders: Set<string>;
  diagnostics: RouterModelDiagnostics;
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
  const comboNames = new Set<string>();
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

  // Seed comboNames if explicitly provided in options
  if (options.comboNames) {
    for (const name of options.comboNames) {
      if (typeof name === 'string' && name.trim().length > 0) {
        comboNames.add(name.trim());
      }
    }
  }

  const is9Router = normRouter === '9router';
  const isOmniRoute = normRouter === 'omniroute';

  // Opt-in: treat a model that only appears in the router catalog as active.
  // Default is false, so a catalog-only model stays Tier B (suggested).
  const catalogImpliesEnabled = Boolean(options.catalogImpliesEnabled);
  const availabilitySource = options.availabilitySource ?? DEFAULT_AVAILABILITY_SOURCE;
  const registryAliases = options.providerAliases ?? NINE_ROUTER_PROVIDER_ALIASES;

  let appVersion = options.appVersion;
  let versionMismatch = false;

  let db: SqliteDriver | undefined = options.db;
  let shouldCloseDb = false;
  let resolvedDbPath = options.dbPath;
  const missingTables: string[] = [];
  let parseErrors = 0;
  const evidenceProviders = new Set<string>();

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
        if (!tableCheck) {
          missingTables.push('combos');
        } else {
          const rows = db.prepare('SELECT * FROM combos').all() as Array<Record<string, unknown>>;
          for (const row of rows) {
            const rawRowName = typeof row['name'] === 'string' ? row['name'].trim() : '';
            if (rawRowName) {
              comboNames.add(rawRowName);
            } else if (typeof row['id'] === 'string' && row['id'].trim()) {
              comboNames.add(row['id'].trim());
            }

            const rawModels = (row['models'] ?? row['data']) as string | undefined;
            if (rawModels && typeof rawModels === 'string') {
              try {
                const parsed = JSON.parse(rawModels);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  const parsedName = (parsed as Record<string, unknown>)['name'];
                  if (typeof parsedName === 'string' && parsedName.trim()) {
                    comboNames.add(parsedName.trim());
                  }
                }
                const list = Array.isArray(parsed)
                  ? parsed
                  : Array.isArray((parsed as Record<string, unknown>)?.models)
                  ? (parsed as Record<string, unknown>).models
                  : [];
                if (Array.isArray(list)) {
                  for (const m of list) {
                    // C31 L1: OmniRoute stores combo steps as objects
                    // ({ id, kind, model, providerId, weight }) while 9Router
                    // stores plain "provider/model" strings.
                    let stepId = '';
                    if (typeof m === 'string') {
                      stepId = m.trim();
                    } else if (m && typeof m === 'object') {
                      const rec = m as Record<string, unknown>;
                      const provider = (rec['providerId'] ?? rec['provider'] ?? rec['prefix']) as string | undefined;
                      const model = (rec['model'] ?? rec['modelId']) as string | undefined;
                      if (typeof provider === 'string' && provider.trim() && typeof model === 'string' && model.trim()) {
                        stepId = `${provider.trim()}/${model.trim()}`;
                      } else if (typeof model === 'string' && model.includes('/')) {
                        const trimmed = model.trim();
                        const slash = trimmed.indexOf('/');
                        if (slash > 0 && slash < trimmed.length - 1) {
                          stepId = trimmed;
                        }
                      }
                    }
                    if (!stepId) continue;
                    if (stepId.includes('/')) {
                      const slashIdx = stepId.indexOf('/');
                      const prov = stepId.slice(0, slashIdx).trim();
                      const mId = stepId.slice(slashIdx + 1).trim();
                      if (!prov || !mId) continue;
                      const normId = mId.startsWith('models/') ? mId.slice('models/'.length) : mId;
                      if (!normId) continue;
                      for (const alias of getProviderAliases(prov)) {
                        comboModels.add(`${alias}/${mId}`);
                        comboModels.add(`${alias}/${normId}`);
                      }
                    } else {
                      comboModels.add(stepId);
                    }
                  }
                }
              } catch {
                parseErrors += 1;
              }
            }
          }
        }
      } catch {
          // A database that opens but cannot answer the combos query is still
          // unreadable evidence, not "no combos".
          missingTables.push('combos (unreadable)');
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
            evidenceProviders.add(prefix);
          }
        }
      } else if (useBuiltInRegistry) {
        for (const [alias, ids] of Object.entries(registryModels)) {
          for (const id of ids) {
            for (const a of getProviderAliases(alias)) {
              availableModels.add(`${a}/${id}`);
              evidenceProviders.add(a);
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
              evidenceProviders.add(a);
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
            evidenceProviders.add(m.slice(0, slashIdx));
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

    // 3. OmniRoute state (C31 L1).
    //
    // OmniRoute keeps its router state in the same `key_value` table shape as
    // 9Router but with different namespaces:
    //   - `syncedAvailableModels`: provider -> JSON array of model objects.
    //     This is the provider's synced model list, i.e. live router evidence.
    //   - `customModels`: provider -> JSON array of models added by hand.
    //   - `modelAliases`: alias -> "provider/model" target.
    //   - `radar_local_model_state`: provider, model_id, enabled, tombstoned.
    //     Only used for the DISABLED verdict; it is empty on most installs, and
    //     an empty table must not be read as "nothing disabled".
    if (isOmniRoute) {
      // A DB that opens but cannot answer these queries is unreadable evidence,
      // never "the router has nothing".
      try {
      if (db) {
        const kvCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='key_value'").get();
        if (!kvCheck) {
          missingTables.push('key_value');
        } else {
          const addPair = (provider: string, modelId: string) => {
            const clean = modelId.startsWith('models/') ? modelId.slice('models/'.length) : modelId;
            availableModels.add(`${provider}/${clean}`);
            availableModels.add(`${provider}/${modelId}`);
          };
          const parseModels = (raw: unknown): Array<Record<string, unknown>> => {
            try {
              const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
              if (!Array.isArray(parsed)) return [];
              return parsed.filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object');
            } catch {
              return [];
            }
          };

          const synced = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'syncedAvailableModels'").all() as Array<{ key: string; value: string }>;
          for (const row of synced) {
            // OmniRoute keys this namespace "<provider>:<connectionId>"; the
            // combo steps carry the bare provider code, so split on ':'.
            const provider = (String(row.key ?? '').split(':')[0] ?? '').trim();
            if (!provider) continue;
            for (const model of parseModels(row.value)) {
              const id = typeof model['id'] === 'string' ? model['id'] : undefined;
              if (!id) continue;
              addPair(provider, id);
            }
            // A row that exists is evidence this provider is known to the
            // router, even when its synced list is empty.
            evidenceProviders.add(provider);
          }

          const custom = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'customModels'").all() as Array<{ key: string; value: string }>;
          for (const row of custom) {
            const provider = String(row.key ?? '').trim();
            if (!provider) continue;
            evidenceProviders.add(provider);
            for (const model of parseModels(row.value)) {
              const id = typeof model['id'] === 'string' ? model['id'] : undefined;
              if (!id) continue;
              if (model['isHidden'] === true || model['tombstoned'] === true) {
                const cleanId = id.replace(/^models\//, '');
                if (cleanId) {
                  for (const alias of getProviderAliases(provider)) {
                    disabledModels.add(`${alias}/${cleanId}`);
                    disabledModels.add(`${alias}/models/${cleanId}`);
                  }
                }
                continue;
              }
              addPair(provider, id);
            }
          }

          const aliases = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'modelAliases'").all() as Array<{ key: string; value: string }>;
          for (const row of aliases) {
            const alias = String(row.key ?? '').trim();
            let target = String(row.value ?? '').trim();
            try {
              const parsed: unknown = JSON.parse(target);
              if (typeof parsed === 'string') target = parsed;
            } catch {
              /* value may be stored unquoted */
            }
            const slash = target.indexOf('/');
            if (!alias || slash <= 0) continue;
            const provider = target.slice(0, slash);
            const modelId = target.slice(slash + 1);
            if (!modelId) continue;
            evidenceProviders.add(provider);
            aliasModels.add(`${provider}/${modelId}`);
            // A combo may reference the alias itself; resolve it to the target.
            aliasModels.add(`${alias}/${modelId}`);
          }
        }

        // Disabled state: only an explicit row can disable a model.
        const radarCheck = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='radar_local_model_state'"
        ).get();
        if (radarCheck) {
          try {
            const rows = db
              .prepare('SELECT provider, model_id, enabled, tombstoned FROM radar_local_model_state')
              .all() as Array<{ provider: string; model_id: string; enabled: number; tombstoned: number }>;
            for (const r of rows) {
              if (r.enabled === 0 || r.tombstoned === 1) {
                const rawProv = String(r.provider ?? '').trim();
                const rawModelId = String(r.model_id ?? '').trim();
                const cleanId = rawModelId.replace(/^models\//, '');
                if (rawProv && cleanId) {
                  for (const alias of getProviderAliases(rawProv)) {
                    disabledModels.add(`${alias}/${cleanId}`);
                    disabledModels.add(`${alias}/models/${cleanId}`);
                  }
                }
              }
            }
          } catch {
            // A broken table is not evidence of "nothing disabled".
            missingTables.push('radar_local_model_state (unreadable)');
          }
        }
      }

      // `direct` is the only honest source for OmniRoute: there is no registry
      // shipped with RouterSync that mirrors its provider pages. `snapshot`
      // therefore behaves like `direct` and says so in the report note.
      // M1-02: Merge active comboModels into availableModels unless explicitly
      // excluded for staleness checks (`combos stale` passes excludeComboModelsFromAvailability=true
      // so combo steps never self-validate or fabricate provider evidence).
      if (!options.excludeComboModelsFromAvailability) {
        for (const m of comboModels) {
          const slashIdx = m.indexOf('/');
          if (slashIdx > 0) {
            const provider = m.slice(0, slashIdx).trim();
            const modelId = m.slice(slashIdx + 1).trim();
            if (!provider || !modelId) continue;
            const clean = modelId.startsWith('models/') ? modelId.slice('models/'.length) : modelId;
            if (!clean) continue;
            availableModels.add(`${provider}/${clean}`);
            availableModels.add(`${provider}/${modelId}`);
          } else if (m.trim()) {
            availableModels.add(m.trim());
          }
        }
      }
      for (const m of customModels) availableModels.add(m);
      for (const m of aliasModels) availableModels.add(m);
      // A model the router itself disabled must not be reported as present.
      for (const m of disabledModels) availableModels.delete(m);
      for (const m of availableModels) enabledModels.add(m);
      } catch {
        missingTables.push('key_value (unreadable)');
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
    comboNames,
    customModels,
    catalogModels,
    availableModels,
    connectionEnabledModels,
    availabilityProviders: evidenceProviders,
    diagnostics: {
      dbResolved: Boolean(resolvedDbPath),
      dbOpened: db !== undefined,
      missingTables,
      parseErrors,
      versionMismatch,
      availabilitySource,
      dbName: resolvedDbPath ? path.basename(resolvedDbPath) : undefined,
    },
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
