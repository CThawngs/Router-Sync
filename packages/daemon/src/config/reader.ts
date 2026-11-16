/**
 * packages/daemon/src/config/reader.ts
 *
 * Lightweight read-only configuration reader for @routersync/daemon (S1 Slice).
 * Reads routersync.yaml without importing external parser packages.
 *
 * R16-4: the reader now reports HOW the config file was resolved instead of
 * collapsing every problem into `configFound: false`:
 *   - 'missing'   -> the file does not exist (ENOENT). A machine that was
 *                    never configured has no config file; that is a NORMAL S1
 *                    state, not a failure (DECISIONS 2026-10-20-01).
 *   - 'ok'        -> the file was read and is syntactically usable.
 *   - 'unreadable'-> the file exists but could not be read (EACCES, EISDIR…).
 *   - 'invalid'   -> the file was read but its content is not a usable YAML
 *                    mapping (broken YAML, or a document that is not an
 *                    object — an empty file included).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveConfiguredDbPaths, type RouterDbConfigEntry } from '@routersync/core/readonly';
import { lintConfigText } from './lint.js';

export type ConfigFileStatus = 'missing' | 'ok' | 'unreadable' | 'invalid';

export interface DaemonResolvedConfig {
  policyMode: 'manual' | 'shadow' | 'auto-low-risk' | 'auto';
  omniUrl?: string | undefined;
  omniDbPath?: string | undefined;
  nineUrl?: string | undefined;
  nineDbPath?: string | undefined;
  /** True only when the config file was found AND is usable. */
  configFound: boolean;
  configPath?: string | undefined;
  /** R16-4: how the config file resolved (missing / ok / unreadable / invalid). */
  configStatus: ConfigFileStatus;
  /** R16-4: machine-readable detail (errno code or lint token) for a non-'ok' status. */
  configReason?: string | undefined;
}

/**
 * Resolves the config path to inspect.
 *
 * R16-4: when `ROUTERSYNC_CONFIG` is set it is AUTHORITATIVE — the path is
 * returned even when the file does not exist, so the caller can report
 * 'missing' instead of silently falling back to a DIFFERENT config file
 * (the fallback would make the doctor talk about a file the operator never
 * asked for, and would make hermetic tests read the owner's real config).
 */
export function resolveConfigPath(): string | undefined {
  const envPath = process.env['ROUTERSYNC_CONFIG'];
  if (envPath && envPath.trim().length > 0) {
    return path.resolve(envPath.trim());
  }

  const cwdYaml = path.resolve('routersync.yaml');
  if (fs.existsSync(cwdYaml)) return cwdYaml;

  const appData =
    process.env['APPDATA'] ??
    (os.platform() === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Roaming')
      : path.join(os.homedir(), '.config'));
  const defaultPath = path.join(appData, 'routersync', 'config.yaml');
  if (fs.existsSync(defaultPath)) return defaultPath;

  return undefined;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

export function readDaemonConfig(): DaemonResolvedConfig {
  const configPath = resolveConfigPath();
  if (!configPath) {
    return {
      policyMode: 'manual',
      configFound: false,
      configStatus: 'missing',
      configReason: 'no_config_path',
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err: unknown) {
    const code = errorCode(err);
    // ENOENT = the file is simply not there (never configured machine).
    // Anything else = the file is there but cannot be read.
    const status: ConfigFileStatus = code === 'ENOENT' ? 'missing' : 'unreadable';
    return {
      policyMode: 'manual',
      configFound: false,
      configPath,
      configStatus: status,
      configReason: code || 'read_failed',
    };
  }

  const lint = lintConfigText(raw);
  if (!lint.ok) {
    // A broken config is never used: the daemon falls back to the manual
    // policy mode and to the DB paths it can discover on its own.
    return {
      policyMode: 'manual',
      configFound: false,
      configPath,
      configStatus: 'invalid',
      configReason: lint.reason ?? 'invalid_yaml',
    };
  }

  try {
    // Extract policy.mode via regex
    let policyMode: 'manual' | 'shadow' | 'auto-low-risk' | 'auto' = 'manual';
    const policyModeMatch = raw.match(/mode:\s*['"]?(manual|shadow|auto-low-risk|auto)['"]?/);
    if (policyModeMatch && policyModeMatch[1]) {
      policyMode = policyModeMatch[1] as any;
    }

    // Extract router URLs
    let omniUrl: string | undefined;
    let nineUrl: string | undefined;
    let omniDbPath: string | undefined;
    let nineDbPath: string | undefined;

    // Match router sections
    const routerEntries: RouterDbConfigEntry[] = [];
    const routerBlocks = raw.split(/-\s+id:\s*/);
    for (const block of routerBlocks) {
      const adapterMatch = block.match(/adapter:\s*['"]?(omniroute|9router)['"]?/);
      const isOmni = block.startsWith('omniroute') || adapterMatch?.[1] === 'omniroute';
      const isNine = block.startsWith('9router') || adapterMatch?.[1] === '9router';
      if (isOmni) {
        const urlMatch = block.match(/baseUrl:\s*['"]?([^\s'"]+)['"]?/);
        if (urlMatch && urlMatch[1]) omniUrl = urlMatch[1];
        const dbMatch = block.match(/path:\s*['"]?([^\s'"]+)['"]?/);
        if (dbMatch && dbMatch[1]) {
          routerEntries.push({ adapter: 'omniroute', db: { path: dbMatch[1] } });
        }
      } else if (isNine) {
        const urlMatch = block.match(/baseUrl:\s*['"]?([^\s'"]+)['"]?/);
        if (urlMatch && urlMatch[1]) nineUrl = urlMatch[1];
        const dbMatch = block.match(/path:\s*['"]?([^\s'"]+)['"]?/);
        if (dbMatch && dbMatch[1]) {
          routerEntries.push({ adapter: '9router', db: { path: dbMatch[1] } });
        }
      }
    }

    const { paths: resolvedDbPaths, duplicateAdapter } = resolveConfiguredDbPaths(
      { routers: routerEntries },
      path.dirname(path.resolve(configPath))
    );
    if (!duplicateAdapter) {
      omniDbPath = resolvedDbPaths['omniroute'];
      nineDbPath = resolvedDbPaths['9router'];
    }

    return {
      policyMode,
      omniUrl,
      omniDbPath,
      nineUrl,
      nineDbPath,
      configFound: true,
      configPath,
      configStatus: 'ok',
    };
  } catch {
    return {
      policyMode: 'manual',
      configFound: false,
      configPath,
      configStatus: 'invalid',
      configReason: 'parse_failed',
    };
  }
}
