/**
 * packages/cli/src/commands/tick.ts
 *
 * Implements `routersync tick` (Round C4a F1):
 *  - Single-instance file lock (`<stateDir>/tick.lock`)
 *  - Reads provider keys from connected router DB/config in RAM only (never written to disk)
 *  - Zero-token GET /models scan with ETag/hash + exponential backoff (2m -> 6h, factor 2)
 *  - Catalog diff with grace_cycles (default 2), shrink-guard, and QUOTA/TRANSIENT vs DEAD labels
 *  - Honors autonomy modes: observe | propose (default). `auto-safe` was removed in A8.
 *  - Writes status.json, appends 1 line to tick.log, and (in propose) updates inbox.json
 *  - Prints final accounting line: `TICK requests=<n> paid-requests=0 tokens=0 llm-calls=0`
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { acquireLock, releaseLock, readRouterCombos } from '@routersync/daemon';
import { locateRouterDb, openBetterSqlite3, readRouterModelState, getProviderAliases, type RouterModelState } from '@routersync/core';
import { loadConfigFile } from '../config/loader.js';
import { buildViews } from './sync/sync-plan.js';
import { fetchModelList, type ProviderTarget } from '../sync/providers.js';
import { evaluateAbsentStable } from '../verify/index.js';
import { runL2Scan } from '../verify/l2-scanner.js';
import { runL3Scan } from '../verify/l3-scanner.js';
import { loadRankingConfig } from '../rank/config.js';
import { isBlacklisted } from '../rank/filters.js';
import { providerHasSingleModelGet } from '../verify/gateways.js';

export type AutonomyMode = 'observe' | 'propose';

/**
 * C4n/N6: resolve the `--mode` value.
 *
 * An unknown value is refused with a clear message instead of silently
 * becoming 'propose' (which writes into inbox.json). `auto-safe` was removed
 * in A8 and is refused with a message that says so.
 */
export function resolveAutonomyMode(value: string | undefined): AutonomyMode {
  if (value === undefined || value === null || value === '') return 'propose';
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'observe') return 'observe';
  if (normalized === 'propose') return 'propose';
  if (normalized === 'auto-safe') {
    throw new Error(
      `Unknown --mode "${value}": "auto-safe" was removed in A8. Use "observe" (log only) or "propose" (also writes proposals into inbox.json).`
    );
  }
  throw new Error(
    `Unknown --mode "${value}". Valid modes: "observe" (log only) or "propose" (also writes proposals into inbox.json).`
  );
}

export function validateGraceCycles(value: unknown): number {
  if (value === undefined || value === null) return 2;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num) || num < 1) {
    throw new Error(`Invalid --grace-cycles "${value}": must be an integer >= 1`);
  }
  return num;
}

export function validateMaxShrinkRatio(value: unknown): number {
  if (value === undefined || value === null) return 0.3;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0 || num > 1) {
    throw new Error(`Invalid --max-shrink-ratio "${value}": must be a finite number in (0, 1]`);
  }
  return num;
}

export type ProviderHealthLabel =
  | 'OK'
  | 'UNCHANGED'
  | 'BACKOFF'
  | 'SKIPPED'
  | 'QUOTA'
  | 'TRANSIENT'
  | 'AUTH_ERROR'
  | 'SHRINK-GUARD-BLOCKED';

export interface ProviderCatalogEntry {
  prefix: string;
  router: string;
  contentHash?: string | undefined;
  serverEtag?: string | null | undefined;
  etag?: string | null | undefined;
  hash: string;
  ids: string[];
  absenceCounts: Record<string, number>;
  firstAbsentAt?: Record<string, string> | undefined;
  consecutiveFailures: number;
  backoffUntilMs: number;
  lastStatus: number;
  lastLabel: ProviderHealthLabel;
  skipReason?: string | undefined;
  updatedAt: string;
}

export interface TickCatalogState {
  version: 1;
  updatedAt: string;
  providers: Record<string, ProviderCatalogEntry>;
}

/**
 * K4.8: decide whether a model is confirmed present in the L1 catalog.
 *
 * A provider scan that failed with 401 or 5xx leaves the catalog STALE: the
 * model list was not confirmed in this cycle. The old list must therefore not
 * produce the label "confirmed alive" - the model stays unverified until a
 * scan succeeds. A 429 (quota) is a different case: the list was not refused
 * by the provider, only throttled, so the previous catalog stays valid.
 */
export function resolveCatalogPresence(
  providerEntry: ProviderCatalogEntry | undefined,
  modelId: string
): { l1Exists: boolean; absenceCount: number; scanFailed: boolean } {
  if (!providerEntry) {
    return { l1Exists: false, absenceCount: 1, scanFailed: false };
  }
  const scanFailed =
    providerEntry.lastStatus === 0 ||
    (providerEntry.lastStatus >= 400 && providerEntry.lastStatus !== 429);
  if (scanFailed) {
    return { l1Exists: false, absenceCount: 0, scanFailed: true };
  }
  const l1Exists = providerEntry.ids.includes(modelId);
  return {
    l1Exists,
    absenceCount: providerEntry.absenceCounts[modelId] ?? (l1Exists ? 0 : 1),
    scanFailed: false,
  };
}

export interface TickInboxItem {
  id: string;
  title: string;
  type: 'proposal' | 'warning' | 'info';
  timestamp: string;
  body: string;
  provider?: string | undefined;
  modelId?: string | undefined;
  modelIds?: string[] | undefined;
  action?: 'REMOVE_MODEL' | 'ENABLE_MODEL' | 'ADD_MODEL' | undefined;
  targetTier?: 'A' | 'B' | 'C' | 'UNKNOWN' | undefined;
  label?: string | undefined;
  status?: 'pending' | 'acknowledged' | 'snoozed' | undefined;
  snoozeUntil?: string | undefined;
  proposed_by: { kind: 'system'; source: 'tick' };
}

