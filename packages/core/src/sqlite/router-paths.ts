/**
 * packages/core/src/sqlite/router-paths.ts
 *
 * The single registry of "which SQLite file belongs to which router".
 *
 * C4n/N5: `scan` read the database named by `routers[].db.path` in the
 * configuration file, while `rank --apply` / `sync --apply` wrote the platform
 * default. The plan shown to the owner therefore described one database and the
 * write landed in another.
 *
 * The CLI and MCP server install paths from `config.yaml` with `source: 'config'`,
 * which `locateRouterDb()` consults BEFORE any environment variable override.
 * Paths installed by the daemon reader with `source: 'daemon'` are consulted
 * AFTER environment variable overrides (`ROUTERSYNC_*`, legacy env aliases, and
 * `DATA_DIR`) and before the platform default. Every reader and every writer —
 * in the CLI, in the daemon and in the MCP server — then resolves the same file.
 *
 * This module holds no database handle and no write capability: it is pure
 * path metadata, so the read-only entrypoint may export it safely.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

export type RouterAdapterName = '9router' | 'omniroute';
export type RouterDbPathSource = 'config' | 'daemon';

export interface RouterDbConfigEntry {
  adapter?: string | undefined;
  db?: { path?: string | undefined } | undefined;
}

export interface RouterDbConfigLike {
  routers?: readonly RouterDbConfigEntry[] | undefined;
}

interface ConfiguredPathEntry {
  path: string;
  source: RouterDbPathSource;
}

const configuredRouterDbPaths = new Map<RouterAdapterName, ConfiguredPathEntry>();

/**
 * Returns the first trimmed non-empty string from `values`, or `undefined` if
 * every candidate is `undefined` or whitespace-only (C4q/Q4).
 */
export function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) {
      return v.trim();
    }
  }
  return undefined;
}

/**
 * Expands leading `~` (`~`, `~/...`, `~\...`) against `homeDir` (defaults to `os.homedir()`).
 */
export function expandTildePath(p: string, homeDir: string = os.homedir()): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(homeDir, p.slice(2));
  }
  return p;
}

/**
 * Resolves a single configured database path (`routers[].db.path`) against `configDir`
 * (when provided; otherwise `process.cwd()`), expanding leading `~` first.
 */
export function resolveSingleConfiguredDbPath(
  rawDbPath: string,
  configDir?: string | undefined,
  homeDir: string = os.homedir()
): string {
  const expanded = expandTildePath(rawDbPath.trim(), homeDir);
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return configDir ? path.resolve(configDir, expanded) : path.resolve(expanded);
}

/**
 * Shared helper for CLI (`packages/cli/src/config/loader.ts`), MCP (`packages/mcp-server/src/server.ts`),
 * and Daemon: extracts `routers[].db.path` from a parsed config object and resolves relative paths
 * against `configDir` (the directory containing the config file, falling back to `process.cwd()`
 * only when `configDir` is omitted).
 *
 * Rejects configs that declare duplicate `adapter` entries (`9router` or `omniroute` listed twice)
 * by returning `{ paths: {}, duplicateAdapter }` so callers never silently pick one duplicate over another.
 */
export function resolveConfiguredDbPaths(
  config: RouterDbConfigLike | null | undefined,
  configDir?: string | undefined,
  homeDir: string = os.homedir()
): {
  paths: Partial<Record<RouterAdapterName, string>>;
  duplicateAdapter?: string | undefined;
} {
  const paths: Partial<Record<RouterAdapterName, string>> = {};
  if (!config || !Array.isArray(config.routers)) {
    return { paths };
  }
  const seenAdapters = new Set<string>();
  for (const r of config.routers) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.adapter === 'string' && r.adapter.length > 0) {
      if (seenAdapters.has(r.adapter)) {
        return { paths: {}, duplicateAdapter: r.adapter };
      }
      seenAdapters.add(r.adapter);
    }
  }
  for (const r of config.routers) {
    if (!r || typeof r !== 'object') continue;
    if (r.adapter !== '9router' && r.adapter !== 'omniroute') continue;
    const adapter: RouterAdapterName = r.adapter;
    const rawPath = r.db?.path;
    if (typeof rawPath === 'string' && rawPath.trim().length > 0) {
      paths[adapter] = resolveSingleConfiguredDbPath(rawPath, configDir, homeDir);
    }
  }
  return { paths };
}

/**
 * Install database paths declared in a configuration file or daemon config.
 *
 * Merging rule (P1):
 * - Does NOT clear the registry; it merges new paths into the map.
 * - 'config' source (from config.yaml) has higher precedence than 'daemon' source (from daemon config).
 * - A 'daemon' path will not overwrite an existing 'config' path.
 * - A 'config' path will always overwrite a 'daemon' path.
 */
export function setConfiguredRouterDbPaths(
  paths: Partial<Record<RouterAdapterName, string>>,
  options?: { source?: RouterDbPathSource }
): void {
  const source: RouterDbPathSource = options?.source ?? 'config';
  for (const [router, dbPath] of Object.entries(paths)) {
    if (router !== '9router' && router !== 'omniroute') continue;
    if (typeof dbPath !== 'string' || dbPath.trim().length === 0) continue;
    const existing = configuredRouterDbPaths.get(router as RouterAdapterName);
    if (existing && existing.source === 'config' && source === 'daemon') {
      // config.yaml path wins over daemon config path
      continue;
    }
    configuredRouterDbPaths.set(router as RouterAdapterName, {
      path: path.resolve(dbPath.trim()),
      source,
    });
  }
}

