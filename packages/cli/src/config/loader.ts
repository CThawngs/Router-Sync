/**
 * packages/cli/src/config/loader.ts
 *
 * Config file resolution, YAML parsing, and Zod validation (Condition A2).
 * Strictly neutral: zero hardcoded personal paths, dynamic resolution on all OSes.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  RouterSyncConfigSchema,
  type RouterSyncConfig,
  type RouterConfig,
} from './schema.js';
import {
  locateRouterDb,
  setConfiguredRouterDbPaths,
  clearConfiguredRouterDbPaths,
  resolveConfiguredDbPaths,
  resolveSingleConfiguredDbPath,
} from '@routersync/core';

export function getDefaultConfigPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'routersync', 'config.yaml');
  }

  const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'routersync', 'config.yaml');
}

export function resolveConfigFilePath(explicitPath?: string): string {
  // 1. Explicit CLI argument
  if (explicitPath) {
    return path.resolve(expandTilde(explicitPath));
  }

  // 2. Environment variable
  if (process.env['ROUTERSYNC_CONFIG']) {
    return path.resolve(expandTilde(process.env['ROUTERSYNC_CONFIG']));
  }

  // 3. Current working directory ./routersync.yaml
  const localYaml = path.resolve('routersync.yaml');
  if (fs.existsSync(localYaml)) {
    return localYaml;
  }

  // 4. Standard OS config location
  return getDefaultConfigPath();
}

export function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export interface LoadConfigResult {
  config: RouterSyncConfig;
  filePath: string;
}

/**
 * C4n/N5: the database path of every router, resolved from the config file.
 *
 * Installed into `@routersync/core` by `loadConfigFile` so that EVERY later
 * read and every later write in this process resolves the same file. Without
 * it, `scan` read the configured database while `rank --apply` / `sync --apply`
 * wrote the platform default: the plan shown to the owner described one
 * database and the write landed in another.
 */
const installedRouterDbPaths = new Map<'9router' | 'omniroute', string>();

/**
 * Resolve the database path of one router adapter.
 *
 * Precedence (highest first):
 *   1. `routers[].db.path` from the config file (explicit owner choice)
 *   2. `ROUTERSYNC_9ROUTER_DB` / `ROUTERSYNC_OMNIROUTE_DB`
 *   3. `DATA_DIR` (9Router only, when `<DATA_DIR>/db/data.sqlite` exists)
 *   4. platform default
 *
 * The same chain is used by every read path and every write path, so a plan
 * shown for one database is always applied to that same database.
 */
export function resolveRouterDbPathForAdapter(
  adapter: '9router' | 'omniroute',
  configuredPath?: string | undefined,
  configDir?: string | undefined
): string {
  if (configuredPath && configuredPath.trim().length > 0) {
    if (!configDir) {
      const installed = installedRouterDbPaths.get(adapter);
      if (installed) return installed;
    }
    return resolveSingleConfiguredDbPath(configuredPath, configDir);
  }
  return locateRouterDb(adapter);
}

/**
 * Install the database paths declared by a config file.
 *
 * Relative `routers[].db.path` entries are resolved against `configDir` (the
 * directory containing the loaded `config.yaml`, falling back to `process.cwd()`
 * only when `configDir` is omitted). Uses `resolveConfiguredDbPaths` shared
 * across CLI, MCP server, and daemon (C4q/Q4).
 */
export function installRouterDbPaths(
  config: RouterSyncConfig | null | undefined,
  configDir?: string | undefined
): void {
  installedRouterDbPaths.clear();
  const { paths: forCore, duplicateAdapter } = resolveConfiguredDbPaths(config, configDir);
  if (duplicateAdapter || Object.keys(forCore).length === 0) {
    clearConfiguredRouterDbPaths();
    return;
  }
  for (const [adapter, resolved] of Object.entries(forCore)) {
    if ((adapter === '9router' || adapter === 'omniroute') && typeof resolved === 'string') {
      installedRouterDbPaths.set(adapter, resolved);
    }
  }
  // Hand the same paths to the core registry so `locateRouterDb()` — used by
  // the writer, the daemon and the MCP server — resolves the same file.
  clearConfiguredRouterDbPaths();
  setConfiguredRouterDbPaths(forCore, { source: 'config' });
}

