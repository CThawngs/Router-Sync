/**
 * packages/mcp-server/src/state.ts
 *
 * Read-only access to RouterSync state files.
 *
 * Every helper returns a discriminated result instead of throwing, so a tool
 * can report "missing" or "corrupt" as data. A tool must never invent a value
 * when its source file is absent: that is what made the old surface claim
 * health it had never measured.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getConfigDir } from '@routersync/core';

export interface TickProviderSnapshot {
  prefix: string;
  router: string;
  contentHash?: string;
  serverEtag?: string | null;
  hash?: string;
  ids: string[];
}

export interface TickCatalogFile {
  version: number;
  updatedAt: string;
  providers: Record<string, TickProviderSnapshot>;
}

export interface InboxItem {
  id?: string;
  title?: string;
  type?: string;
  timestamp?: string;
  body?: string;
  status?: string;
  snoozeUntil?: string;
  provider?: string;
  label?: string;
  proposed_by?: { kind?: string; source?: string };
  [key: string]: unknown;
}

export interface InboxFile {
  updatedAt?: string;
  items?: InboxItem[];
}

export interface VerifyRecord {
  id: string;
  prefix: string;
  fullStep?: string;
  label: string;
  l1?: { exists?: boolean; status?: number; absenceCount?: number; lastSeenAt?: string };
  l2?: { exists?: boolean; price?: number | null; source?: string; url?: string };
  l3?: { hasNotice?: boolean; url?: string; noticeType?: string; date?: string | null };
  flags?: string[];
  verifiedAt?: string;
}

export interface VerifyStatusFile {
  timestamp?: string;
  modelsVerified?: number;
  labels?: Record<string, number>;
  records?: VerifyRecord[];
  proposals?: unknown[];
  absentStableCandidates?: unknown[];
  accounting?: { requests?: number; paidRequests?: number; tokens?: number; llmCalls?: number };
}

export interface TickStatusFile {
  timestamp?: string;
  mode?: string;
  effectiveMode?: string;
  requests?: number;
  paidRequests?: number;
  tokens?: number;
  llmCalls?: number;
  changedProviders?: number;
  unchangedProviders?: number;
  backoffSkipped?: number;
  inboxAdded?: number;
  providers?: Array<{
    prefix: string;
    label: string;
    status: number;
    models: number;
    skipReason?: string;
    changed?: boolean;
    backoffSec?: number;
  }>;
}

export interface AutopilotPlanFile {
  generatedAt?: string;
  planHash?: string;
  blocked?: boolean;
  [key: string]: unknown;
}

export type JsonReadResult<T> =
  | { ok: true; value: T; filePath: string; bytes: number }
  | { ok: false; filePath: string; reason: 'MISSING' | 'INVALID_JSON' | 'UNREADABLE'; detail?: string };

export interface FileStat {
  path: string;
  exists: boolean;
  bytes?: number;
  modifiedAt?: string;
}

/**
 * Mirrors `resolveTickStateDir` in packages/cli/src/commands/tick.ts so the
 * MCP surface reads exactly the directory the daemon writes.
 */
export function resolveMcpStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['ROUTERSYNC_STATE_DIR'];
  if (override && override.trim().length > 0) return path.resolve(override.trim());
  return path.join(os.homedir(), '.routersync');
}

/**
 * Mirrors `stateDir()` in packages/cli/src/commands/autopilot.ts, which writes
 * plans under <LOCALAPPDATA>/routersync/state/plans.
 */
export function resolvePlansDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'routersync', 'state', 'plans');
}

export interface StatePaths {
  stateDir: string;
  configDir: string;
  plansDir: string;
  inbox: string;
  verifyStatus: string;
  tickCatalog: string;
  tickStatus: string;
  tickLog: string;
  l2Cache: string;
  l3Cache: string;
  profile: string;
  autopilotPolicy: string;
}

export function resolveStatePaths(env: NodeJS.ProcessEnv = process.env): StatePaths {
  const stateDir = resolveMcpStateDir(env);
  const configDir = getConfigDir(env);
  return {
    stateDir,
    configDir,
    plansDir: resolvePlansDir(env),
    inbox: path.join(stateDir, 'inbox.json'),
    verifyStatus: path.join(stateDir, 'verify-status.json'),
    tickCatalog: path.join(stateDir, 'tick-catalog.json'),
    tickStatus: path.join(stateDir, 'status.json'),
    tickLog: path.join(stateDir, 'tick.log'),
    l2Cache: path.join(stateDir, 'l2-cache.json'),
    l3Cache: path.join(stateDir, 'l3-cache.json'),
    profile: path.join(configDir, 'profile.yaml'),
    autopilotPolicy: path.join(configDir, 'autopilot.yaml'),
  };
}

export function readJsonFile<T>(filePath: string): JsonReadResult<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, filePath, reason: 'MISSING' };
    return {
      ok: false,
      filePath,
      reason: 'UNREADABLE',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    return { ok: true, value: JSON.parse(raw) as T, filePath, bytes: raw.length };
  } catch (error) {
    return {
      ok: false,
      filePath,
      reason: 'INVALID_JSON',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function statFile(filePath: string): FileStat {
  try {
    const stats = fs.statSync(filePath);
    return { path: filePath, exists: true, bytes: stats.size, modifiedAt: stats.mtime.toISOString() };
  } catch {
    return { path: filePath, exists: false };
  }
}

export function describeReadFailure(result: { filePath: string; reason: string; detail?: string }): {
  path: string;
  reason: string;
  detail?: string;
} {
  return result.detail === undefined
    ? { path: result.filePath, reason: result.reason }
    : { path: result.filePath, reason: result.reason, detail: result.detail };
}

export function ageMinutes(isoTimestamp: string | undefined, nowMs = Date.now()): number | null {
  if (!isoTimestamp) return null;
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.round((nowMs - parsed) / 60000);
}

/** Strips a provider prefix so a catalog id can be compared with a scan id. */
export function providerRestId(id: string, prefix: string): string {
  const withSlash = `${prefix}/`;
  return id.startsWith(withSlash) ? id.slice(withSlash.length) : id;
}

export interface IdDiff {
  added: string[];
  lost: string[];
}

/** added = present now but not in the scan, lost = in the scan but absent now. */
export function diffIds(scannedIds: string[], currentIds: string[]): IdDiff {
  const scanned = new Set(scannedIds);
  const current = new Set(currentIds);
  const added = [...current].filter((id) => !scanned.has(id)).sort();
  const lost = [...scanned].filter((id) => !current.has(id)).sort();
  return { added, lost };
}

export function latestFileIn(dirPath: string, suffix: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return null;
  }
  const matches = entries
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(dirPath, name))
    .map((filePath) => ({ filePath, mtimeMs: statFile(filePath).modifiedAt ?? '' }))
    .sort((a, b) => (a.mtimeMs < b.mtimeMs ? 1 : -1));
  return matches[0]?.filePath ?? null;
}