/** The database paths currently installed (empty when no config was loaded). */
export function getConfiguredRouterDbPaths(): Partial<Record<RouterAdapterName, string>> {
  const result: Partial<Record<RouterAdapterName, string>> = {};
  for (const [k, v] of configuredRouterDbPaths.entries()) {
    result[k] = v.path;
  }
  return result;
}

/** Drop the installed database paths (used by tests and by config reloads). */
export function clearConfiguredRouterDbPaths(): void {
  configuredRouterDbPaths.clear();
}

/**
 * The configured path of one router, or undefined when the config did not
 * name one.
 */
export function getConfiguredRouterDbPath(router: RouterAdapterName): string | undefined {
  return configuredRouterDbPaths.get(router)?.path;
}

/**
 * Locates the database file for known router targets using a unified precedence (P1 / Q4):
 *
 * Precedence for OmniRoute:
 *   1. Configured path from `config.yaml` (`routers[].db.path` installed with `source: 'config'`)
 *   2. ROUTERSYNC_OMNIROUTE_DB env override
 *   3. Legacy alias: OMNIROUTE_DB_PATH env override (lower precedence than ROUTERSYNC_*)
 *   4. Daemon config path (`source: 'daemon'`, lower precedence than env overrides)
 *   5. Platform default: ~/.omniroute/storage.sqlite
 *
 * Precedence for 9Router:
 *   1. Configured path from `config.yaml` (`routers[].db.path` installed with `source: 'config'`)
 *   2. ROUTERSYNC_9ROUTER_DB env override
 *   3. Legacy aliases: NINEROUTER_DB_PATH or NINE_ROUTER_DB_PATH env override (via `firstNonEmpty`)
 *   4. DATA_DIR env override (only if ${DATA_DIR}/db/data.sqlite exists on disk)
 *   5. Daemon config path (`source: 'daemon'`, lower precedence than env overrides)
 *   6. Platform default:
 *      - win32: %APPDATA%\9router\db\data.sqlite
 *      - darwin / linux / others: ~/.9router/db/data.sqlite
 */
export function locateRouterDb(
  router: RouterAdapterName,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const configuredEntry = configuredRouterDbPaths.get(router);
  if (configuredEntry && configuredEntry.source === 'config') {
    return path.resolve(configuredEntry.path);
  }

  if (router === 'omniroute') {
    // 2. ROUTERSYNC_OMNIROUTE_DB
    const override = firstNonEmpty(env['ROUTERSYNC_OMNIROUTE_DB']);
    if (override) return path.resolve(override);

    // 3. Legacy alias: OMNIROUTE_DB_PATH
    const legacy = firstNonEmpty(env['OMNIROUTE_DB_PATH']);
    if (legacy) return path.resolve(legacy);

    // 4. Daemon config path (lower precedence than env overrides)
    if (configuredEntry && configuredEntry.source === 'daemon') {
      return path.resolve(configuredEntry.path);
    }

    // 5. Platform default
    const home = firstNonEmpty(env['HOME'], env['USERPROFILE']) ?? os.homedir();
    return path.resolve(path.join(home, '.omniroute', 'storage.sqlite'));
  }

  if (router === '9router') {
    // 2. ROUTERSYNC_9ROUTER_DB
    const override = firstNonEmpty(env['ROUTERSYNC_9ROUTER_DB']);
    if (override) return path.resolve(override);

    // 3. Legacy aliases: NINEROUTER_DB_PATH, NINE_ROUTER_DB_PATH
    const legacy = firstNonEmpty(env['NINEROUTER_DB_PATH'], env['NINE_ROUTER_DB_PATH']);
    if (legacy) return path.resolve(legacy);

    // 4. DATA_DIR env override (only if ${DATA_DIR}/db/data.sqlite exists on disk)
    const dataDir = firstNonEmpty(env['DATA_DIR']);
    if (dataDir) {
      const candidate = path.resolve(path.join(dataDir, 'db', 'data.sqlite'));
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // Fall through if file check fails
      }
    }

    // 5. Daemon config path (lower precedence than env overrides)
    if (configuredEntry && configuredEntry.source === 'daemon') {
      return path.resolve(configuredEntry.path);
    }

    // 6. Platform default
    if (platform === 'win32') {
      const appData =
        firstNonEmpty(env['APPDATA']) ??
        path.join(firstNonEmpty(env['USERPROFILE'], env['HOME']) ?? os.homedir(), 'AppData', 'Roaming');
      return path.resolve(path.join(appData, '9router', 'db', 'data.sqlite'));
    }
    const home = firstNonEmpty(env['HOME'], env['USERPROFILE']) ?? os.homedir();
    return path.resolve(path.join(home, '.9router', 'db', 'data.sqlite'));
  }

  throw new Error(`Unknown router identifier: ${router}`);
}

