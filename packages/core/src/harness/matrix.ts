/**
 * packages/core/src/harness/matrix.ts
 *
 * Canonical C45-WP1 Harness Capability Matrix loader & typed query helpers
 * (Phục vụ: S2, S3, S6).
 *
 * Works identically in:
 *  - Monorepo Vitest / tsx (`src/harness/harness-matrix.json`)
 *  - Compiled package / offline npm tarball install (`dist/harness/harness-matrix.json`)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type HarnessEvidenceTier = 'A' | 'B' | 'C';

export type HarnessId =
  | 'hermes'
  | 'claude-code'
  | 'codex'
  | 'antigravity'
  | 'opencode'
  | 'cursor'
  | 'grok-bot'
  | 'openmausbot'
  | 'dsh';

export type MatrixDirectionAMode = 'write-adapter' | 'report-only' | 'CHƯA-XÁC-MINH';

export interface HarnessOsPaths {
  win32: string[];
  darwin: string[];
  linux: string[];
}

export interface HarnessMcpCapability {
  supported: boolean;
  format: 'yaml' | 'json' | 'jsonc' | 'toml' | 'unsupported';
  paths: HarnessOsPaths;
  legacyPaths?: string[];
  envOverride?: string;
  projectPaths: string[];
  topLevelKey: string | null;
  entrySchema: Record<string, unknown>;
  nativeInstallCommand: string | null;
  routersyncInstallStrategy: string;
  notes: string;
}

export interface HarnessSchedulerCapability {
  hasNativeScheduler: boolean;
  schedulerType: string;
  zeroTokenScriptCapable: boolean;
  configPaths: HarnessOsPaths;
  scriptsDir?: string;
  nativeCommand?: string;
  jobRecordFields?: Record<string, unknown>;
  fallbackStrategy: string;
  notes: string;
}

export interface HarnessModelsConfigCapability {
  format: 'yaml' | 'json' | 'jsonc' | 'toml' | 'ui-only';
  paths: HarnessOsPaths;
  credentialsPath?: string;
  providerModelPath: string | null;
  userEditableOnDisk: boolean;
  defaultModelSlotsToPreserve: string[];
  editSafetyNotes: string;
}

export interface HarnessReloadCapability {
  mcp: boolean;
  models: boolean;
  mechanism: string;
}

export interface HarnessSourceRef {
  kind: 'host-observation' | 'official-doc';
  ref: string;
  date: string;
}

export interface HarnessCompanionCli {
  id: string;
  displayName: string;
  tier: HarnessEvidenceTier;
  mcpFormat: 'yaml' | 'json' | 'jsonc' | 'toml';
  mcpPaths: HarnessOsPaths;
  envOverride?: string;
  topLevelKey: string;
  nativeInstallCommand?: string | null;
  hasNativeScheduler: boolean;
  zeroTokenScriptCapable: boolean;
  modelsConfigPath?: string;
  notes: string;
}

export interface HarnessCapability {
  id: HarnessId;
  displayName: string;
  tier: HarnessEvidenceTier;
  mcp: HarnessMcpCapability;
  scheduler: HarnessSchedulerCapability;
  modelsConfig: HarnessModelsConfigCapability;
  directionAMode: MatrixDirectionAMode;
  shellCapable: boolean;
  reloadRequired: HarnessReloadCapability;
  processNames: HarnessOsPaths;
  companionCli?: HarnessCompanionCli;
  sources: HarnessSourceRef[];
}

export interface HarnessMatrix {
  version: number;
  schemaVersion: string;
  generatedAt: string;
  serves: string[];
  evidenceTiers: Record<HarnessEvidenceTier, string>;
  harnesses: HarnessCapability[];
}

let cachedMatrix: HarnessMatrix | undefined;

function resolveHarnessMatrixJsonPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'harness-matrix.json'),
    path.resolve(here, '..', '..', 'src', 'harness', 'harness-matrix.json'),
    path.resolve(here, '..', '..', '..', '..', 'harness-matrix.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Cannot locate canonical harness-matrix.json in @routersync/core.');
}

/**
 * Loads the canonical WP1 9-harness capability matrix.
 */
export function loadHarnessMatrix(): HarnessMatrix {
  if (cachedMatrix) {
    return cachedMatrix;
  }
  const filePath = resolveHarnessMatrixJsonPath();
  const raw = fs.readFileSync(filePath, 'utf8');
  cachedMatrix = JSON.parse(raw) as HarnessMatrix;
  return cachedMatrix;
}

/**
 * Lists all harness capabilities in canonical matrix order.
 */
export function listHarnessCapabilities(): HarnessCapability[] {
  return [...loadHarnessMatrix().harnesses];
}

/**
 * Looks up a single harness capability record by id (case-insensitive trimmed).
 */
export function getHarnessCapability(id: string): HarnessCapability | undefined {
  const normalized = id.trim().toLowerCase();
  return loadHarnessMatrix().harnesses.find((entry) => entry.id === normalized);
}

/**
 * Expands a matrix path pattern (`~/...`, `%LOCALAPPDATA%/...`, `%APPDATA%/...`)
 * for a given OS/homeDir/env without touching the disk.
 */
export function expandHarnessPathPattern(
  pattern: string,
  options: {
    homeDir?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    env?: NodeJS.ProcessEnv | undefined;
  } = {}
): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env['HOME'] ?? env['USERPROFILE'] ?? os.homedir();
  const localAppData = env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
  const roamingAppData = env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');

  let expanded = pattern
    .replace(/^%LOCALAPPDATA%[\\/]/i, `${localAppData}${path.sep}`)
    .replace(/^%APPDATA%[\\/]/i, `${roamingAppData}${path.sep}`);

  if (expanded === '~') {
    expanded = home;
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(home, expanded.slice(2));
  }

  return path.normalize(expanded);
}