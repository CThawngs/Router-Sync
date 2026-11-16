/**
 * packages/cli/src/sync/provider-registry.ts
 *
 * Loads the shared provider table from registry/providers.yaml with optional
 * local layering from uncommitted providers.local.yaml (outside git):
 *   providers   : prefix -> known public GET /models base URL
 *   alias       : combo prefix that is not the provider id verbatim
 *   noKeyPublic : provider whose /models endpoint needs no Authorization
 *
 * Public registry files must only contain genuine public providers.
 * Private providers belonging to machine owners reside in an uncommitted local
 * registry file (under state-dir or custom path), layered on top of public entries.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ProviderRegistry {
  providers: Record<string, string>;
  alias: Record<string, string>;
  noKeyPublic: string[];
  officialSources?: Record<string, string> | undefined;
}

const EMPTY: ProviderRegistry = { providers: {}, alias: {}, noKeyPublic: [], officialSources: {} };

/** Find registry/providers.yaml by walking up from `cwd`. */
export function findProviderRegistryFile(cwd: string = process.cwd()): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'registry', 'providers.yaml');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Locate uncommitted local provider registry override if present:
 * 1. custom path argument (e.g. from tests or options)
 * 2. ROUTERSYNC_PROVIDERS_LOCAL environment variable
 * 3. <state-dir>/providers.local.yaml (e.g. ~/.routersync/providers.local.yaml)
 *
 * NOTE: Walking up from cwd is prohibited to prevent malicious repositories
 * from hijacking public provider URLs and redirecting credentials (Condition Z1).
 */
export function findLocalProviderRegistryFile(
  customPathOrCwd?: string | null,
  maybeCustomPath?: string | null
): string | null {
  let explicit: string | null | undefined = undefined;
  if (maybeCustomPath !== undefined) {
    explicit = maybeCustomPath;
  } else if (customPathOrCwd) {
    try {
      if (fs.existsSync(customPathOrCwd) && fs.statSync(customPathOrCwd).isFile()) {
        explicit = customPathOrCwd;
      }
    } catch {
      // ignore stat errors
    }
  }

  if (explicit && fs.existsSync(explicit)) {
    return path.resolve(explicit);
  }
  const envPath = process.env['ROUTERSYNC_PROVIDERS_LOCAL'] || process.env['ROUTERSYNC_LOCAL_REGISTRY'];
  if (envPath && fs.existsSync(envPath)) {
    return path.resolve(envPath);
  }
  const stateDir = process.env['ROUTERSYNC_STATE_DIR'] || path.join(os.homedir(), '.routersync');
  const stateCandidates = [
    path.join(stateDir, 'providers.local.yaml'),
    path.join(stateDir, 'providers.local.yml'),
  ];
  for (const c of stateCandidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse a flat two-level provider YAML mapping without external dependencies.
 */
export function parseYamlRegistry(text: string): ProviderRegistry {
  const registry: ProviderRegistry = { providers: {}, alias: {}, noKeyPublic: [], officialSources: {} };
  let section: 'providers' | 'alias' | 'noKeyPublic' | 'officialSources' | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const topLevel = line.match(/^(providers|alias|noKeyPublic|officialSources):\s*(.*)$/);
    if (topLevel) {
      section = topLevel[1] as 'providers' | 'alias' | 'noKeyPublic' | 'officialSources';
      const inline = topLevel[2]!.trim();
      if (section === 'noKeyPublic' && inline.startsWith('[')) {
        registry.noKeyPublic = inline
          .replace(/^\[/, '')
          .replace(/\]$/, '')
          .split(',')
          .map((v) => parseScalar(v))
          .filter((v) => v !== '');
      }
      continue;
    }
    if (!section) continue;
    if (section === 'noKeyPublic') {
      const item = line.match(/^\s*-\s+(.+)$/);
      if (item) registry.noKeyPublic.push(parseScalar(item[1]!));
      continue;
    }
    const pair = line.match(/^\s+([A-Za-z0-9_.-]+):\s*(.+)$/);
    if (pair) {
      if (section === 'officialSources') {
        registry.officialSources = registry.officialSources || {};
        registry.officialSources[pair[1]!] = parseScalar(pair[2]!);
      } else {
        registry[section][pair[1]!] = parseScalar(pair[2]!);
      }
    }
  }

  return registry;
}

export interface LoadProviderRegistryOptions {
  cwd?: string | undefined;
  localPath?: string | null | undefined;
}

/**
 * Read the provider table. Merges public registry/providers.yaml with any
 * uncommitted local registry override outside git (layering local over public).
 */
export function loadProviderRegistry(
  optionsOrCwd: string | LoadProviderRegistryOptions = process.cwd()
): ProviderRegistry {
  const cwd = typeof optionsOrCwd === 'string' ? optionsOrCwd : (optionsOrCwd.cwd ?? process.cwd());
  const localOverride = typeof optionsOrCwd === 'string' ? undefined : optionsOrCwd.localPath;

  const publicFile = findProviderRegistryFile(cwd);
  const publicReg = publicFile
    ? (() => {
        try {
          return parseYamlRegistry(fs.readFileSync(publicFile, 'utf8'));
        } catch {
          return EMPTY;
        }
      })()
    : EMPTY;

  if (localOverride === null) {
    return publicReg;
  }

  const localFile = findLocalProviderRegistryFile(cwd, localOverride);
  if (!localFile) {
    return publicReg;
  }

  let localReg: ProviderRegistry = EMPTY;
  try {
    localReg = parseYamlRegistry(fs.readFileSync(localFile, 'utf8'));
  } catch {
    return publicReg;
  }

  const mergedProviders = { ...publicReg.providers };
  for (const [key, url] of Object.entries(localReg.providers)) {
    if (Object.prototype.hasOwnProperty.call(publicReg.providers, key)) {
      console.warn(
        `[routersync] Local provider override rejected: "${key}" already exists in public registry. Local entry dropped to prevent credential redirection.`
      );
    } else {
      mergedProviders[key] = url;
    }
  }

  const mergedAlias = { ...publicReg.alias };
  for (const [aliasKey, target] of Object.entries(localReg.alias)) {
    if (Object.prototype.hasOwnProperty.call(publicReg.alias, aliasKey)) {
      console.warn(
        `[routersync] Local alias override rejected: "${aliasKey}" already exists in public registry. Local alias dropped.`
      );
    } else {
      mergedAlias[aliasKey] = target;
    }
  }

  return {
    providers: mergedProviders,
    alias: mergedAlias,
    noKeyPublic: Array.from(new Set([...publicReg.noKeyPublic, ...localReg.noKeyPublic])),
    officialSources: { ...(publicReg.officialSources ?? {}), ...(localReg.officialSources ?? {}) },
  };
}