export interface TickCommandOptions {
  configPath?: string | undefined;
  mode?: AutonomyMode | string | undefined;
  graceCycles?: number | string | undefined;
  maxShrinkRatio?: number | string | undefined;
  minScanIntervalMs?: number | undefined;
  webhookUrl?: string | undefined;
  toast?: boolean | undefined;
  json?: boolean | undefined;
  stateDir?: string | undefined;
  nowMs?: number | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
  disabledModels?: Set<string> | undefined;
  routerState?: RouterModelState | undefined;
  routerStates?: Record<string, RouterModelState> | Map<string, RouterModelState> | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface TickRunSummary {
  timestamp: string;
  mode: AutonomyMode;
  effectiveMode: AutonomyMode;
  requests: number;
  paidRequests: 0;
  tokens: 0;
  llmCalls: 0;
  changedProviders: number;
  unchangedProviders: number;
  backoffSkipped: number;
  inboxAdded: number;
  providers: Array<{
    prefix: string;
    label: ProviderHealthLabel;
    status: number;
    models: number;
    changed: boolean;
    skipReason?: string | undefined;
    added: string[];
    graceAbsent: string[];
    deadConfirmed: string[];
    backoffSec: number;
  }>;
  // G2: shrink-block reasons per provider from evaluateAbsentStable
  shrinkBlockReasons?: Record<string, string[]>;
  /**
   * C4n/N6: models that went missing but are used by NO combo.
   *
   * They are reported here instead of becoming inbox proposals, because there
   * is nothing to remove from a combo.
   */
  absentNotInCombo?: Record<string, string[]>;
}

const BACKOFF_MIN_MS = 2 * 60 * 1000;       // 2m
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;  // 6h
const BACKOFF_FACTOR = 2;

export function resolveTickStateDir(customDir?: string): string {
  return customDir ?? process.env['ROUTERSYNC_STATE_DIR'] ?? path.join(os.homedir(), '.routersync');
}

export function computeBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const raw = BACKOFF_MIN_MS * Math.pow(BACKOFF_FACTOR, consecutiveFailures - 1);
  return Math.min(BACKOFF_MAX_MS, Math.floor(raw));
}

export function classifyFailureLabel(status: number, error?: string): ProviderHealthLabel {
  if (status === 429) return 'QUOTA';
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status === 408 || status >= 500 || status === 0 || (error && error.startsWith('network-'))) {
    return 'TRANSIENT';
  }
  return 'TRANSIENT';
}

function hashIds(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

export function loadCatalogState(filePath: string): TickCatalogState {
  if (!fs.existsSync(filePath)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), providers: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<TickCatalogState>;
    if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
      return {
        version: 1,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
        providers: parsed.providers as Record<string, ProviderCatalogEntry>,
      };
    }
  } catch {
    // Corrupted state file: start clean
  }
  return { version: 1, updatedAt: new Date(0).toISOString(), providers: {} };
}

export function loadInboxItems(filePath: string): TickInboxItem[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (Array.isArray(parsed)) return parsed as TickInboxItem[];
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown[] }).items)) {
      return (parsed as { items: TickInboxItem[] }).items;
    }
  } catch {
    // ignore
  }
  return [];
}

export function collectUsedComboSteps(): Set<string> {
  const used = new Set<string>();
  for (const r of ['9router', 'omniroute'] as const) {
    try {
      const res = readRouterCombos(r);
      if (res.ok && Array.isArray(res.data)) {
        for (const c of res.data) {
          for (const m of c.models) used.add(m);
        }
      }
    } catch {
      // ignore unreadable router DB
    }
  }
  return used;
}

export function loadAllRouterCombos(): Array<{ name: string; router: string; models: string[] }> {
  const list: Array<{ name: string; router: string; models: string[] }> = [];
  for (const r of ['9router', 'omniroute'] as const) {
    try {
      const res = readRouterCombos(r);
      if (res.ok && Array.isArray(res.data)) {
        for (const c of res.data) {
          list.push({ name: c.name, router: r, models: c.models });
        }
      }
    } catch {
      // ignore
    }
  }
  return list;
}

export function loadRouterDisabledModels(env?: NodeJS.ProcessEnv): Set<string> {
  const disabled = new Set<string>();
  // U3: OmniRoute does not store disabled models in kv (deprecated is metadata, not disabled).
  // Only 9Router has explicit user/router disabledModels kv scope.
  for (const r of ['9router'] as const) {
    try {
      const dbPath = locateRouterDb(r, env);
      if (dbPath && fs.existsSync(dbPath)) {
        const db = openBetterSqlite3(dbPath, { readOnly: true, busyTimeoutMs: 2000 });
        try {
          if (r === '9router') {
            const rows = db.prepare("SELECT key, value FROM kv WHERE scope = 'disabledModels'").all() as Array<{ key: string; value: string }>;
            for (const row of rows) {
              try {
                const arr = JSON.parse(row.value || '[]');
                if (Array.isArray(arr)) {
                  for (const m of arr) {
                    if (typeof m === 'string') {
                      const normId = m.startsWith('models/') ? m.slice('models/'.length) : m;
                      for (const alias of getProviderAliases(row.key)) {
                        disabled.add(`${alias}/${m}`);
                        disabled.add(`${alias}/${normId}`);
                      }
                    }
                  }
                }
              } catch {}
            }
          }
        } finally {
          db.close();
        }
      }
    } catch {
      // ignore unreadable router DB
    }
  }
  return disabled;
}