/** Drop the installed database paths (used by tests and by config reloads). */
export function clearInstalledRouterDbPaths(): void {
  installedRouterDbPaths.clear();
  clearConfiguredRouterDbPaths();
}

/**
 * Unified entrypoint helper: installs configured router DB paths by loading the
 * configuration file (either explicit path, ROUTERSYNC_CONFIG, or default path).
 *
 * Called at CLI entrypoint (via Commander preAction hook), daemon startup,
 * and MCP server so all commands and processes resolve the exact same DB files
 * without individual commands needing to remember to install them.
 */
export function installConfiguredRouterDbPaths(configPath?: string): void {
  let filePath: string | undefined;
  try {
    filePath = resolveConfigFilePath(configPath);
    if (fs.existsSync(filePath)) {
      const { config, filePath: resolvedFile } = loadConfigFile(filePath);
      installRouterDbPaths(config, path.dirname(path.resolve(resolvedFile)));
    }
  } catch (err) {
    if (filePath && fs.existsSync(filePath)) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[routersync] Cảnh báo: Tệp cấu hình tại "${filePath}" không hợp lệ (${msg}). Sử dụng đường dẫn mặc định.`);
    }
    // If config does not exist or fails validation, keep defaults / env overrides
  }
}

/**
 * The database path of one router for this process.
 *
 * Same chain as `resolveRouterDbPath`: config file first, then the env
 * override, then the platform default. When no config file was loaded the
 * env override / platform default still applies.
 */
export function installedRouterDbPath(router: '9router' | 'omniroute'): string {
  return installedRouterDbPaths.get(router) ?? resolveRouterDbPathForAdapter(router);
}

export function loadConfigFile(explicitPath?: string): LoadConfigResult {
  const filePath = resolveConfigFilePath(explicitPath);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Configuration file not found at: ${filePath}\n` +
      `Run \`routersync init\` to generate a default configuration file.`
    );
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read configuration file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(rawContent);
  } catch (err) {
    throw new Error(`YAML syntax error in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parseResult = RouterSyncConfigSchema.safeParse(parsedYaml);
  if (!parseResult.success) {
    const errorDetails = parseResult.error.issues
      .map((issue) => `  - [${issue.path.join('.') || 'root'}]: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration validation error in ${filePath}:\n${errorDetails}`);
  }

  // C4n/N5 & C4q/Q4: install the database paths from this config (resolved
  // relative to the directory containing `filePath`) so every later read and
  // write in this process resolves the same file as MCP and daemon.
  installRouterDbPaths(parseResult.data, path.dirname(path.resolve(filePath)));

  return {
    config: parseResult.data,
    filePath,
  };
}

export function resolveRouterDbPath(router: RouterConfig, configDir?: string): string {
  return resolveRouterDbPathForAdapter(router.adapter, router.db?.path, configDir);
}

export function getSampleConfigYaml(): string {
  return `# RouterSync Configuration (version 1)
# Declarative combo synchronization for LLM routers
version: 1

routers:
  - id: omni
    adapter: omniroute
    baseUrl: http://localhost:30128
    auth:
      apiKeyEnv: OMNIROUTE_API_KEY
    write: db
    reload:
      type: none

  - id: nine
    adapter: 9router
    baseUrl: http://localhost:20128
    write: db
    reload:
      type: none

sources:
  providers:
    enabled: true
  aggregators:
    - openrouter
    - litellm
  community_registry: true
  news_signals:
    enabled: false

policy:
  mode: manual
  schedule:
    sync: every 1h
    health: every 2m
  quarantine:
    consecutive_failures: 3
    not_found_confirmations: 2
    recheck_after: 30m

combos:
  - name: rs-coder
    role: coding
    routers:
      - omni
      - nine
    size: 3
    constraints:
      minContext: 128000
      toolUse: required
      freeOnly: false
    pin: []
    exclude: []

adopt: []
`;
}
