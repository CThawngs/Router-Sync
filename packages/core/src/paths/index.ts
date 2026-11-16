/**
 * packages/core/src/paths/index.ts
 *
 * Cross-platform paths and naming normalization (SPEC §32 / D25 / X1, X2, X8).
 * Ensures uniform behavior across Windows, macOS, and Linux without hardcoded separator assumptions.
 */

import * as path from 'node:path';
import * as os from 'node:os';

export interface PathCandidate {
  path: string;
  evidence: 'REAL' | 'PUBLIC_DOC' | 'UNVERIFIED';
  os: 'win32' | 'darwin' | 'linux';
  note?: string;
}

export interface LocateResult {
  status: 'found' | 'not-found';
  selectedPath?: string;
  candidates: PathCandidate[];
}

/**
 * X1: Returns the standard config directory per OS.
 * Windows: %APPDATA%\routersync or %USERPROFILE%\AppData\Roaming\routersync
 * Linux/macOS: $XDG_CONFIG_HOME/routersync or ~/.config/routersync
 * Overridable by ROUTERSYNC_HOME.
 */
export function getConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const homeOverride = env['ROUTERSYNC_HOME'];
  if (homeOverride && homeOverride.trim().length > 0) {
    return path.resolve(homeOverride.trim(), 'config');
  }

  if (platform === 'win32') {
    const appData = env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'routersync');
  }

  const xdgConfig = env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'routersync');
}

/**
 * X1: Returns the standard state directory per OS (catalog, snapshots, logs).
 * Windows: %LOCALAPPDATA%\routersync (avoids roaming sync)
 * Linux/macOS: $XDG_STATE_HOME/routersync or ~/.local/state/routersync
 * Overridable by ROUTERSYNC_STATE_DIR or ROUTERSYNC_HOME.
 */
export function getStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const stateOverride = env['ROUTERSYNC_STATE_DIR'];
  if (stateOverride && stateOverride.trim().length > 0) {
    return path.resolve(stateOverride.trim());
  }

  const homeOverride = env['ROUTERSYNC_HOME'];
  if (homeOverride && homeOverride.trim().length > 0) {
    return path.resolve(homeOverride.trim(), 'state');
  }

  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'routersync');
  }

  const xdgState = env['XDG_STATE_HOME'] ?? path.join(os.homedir(), '.local', 'state');
  return path.join(xdgState, 'routersync');
}

export function getCatalogDbPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return path.join(getStateDir(env, platform), 'catalog.sqlite');
}

export function getSnapshotsDir(
  envOrStateDir?: string | NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): string {
  if (typeof envOrStateDir === 'string') {
    return path.join(envOrStateDir, 'snapshots');
  }
  return path.join(getStateDir(envOrStateDir, platform), 'snapshots');
}

export function getLogsDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return path.join(getStateDir(env, platform), 'logs');
}

/**
 * X8: Checks if a database path resides on a cloud sync folder, network share, or cross-OS mount.
 */
export function isSyncOrNetworkFs(targetPath: string): { isSyncOrNetwork: boolean; warning?: string } {
  const normalized = targetPath.replace(/\\/g, '/');

  // UNC network share
  if (targetPath.startsWith('\\\\') || targetPath.startsWith('//')) {
    return {
      isSyncOrNetwork: true,
      warning: 'UNC network share (UNC)',
    };
  }

  // Cloud sync providers
  const syncPatterns = [
    { pattern: /onedrive/i, name: 'OneDrive' },
    { pattern: /dropbox/i, name: 'Dropbox' },
    { pattern: /google[ _-]?drive/i, name: 'Google Drive' },
    { pattern: /icloud/i, name: 'iCloud Drive' },
  ];

  for (const { pattern, name } of syncPatterns) {
    if (pattern.test(normalized)) {
      return {
        isSyncOrNetwork: true,
        warning: `Cloud-synced folder (${name})`,
      };
    }
  }

  // WSL mount (/mnt/c/...)
  if (/^\/mnt\/[a-z]\//i.test(normalized)) {
    return {
      isSyncOrNetwork: true,
      warning: 'WSL 9p / drvfs cross-OS filesystem mount (/mnt/*)',
    };
  }

  return { isSyncOrNetwork: false };
}

/**
 * X2: Checks if a filename is safe across Windows, macOS, and Linux.
 */
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const ILLEGAL_CHARS = /[/\\:*?"<>|]/;

export function isSafeFilename(name: string): boolean {
  if (!name || name.trim().length === 0) return false;
  if (name.length > 240) return false;
  if (ILLEGAL_CHARS.test(name)) return false;
  if (name.endsWith('.') || name.endsWith(' ')) return false;
  if (WINDOWS_RESERVED_NAMES.test(name)) return false;
  return true;
}

/**
 * X2: Normalizes an arbitrary string into a safe, valid slug across all platforms.
 */
export function safeSlug(input: string): string {
  let cleaned = input
    .toLowerCase()
    .replace(/[/\\:*?"<>|#@$%^&()+=`~]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');

  if (cleaned.length === 0 || WINDOWS_RESERVED_NAMES.test(cleaned)) {
    cleaned = `rs-${cleaned || 'item'}`;
  }

  if (cleaned.length > 200) {
    cleaned = cleaned.substring(0, 200).replace(/-+$/, '');
  }

  return cleaned;
}

/**
 * X2: Generates a colon-free, collision-resistant snapshot identifier.
 * Format: YYYYMMDDTHHMMSSZ-<8hex>
 */
export function createSnapshotId(date = new Date()): string {
  const iso = date.toISOString(); // e.g. 2026-10-23T02:25:00.123Z
  const compact = iso.replace(/[-:]/g, '').split('.')[0] + 'Z';
  const hex = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `${compact}-${hex}`;
}