export function resolveModelTier(
  prefix: string,
  modelId: string,
  usedSteps: Set<string>,
  disabledModels: Set<string>,
  routerState?: RouterModelState
): 'A' | 'B' | 'C' | 'UNKNOWN' {
  const cleanProv = prefix.trim().toLowerCase();
  const normId = modelId.startsWith('models/') ? modelId.slice('models/'.length) : modelId;
  const aliases = getProviderAliases(cleanProv);

  for (const a of aliases) {
    if (disabledModels.has(`${a}/${modelId}`) || disabledModels.has(`${a}/${normId}`)) {
      return 'B';
    }
  }
  if (routerState) {
    const classification = routerState.classify(prefix, modelId);
    if (classification.inconsistent) {
      // Inconsistent models (e.g. in combo but not available in router UI) must NOT produce proposals
      return 'UNKNOWN';
    }
    return classification.tier;
  }
  for (const a of aliases) {
    if (usedSteps.has(`${a}/${modelId}`) || usedSteps.has(`${a}/${normId}`)) {
      return 'A';
    }
  }
  return 'C';
}

export async function runTickCommand(options: TickCommandOptions = {}): Promise<TickRunSummary> {
  // A8: Only observe and propose in v0.1 (auto-safe removed)
  // C4n/N6: an unknown --mode is REFUSED, not silently treated as 'propose'.
  // C4o/O5 & C4p/P3: Validate options at top of function before touching disk or acquiring lock.
  const requestedMode = resolveAutonomyMode(options.mode);
  const effectiveMode: AutonomyMode = requestedMode;
  const graceCycles = validateGraceCycles(options.graceCycles);
  const maxShrinkRatio = validateMaxShrinkRatio(options.maxShrinkRatio);

  const sDir = resolveTickStateDir(options.stateDir);
  if (!fs.existsSync(sDir)) fs.mkdirSync(sDir, { recursive: true });

  const lockPath = path.join(sDir, 'tick.lock');
  const lock = acquireLock(lockPath);
  if (!lock.acquired) {
    throw new Error(`Another tick instance (pid ${lock.pid}) already holds ${lockPath}`);
  }

  try {
    const nowMs = options.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // C4o/O1: loadConfigFile FIRST so configured router database paths are
    // installed before collectUsedComboSteps and loadAllRouterCombos read the
    // router databases. In a fresh process (e.g. scheduled tick run), this
    // ensures the combos are read from the configured database, not the default.
    const { config } = loadConfigFile(options.configPath);

    const catalogPath = path.join(sDir, 'tick-catalog.json');
    const statusPath = path.join(sDir, 'status.json');
    const tickLogPath = path.join(sDir, 'tick.log');
    const inboxPath = path.join(sDir, 'inbox.json');

    const catalogState = loadCatalogState(catalogPath);
    const usedSteps = collectUsedComboSteps();
    const allCombos = loadAllRouterCombos();
    const disabledModels = options.disabledModels ?? loadRouterDisabledModels(options.env);

    const routerStateByRouter = new Map<string, RouterModelState>();
    function getRouterStateFor(routerName: string): RouterModelState | undefined {
      if (options.routerStates instanceof Map) {
        if (options.routerStates.has(routerName)) return options.routerStates.get(routerName);
      } else if (options.routerStates && typeof options.routerStates === 'object') {
        const candidate = (options.routerStates as Record<string, RouterModelState>)[routerName];
        if (candidate) return candidate;
      }
      if (options.routerState) return options.routerState;

      const norm = routerName.toLowerCase();
      if (!routerStateByRouter.has(norm)) {
        try {
          const routerComboModels = new Set<string>();
          for (const c of allCombos) {
            if (c.router.toLowerCase() === norm) {
              for (const m of c.models) routerComboModels.add(m);
            }
          }
          routerStateByRouter.set(
            norm,
            readRouterModelState(norm, { comboModels: routerComboModels, env: options.env })
          );
        } catch {
          // ignore read failure
        }
      }
      return routerStateByRouter.get(norm);
    }

    // Load provider targets from connected routers (keys kept in RAM only)
    const views = await buildViews(config, 'all');
    const targets: Array<ProviderTarget & { router: string }> = [];
    const seen = new Set<string>();
    for (const view of views) {
      for (const t of view.targets) {
        if (seen.has(t.prefix)) continue;
        seen.add(t.prefix);
        targets.push({ ...t, router: view.name });
      }
    }

    let requests = 0;
    let changedProviders = 0;
    let unchangedProviders = 0;
    let backoffSkipped = 0;
    const providerSummaries: TickRunSummary['providers'] = [];
    const newInboxCandidates: TickInboxItem[] = [];
    // G3b: track real added IDs per provider for scoped isAdded checks
    const addedByPrefix = new Map<string, Set<string>>();
    // G2: persist evaluateAbsentStable shrink-block reasons per provider
    const shrinkBlockReasons = new Map<string, string[]>();
    // C4n/N6: models that went missing but are used by NO combo. They are
    // reported in status.json instead of becoming inbox proposals.
    const absentNotInCombo = new Map<string, string[]>();

    // G3a: load blacklist once for NEW-CANDIDATE filtering.
    // The tick never writes using the ranking policy, so it must not print the
    // "missing ranking.yaml" banner on every run.
    let blacklistPatterns: string[] = [];
    let blacklistEmptyLogged = false;
    try {
      const { config } = loadRankingConfig(undefined, { quiet: true });
      blacklistPatterns = config.blacklist ?? [];
    } catch {
      // If ranking config cannot be loaded, proceed with empty blacklist
      blacklistPatterns = [];
    }

    for (const t of targets) {
      const prev = catalogState.providers[t.prefix];

      if (t.skipReason || !t.baseUrl) {
        providerSummaries.push({
          prefix: t.prefix,
          label: 'SKIPPED',
          skipReason: t.skipReason ?? (t.baseUrl ? undefined : 'missing-base-url'),
          status: 0,
          models: prev?.ids.length ?? 0,
          changed: false,
          added: [],
          graceAbsent: [],
          deadConfirmed: [],
          backoffSec: 0,
        });
        continue;
      }

      if (prev && prev.backoffUntilMs > nowMs) {
        backoffSkipped++;
        const remSec = Math.ceil((prev.backoffUntilMs - nowMs) / 1000);
        providerSummaries.push({
          prefix: t.prefix,
          label: 'BACKOFF',
          status: prev.lastStatus,
          models: prev.ids.length,
          changed: false,
          skipReason: `BACKOFF_${remSec}s`,
          added: [],
          graceAbsent: [],
          deadConfirmed: [],
          backoffSec: remSec,
        });
        continue;
      }

      // ETag/hash cache freshness gate: skip redundant GET when hash was verified within minScanIntervalMs (default 15m)
      const minScanIntervalMs = options.minScanIntervalMs ?? 15 * 60 * 1000;
      const prevUpdatedMs = prev?.updatedAt ? Date.parse(prev.updatedAt) : 0;
      if (
        prev &&
        (prev.contentHash || prev.hash) &&
        prev.lastStatus === 200 &&
        Number.isFinite(prevUpdatedMs) &&
        nowMs - prevUpdatedMs >= 0 &&
        nowMs - prevUpdatedMs < minScanIntervalMs
      ) {
        unchangedProviders++;
        providerSummaries.push({
          prefix: t.prefix,
          label: 'UNCHANGED',
          status: prev.lastStatus,
          models: prev.ids.length,
          changed: false,
          skipReason: 'MIN_INTERVAL_SKIPPED',
          added: [],
          graceAbsent: [],
          deadConfirmed: [],
          backoffSec: 0,
        });
        continue;
      }

      requests += 1;
      const outcome = await fetchModelList(t, {
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        timeoutMs: 12_000,
        retryDelaysMs: [],
        serverEtag: prev?.serverEtag ?? null,
      });

      if (!outcome.ok || outcome.incomplete || outcome.truncated) {
        const isRedirectBlocked = Boolean(
          outcome.skipReason === 'redirect-blocked' ||
            (typeof outcome.error === 'string' && outcome.error.startsWith('redirect-blocked'))
        );
        const isIncomplete =
          !isRedirectBlocked &&
          Boolean(
            outcome.incomplete ||
              outcome.truncated ||
              outcome.skipReason === 'incomplete-pagination' ||
              outcome.error === 'incomplete-pagination'
          );
        const failLabel: ProviderHealthLabel =
          isIncomplete || isRedirectBlocked
            ? 'TRANSIENT'
            : classifyFailureLabel(outcome.status, outcome.error);
        const skipReason = isRedirectBlocked
          ? 'redirect-blocked'
          : isIncomplete
            ? 'incomplete-pagination'
            : failLabel;
        const failures = (prev?.consecutiveFailures ?? 0) + 1;
        const backoffMs = computeBackoffMs(failures);
        const backoffSec = Math.round(backoffMs / 1000);

        // A9: Alert in inbox for 401/403 AUTH_ERROR
        if (failLabel === 'AUTH_ERROR') {
          newInboxCandidates.push({
            id: `auth-error-${t.prefix}-${outcome.status}`,
            title: `[AUTH_ERROR] Provider ${t.prefix} trả về HTTP ${outcome.status}`,
            type: 'warning',
            timestamp: nowIso,
            body: `Provider ${t.prefix} xác thực thất bại (HTTP ${outcome.status}). Cần kiểm tra API key trong router.`,
            provider: t.prefix,
            label: 'AUTH_ERROR',
            proposed_by: { kind: 'system', source: 'tick' },
          });
        }

        catalogState.providers[t.prefix] = {
          prefix: t.prefix,
          router: t.router,
          contentHash: prev?.contentHash ?? prev?.hash ?? '',
          serverEtag: prev?.serverEtag ?? null,
          hash: prev?.hash ?? '',
          ids: prev?.ids ?? [],
          absenceCounts: prev?.absenceCounts ?? {},
          firstAbsentAt: prev?.firstAbsentAt,
          consecutiveFailures: failures,
          backoffUntilMs: nowMs + backoffMs,
          lastStatus: outcome.status,
          lastLabel: failLabel,
          skipReason,
          updatedAt: nowIso,
        };
        providerSummaries.push({
          prefix: t.prefix,
          label: failLabel,
          status: outcome.status,
          models: prev?.ids.length ?? 0,
          changed: false,
          skipReason,
          added: [],
          graceAbsent: [],
          deadConfirmed: [],
          backoffSec,
        });
        continue;
      }

      if (outcome.status === 304) {
        unchangedProviders++;
        catalogState.providers[t.prefix] = {
          ...prev!,
          skipReason: undefined,
          consecutiveFailures: 0,
          backoffUntilMs: 0,
          lastStatus: 304,
          lastLabel: 'UNCHANGED',
          updatedAt: nowIso,
        };
        providerSummaries.push({
          prefix: t.prefix,
          label: 'UNCHANGED',
          status: 304,
          models: prev!.ids.length,
          changed: false,
          skipReason: '304_NOT_MODIFIED',
          added: [],
          graceAbsent: [],
          deadConfirmed: [],
          backoffSec: 0,
        });
        continue;
      }

      const fetchedIds = [...new Set(outcome.models)].sort();
      const nextHash = hashIds(fetchedIds);

      // Unchanged hash & no pending absence cycles -> zero work
      if (prev && (prev.contentHash ?? prev.hash) === nextHash && Object.keys(prev.absenceCounts ?? {}).length === 0) {
        unchangedProviders++;
        catalogState.providers[t.prefix] = {
          ...prev,
          skipReason: undefined,
          contentHash: nextHash,
          serverEtag: outcome.serverEtag ?? prev.serverEtag ?? null,
          hash: nextHash,
          consecutiveFailures: 0,
          backoffUntilMs: 0,
          lastStatus: outcome.status,
          lastLabel: 'UNCHANGED',
          updatedAt: nowIso,
        };
        providerSummaries.push({
          prefix: t.prefix,
          label: 'UNCHANGED',
          status: outcome.status,
          models: prev.ids.length,
          changed: false,
          added: [],
          graceAbsent: [],
          deadConfirmed: [],
          backoffSec: 0,
        });
        continue;
      }

      // Shrink-guard check when baseline exists
      const prevIds = prev?.ids ?? [];
      if (prevIds.length >= 5) {
        const dropRatio = (prevIds.length - fetchedIds.length) / prevIds.length;
        if (dropRatio > maxShrinkRatio) {
          const warnId = `shrink-${t.prefix}-${nextHash}`;
          newInboxCandidates.push({
            id: warnId,
            title: `${t.prefix}: SHRINK-GUARD-BLOCKED (${prevIds.length} -> ${fetchedIds.length})`,
            type: 'warning',
            timestamp: nowIso,
            body: `Provider ${t.prefix} model list shrank by ${(dropRatio * 100).toFixed(1)}% (> ${(maxShrinkRatio * 100).toFixed(0)}%). Catalog preserved.`,
            provider: t.prefix,
            label: 'SHRINK-GUARD-BLOCKED',
            proposed_by: { kind: 'system', source: 'tick' },
          });
          catalogState.providers[t.prefix] = {
            prefix: t.prefix,
            router: t.router,
            contentHash: prev?.contentHash ?? prev?.hash ?? nextHash,
            serverEtag: prev?.serverEtag ?? null,
            hash: prev?.hash ?? nextHash,
            ids: prevIds,
            absenceCounts: prev?.absenceCounts ?? {},
            firstAbsentAt: prev?.firstAbsentAt,
            consecutiveFailures: 0,
            backoffUntilMs: 0,
            lastStatus: outcome.status,
            lastLabel: 'SHRINK-GUARD-BLOCKED',
            updatedAt: nowIso,
          };
          providerSummaries.push({
            prefix: t.prefix,
            label: 'SHRINK-GUARD-BLOCKED',
            status: outcome.status,
            models: prevIds.length,
            changed: false,
            added: [],
            graceAbsent: [],
            deadConfirmed: [],
            backoffSec: 0,
          });
          continue;
        }
      }

      const prevSet = new Set(prevIds);
      const nextSet = new Set(fetchedIds);
      const added = prevIds.length > 0 ? fetchedIds.filter((id) => !prevSet.has(id)) : [];
      addedByPrefix.set(t.prefix, new Set(added));
      const nextAbsence: Record<string, number> = {};
      const nextFirstAbsentAt: Record<string, string> = { ...(prev?.firstAbsentAt ?? {}) };
      const graceAbsent: string[] = [];
      const deadConfirmed: string[] = [];

      const candidatesToCheck = new Set<string>([
        ...prevIds,
        ...Object.keys(prev?.absenceCounts ?? {}),
      ]);

      for (const id of candidatesToCheck) {
        if (nextSet.has(id)) {
          delete nextFirstAbsentAt[id];
          continue;
        }
        const fullStep = `${t.prefix}/${id}`;
        const firstAbsentIso = nextFirstAbsentAt[id];
        const absentDurationMs = firstAbsentIso ? nowMs - Date.parse(firstAbsentIso) : 0;
        // B6: prune absent > 7 days if not in combos
        if (absentDurationMs > 7 * 24 * 3600 * 1000 && !usedSteps.has(fullStep)) {
          delete nextFirstAbsentAt[id];
          delete nextAbsence[id];
          continue;
        }

        if (!nextFirstAbsentAt[id]) {
          nextFirstAbsentAt[id] = nowIso;
        }
        const count = (prev?.absenceCounts?.[id] ?? 0) + 1;
        // A7: retain absenceCounts past graceCycles so absenceCount >= 3 is preserved for F4
        nextAbsence[id] = count;
        if (count < graceCycles) {
          graceAbsent.push(id);
        } else {
          deadConfirmed.push(id);
        }
      }

      const effectiveIds = [...new Set([...fetchedIds, ...graceAbsent])].sort();
      const didChange = !prev || (prev.contentHash ?? prev.hash) !== nextHash || deadConfirmed.length > 0 || added.length > 0;
      if (didChange) changedProviders++;
      else unchangedProviders++;

      catalogState.providers[t.prefix] = {
        prefix: t.prefix,
        router: t.router,
        contentHash: nextHash,
        serverEtag: outcome.serverEtag ?? null,
        hash: nextHash,
        ids: effectiveIds,
        absenceCounts: nextAbsence,
        firstAbsentAt: nextFirstAbsentAt,
        consecutiveFailures: 0,
        backoffUntilMs: 0,
        lastStatus: outcome.status,
        lastLabel: didChange ? 'OK' : 'UNCHANGED',
        updatedAt: nowIso,
      };

      // C4t: On first scan (prevIds empty), evaluate all fetchedIds as candidates against router state.
      // On subsequent scans, evaluate newly added IDs.
      const candidateModels = prevIds.length === 0 ? fetchedIds : added;

      if (candidateModels.length > 0) {
        // G3a: print BLACKLIST=none once when blacklist is empty
        if (blacklistPatterns.length === 0 && !blacklistEmptyLogged) {
          console.log('BLACKLIST=none');
          blacklistEmptyLogged = true;
        }

        // G3a: only ids that survive the blacklist become proposals, so the
        // summary item never mentions a blacklisted id.
        const allowedCandidates = candidateModels.filter(
          (candidateId) =>
            !isBlacklisted(candidateId, blacklistPatterns) &&
            !isBlacklisted(`${t.prefix}/${candidateId}`, blacklistPatterns)
        );

        const rState = getRouterStateFor(t.router);

        // Tier classification for additions (C4s / C4t):
        // - Tier A: skip (already active in router / in combo)
        // - UNKNOWN: skip (unverified router state)
        // - Tier B: propose ENABLE_MODEL
        // - Tier C: propose ADD_MODEL
        const tierCModels = allowedCandidates.filter(
          (id) => resolveModelTier(t.prefix, id, usedSteps, disabledModels, rState) === 'C'
        );
        const tierBModels = allowedCandidates.filter(
          (id) => resolveModelTier(t.prefix, id, usedSteps, disabledModels, rState) === 'B'
        );

        // Tier C: propose ADD_MODEL
        if (tierCModels.length > 0) {
          newInboxCandidates.push({
            id: `new-candidate-${t.prefix}-${nextHash}`,
            title: `${t.prefix}: ${tierCModels.length} NEW-CANDIDATE model(s)`,
            type: 'proposal',
            timestamp: nowIso,
            body: `Discovered new model(s) on ${t.prefix}: ${tierCModels.slice(0, 10).join(', ')}${tierCModels.length > 10 ? ` (+${tierCModels.length - 10} more)` : ''}`,
            provider: t.prefix,
            modelIds: tierCModels,
            action: 'ADD_MODEL',
            targetTier: 'A',
            label: 'NEW-CANDIDATE',
            proposed_by: { kind: 'system', source: 'tick' },
          });
        }

        // Tier B: propose ENABLE_MODEL
        if (tierBModels.length > 0) {
          newInboxCandidates.push({
            id: `enable-candidate-${t.prefix}-${nextHash}`,
            title: `${t.prefix}: ${tierBModels.length} ENABLE-CANDIDATE model(s) (Tier B)`,
            type: 'proposal',
            timestamp: nowIso,
            body: `Discovered model(s) on ${t.prefix} currently disabled in router: ${tierBModels.slice(0, 10).join(', ')}${tierBModels.length > 10 ? ` (+${tierBModels.length - 10} more)` : ''}`,
            provider: t.prefix,
            modelIds: tierBModels,
            action: 'ENABLE_MODEL',
            targetTier: 'A',
            label: 'ENABLE-CANDIDATE',
            proposed_by: { kind: 'system', source: 'tick' },
          });
        }

        // F5: Propose adding new or enabling models in matching combos (for delta additions when prevIds > 0)
        for (const addedId of (prevIds.length > 0 ? allowedCandidates : [])) {
          const tier = resolveModelTier(t.prefix, addedId, usedSteps, disabledModels, rState);
          if (tier === 'A' || tier === 'UNKNOWN') continue; // Skip Tier A and UNKNOWN

          const fullStep = `${t.prefix}/${addedId}`;
          const isTierB = tier === 'B';
          const action = isTierB ? 'ENABLE_MODEL' : 'ADD_MODEL';
          const label = isTierB ? 'ENABLE-CANDIDATE' : 'NEW-CANDIDATE';
          const idPrefix = isTierB ? 'enable-candidate-combo' : 'new-candidate-combo';

          for (const combo of allCombos) {
            const usesPrefix = combo.models.some((m) => m.startsWith(`${t.prefix}/`));
            if (usesPrefix && !combo.models.includes(fullStep)) {
              newInboxCandidates.push({
                id: `${idPrefix}-${combo.name}-${t.prefix}-${addedId}`,
                title: `[${label}] ${isTierB ? 'Kích hoạt' : 'Thêm'} ${fullStep} vào combo ${combo.name}`,
                type: 'proposal',
                timestamp: nowIso,
                body: `Model ${fullStep} (${isTierB ? 'Tier B' : 'Tier C'}) từ L1 scan; đề xuất ${action} cho combo ${combo.name} ở vị trí ${combo.models.length + 1}.`,
                provider: t.prefix,
                modelId: addedId,
                action,
                targetTier: 'A',
                label,
                proposed_by: { kind: 'system', source: 'tick' },
              });
            }
          }
        }
      }

      for (const deadId of deadConfirmed) {
        const fullStep = `${t.prefix}/${deadId}`;

        // C4s / C4t: Prevent REMOVE_MODEL on Tier C or UNKNOWN (unconfigured in router)
        const rState = getRouterStateFor(t.router);
        const deadTier = resolveModelTier(t.prefix, deadId, usedSteps, disabledModels, rState);
        if (deadTier === 'C' || deadTier === 'UNKNOWN') {
          const notInCombo = absentNotInCombo.get(t.prefix) ?? [];
          notInCombo.push(fullStep);
          absentNotInCombo.set(t.prefix, notInCombo);
          continue;
        }

        const count = nextAbsence[deadId] ?? ((prev?.absenceCounts?.[deadId] ?? 0) + 1);
        const firstAbsentMs = nextFirstAbsentAt[deadId] ? Date.parse(nextFirstAbsentAt[deadId]) : nowMs;

        // A7: Calculate real comboStepCount and dropCount for combos using this step
        const matchingCombos = allCombos.filter((c) => c.models.includes(fullStep));
        let comboStepCount = 1;
        let dropCount = 1;
        if (matchingCombos.length > 0) {
          const targetCombo = matchingCombos[0]!;
          comboStepCount = targetCombo.models.length;
          dropCount = targetCombo.models.filter((m) => {
            const [p, id] = m.split('/');
            if (p === t.prefix && id && deadConfirmed.includes(id)) return true;
            return false;
          }).length;
        }

        // F4: Gateway without single-model GET (read from registry/gateways.yaml)
        const isUnsupportedGateway = !providerHasSingleModelGet(t.prefix);
        if (isUnsupportedGateway) {
          const asCheck = evaluateAbsentStable({
            id: deadId,
            prefix: t.prefix,
            absenceCount: count,
            firstAbsentAtMs: firstAbsentMs,
            nowMs,
            lastLabel: 'ABSENT',
            l2ExternalExists: false,
            providerCoveredByExternal: false,
            comboStepCount,
            dropCount,
          });

          if (asCheck.isAbsentStable) {
            newInboxCandidates.push({
              id: `absent-stable-${t.prefix}-${deadId}`,
              title: `${fullStep}: ABSENT-STABLE (gateway không hỗ trợ GET đơn lẻ; vắng >= 3 chu kỳ & >= 24h)`,
              type: 'proposal',
              timestamp: nowIso,
              body: `Model ${fullStep} vắng mặt ${count} lần quét trải dài >= 24h, không tồn tại ở nguồn ngoài, đạt hạn mức co rút (${dropCount}/${comboStepCount}). Đề xuất gỡ bỏ an toàn.`,
              provider: t.prefix,
              modelId: deadId,
              action: 'REMOVE_MODEL',
              targetTier: 'B',
              label: 'ABSENT-STABLE',
              proposed_by: { kind: 'system', source: 'tick' },
            });
            continue;
          }
          // G2: persist evaluateAbsentStable shrink-block reasons for status.json/tick.log
          if (asCheck.reasons.length > 0) {
            const existing = shrinkBlockReasons.get(t.prefix) ?? [];
            existing.push(`${deadId}: ${asCheck.reasons.join('; ')}`);
            shrinkBlockReasons.set(t.prefix, existing);
          }
        }

        // C4n/N6: only a step that is actually USED in a combo becomes an
        // inbox proposal.
        //
        // The old condition was `usedSteps.has(fullStep) || prevIds.includes(deadId)`.
        // `deadConfirmed` is built from `prevIds`, so the second half was always
        // true and every model that went missing produced a proposal — even
        // models no combo uses. Those are now recorded in status.json
        // (`absentNotInCombo`) instead of filling the owner's inbox.
        if (usedSteps.has(fullStep)) {
          // B6: prune hash from absent-unconfirmed-... inbox IDs
          newInboxCandidates.push({
            id: `absent-unconfirmed-${t.prefix}-${deadId}`,
            title: `${fullStep}: ABSENT-UNCONFIRMED (vắng >= ${graceCycles} chu kỳ, chưa có GET đơn lẻ)`,
            type: 'proposal',
            timestamp: nowIso,
            body: `Model ${fullStep} vắng mặt trong ${count} chu kỳ quét L1; cần xác minh thêm trước khi gỡ.`,
            provider: t.prefix,
            modelId: deadId,
            action: 'REMOVE_MODEL',
            targetTier: 'B',
            label: 'ABSENT-UNCONFIRMED',
            proposed_by: { kind: 'system', source: 'tick' },
          });
        } else {
          // Missing but referenced by no combo: nothing to remove, so no
          // proposal. It is still reported so the owner can see it.
          const notInCombo = absentNotInCombo.get(t.prefix) ?? [];
          notInCombo.push(fullStep);
          absentNotInCombo.set(t.prefix, notInCombo);
        }
      }

      providerSummaries.push({
        prefix: t.prefix,
        label: didChange ? 'OK' : 'UNCHANGED',
        status: outcome.status,
        models: effectiveIds.length,
        changed: didChange,
        added,
        graceAbsent,
        deadConfirmed,
        backoffSec: 0,
      });
    }

    catalogState.updatedAt = nowIso;
    fs.writeFileSync(catalogPath, JSON.stringify(catalogState, null, 2), 'utf8');

    // A3: Run L2 (1h TTL) and L3 (24h TTL) scans and aggregate requests into unified accounting
    const l2Res = await runL2Scan({ stateDir: sDir, nowMs, fetchFn: options.fetchFn });
    const l3Res = await runL3Scan({ stateDir: sDir, nowMs, fetchFn: options.fetchFn });
    let totalRequests = requests + l2Res.requests + l3Res.requests;

    // B2: Execute verify phase at cycle end without additional network requests, persist verify-status.json
    try {
      const { runVerifyPhase } = await import('../verify/verifier.js');
      const targetSteps = new Set<string>();
      for (const c of allCombos) {
        for (const m of c.models) targetSteps.add(m);
      }
      const realModels: Array<{
        id: string;
        prefix: string;
        l1Exists?: boolean | undefined;
        l1Status?: number | undefined;
        absenceCount?: number | undefined;
        firstAbsentAtMs?: number | undefined;
        lastSeenAt?: string | undefined;
        isAdded?: boolean | undefined;
        isUnscanned?: boolean | undefined;
        unscannedReason?: string | undefined;
      }> = [];

      for (const step of targetSteps) {
        const slashIdx = step.indexOf('/');
        const prefix = slashIdx !== -1 ? step.slice(0, slashIdx) : 'unknown';
        const id = slashIdx !== -1 ? step.slice(slashIdx + 1) : step;
        const provEntry = catalogState.providers[prefix];
        const isUnscanned = !provEntry || Boolean(provEntry.skipReason);
        const unscannedReason = provEntry?.skipReason ?? (!provEntry ? 'chưa-quét' : undefined);
        const presence = resolveCatalogPresence(provEntry, id);
        const l1Exists = presence.l1Exists;
        const l1Status = provEntry ? provEntry.lastStatus : (isUnscanned ? 0 : (l1Exists ? 200 : 404));
        const absenceCount = presence.absenceCount;
        const firstAbsentAt = provEntry?.firstAbsentAt?.[id];
        const firstAbsentAtMs = firstAbsentAt ? Date.parse(firstAbsentAt) : undefined;
        const isAdded = addedByPrefix.get(prefix)?.has(id) ?? false;

        realModels.push({
          id,
          prefix,
          l1Exists,
          l1Status,
          absenceCount,
          firstAbsentAtMs,
          lastSeenAt: provEntry?.updatedAt,
          isAdded,
          isUnscanned,
          unscannedReason,
        });
      }

      const verifySummary = await runVerifyPhase({
        stateDir: sDir,
        nowMs,
        models: realModels,
        combos: allCombos,
        fetchFn: options.fetchFn,
        silent: true,
      });
      totalRequests += verifySummary.accounting?.requests ?? 0;

      // Alert inbox by provider/model/nhãn for actionable items (E8)
      const alertLabels = new Set(['NGHI-NGỪNG', 'SẮP-NGỪNG', 'ĐÃ-XÁC-NHẬN-NGỪNG', 'CHƯA-XÁC-MINH']);
      for (const rec of verifySummary.records) {
        const isActionable =
          rec.label === 'ĐÃ-XÁC-NHẬN-NGỪNG' ||
          rec.label === 'SẮP-NGỪNG' ||
          ((rec.label === 'NGHI-NGỪNG' || rec.label === 'CHƯA-XÁC-MINH') && !rec.unscannedReason && (rec.l1.absenceCount ?? 0) >= 2);

        if (alertLabels.has(rec.label) && isActionable) {
          newInboxCandidates.push({
            id: `${rec.prefix}/${rec.id}/${rec.label}`,
            title: `[${rec.label}] ${rec.prefix}/${rec.id}`,
            type: 'warning',
            timestamp: nowIso,
            body: `Model ${rec.prefix}/${rec.id} được gắn nhãn ${rec.label}. Cần chú ý khi định tuyến.`,
            provider: rec.prefix,
            label: rec.label,
            proposed_by: { kind: 'system', source: 'tick' },
          });
        }
      }
    } catch {
      // Non-fatal verify phase error
    }

    let inboxAdded = 0;
    if (effectiveMode === 'propose') {
      const existingInbox = loadInboxItems(inboxPath);
      const existingIds = new Set(existingInbox.map((i) => i.id));
      for (const item of newInboxCandidates) {
        if (!existingIds.has(item.id)) {
          existingInbox.unshift(item);
          existingIds.add(item.id);
          inboxAdded++;
        }
      }
      if (inboxAdded > 0 || !fs.existsSync(inboxPath) || existingInbox.length > 200) {
        // G3d: keep unacknowledged and active-snoozed items; only trim oldest
        // acknowledged/expired-snoozed.
        //
        // C4n/N8: a snoozed item whose snooze has EXPIRED is handled, not
        // active. The old code fell through to `return true` for an expired
        // snooze, so expired items were never trimmed.
        const nowMsTick = nowMs;
        const isActive = (item: TickInboxItem) => {
          const st = item.status;
          if (st === 'acknowledged') return false;
          if (st === 'snoozed') {
            const snoozeMs = item.snoozeUntil ? Date.parse(item.snoozeUntil) : Number.NaN;
            // No snoozeUntil, or a snooze in the future: still active.
            return !Number.isFinite(snoozeMs) || snoozeMs > nowMsTick;
          }
          return true;
        };
        const activeItems = existingInbox.filter(isActive);
        const handledItems = existingInbox.filter((item) => !isActive(item));
        const itemsToWrite = [...activeItems];
        const remaining = 200 - itemsToWrite.length;
        if (remaining > 0) {
          itemsToWrite.push(...handledItems.slice(0, remaining));
        }
        fs.writeFileSync(inboxPath, JSON.stringify({ updatedAt: nowIso, items: itemsToWrite }, null, 2), 'utf8');
      }
    }

    const summary: TickRunSummary = {
      timestamp: nowIso,
      mode: requestedMode,
      effectiveMode,
      requests: totalRequests,
      paidRequests: 0,
      tokens: 0,
      llmCalls: 0,
      changedProviders,
      unchangedProviders,
      backoffSkipped,
      inboxAdded,
      providers: providerSummaries,
      // G2: persist evaluateAbsentStable shrink-block reasons
      shrinkBlockReasons: Object.fromEntries(shrinkBlockReasons),
      // C4n/N6: missing models that no combo uses (reported, not proposed)
      absentNotInCombo: Object.fromEntries(absentNotInCombo),
    };

    fs.writeFileSync(statusPath, JSON.stringify(summary, null, 2), 'utf8');

    const logLine = `${nowIso} mode=${effectiveMode} requests=${totalRequests} changed=${changedProviders} unchanged=${unchangedProviders} backoff=${backoffSkipped} inbox_added=${inboxAdded} paid-requests=0 tokens=0 llm-calls=0 shrink_blocks=${JSON.stringify(Object.fromEntries(shrinkBlockReasons))}\n`;
    fs.appendFileSync(tickLogPath, logLine, 'utf8');

    const webhook = options.webhookUrl ?? process.env['ROUTERSYNC_WEBHOOK_URL'];
    if (webhook && inboxAdded > 0) {
      try {
        await (options.fetchFn ?? globalThis.fetch)(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: nowIso, inboxAdded, changedProviders }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Non-fatal webhook failure
      }
    }

    if (options.toast && inboxAdded > 0 && !options.json) {
      console.log(`[routersync toast] ${inboxAdded} đề xuất mới trong inbox.`);
    }

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const scannedCount = providerSummaries.filter((p) => p.label !== 'SKIPPED').length;
      const skippedCount = providerSummaries.filter((p) => p.label === 'SKIPPED').length;
      console.log(
        `TICK-SUMMARY mode=${effectiveMode} scanned=${scannedCount} skipped=${skippedCount} changed=${changedProviders} unchanged=${unchangedProviders} backoff=${backoffSkipped} inbox_added=${inboxAdded}`
      );
      for (const p of providerSummaries) {
        console.log(
          `  PROVIDER prefix=${p.prefix} label=${p.label} status=${p.status} models=${p.models} changed=${p.changed ? 'yes' : 'no'}${p.skipReason ? ` reason=${p.skipReason}` : ''} added=${p.added.length} grace=${p.graceAbsent.length} dead=${p.deadConfirmed.length}${p.backoffSec > 0 ? ` backoff=${p.backoffSec}s` : ''}`
        );
      }
    }
    console.log(`TICK requests=${totalRequests} paid-requests=0 tokens=0 llm-calls=0`);
    return summary;
  } finally {
    releaseLock(lockPath);
  }
}
