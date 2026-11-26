/**
 * packages/cli/src/commands/tick.ts
 *
 * Implements `routersync tick` (Round C4a F1 + C45-WP3 Real-time Research Loop):
 *  - Single-instance file lock (`<stateDir>/tick.lock`)
 *  - Reads provider keys from connected router DB/config in RAM only (never written to disk)
 *  - Zero-token GET /models scan with ETag/hash + exponential backoff (2m -> 6h, factor 2)
 *  - Consumes <stateDir>/research-evidence.json (official vs secondary source tiers)
 *  - Multi-target comparison across router combos + keyed AI coding harnesses (WP1+WP2)
 *  - Emits <plansDir>/tick-plan.json and 4-trigger <stateDir>/research-queue.json
 *  - Enforces 10% per-cycle removal shrink cap (`TARGET_REMOVAL_MAX_SHRINK_RATIO = 0.10`)
 *    and `UNVERIFIABLE != ABSENT` invariant
 *  - Records `detectionLatencyMs` across tick-plan.json, status.json, and tick.log
 *  - Prints final accounting line: `TICK requests=<n> paid-requests=0 tokens=0 llm-calls=0`
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readRouterCombos } from '@routersync/daemon';
import {
  activateFreeze,
  appendApplyReceipt,
  readApplyHistory,
  COMPLETED_DETECTION_RETENTION_MS,
  MAX_DETECTION_RECORDS,
  deriveRemovalSettlementMs,
  parseRemovalEvidenceTimestamp,
  appendTickCostEntry,
  assertAllowedOutboundUrl,
  createAccountingFetch,
  releaseTickLock,
  tryAcquireTickLock,
  applyPlanSafe,
  assertControlledWriteSandbox,
  assertEligibleForAutoSafe,
  atomicWriteFileSync,
  canonicalizeResearchProvider,
  computeCanonicalTickPlanHash,
  planCombos,
  readFreezeState,
  readStandingConsent,
  sanitizeUntrustedString,
  saveSnapshot,
  validateInvariants,
  type ModelInfo,
  getProviderAliases,
  isPathInsideDir,
  loadHarnessMatrix,
  loadResearchEvidence,
  researchEvidenceIdentity,
  loadResearchQueue,
  locateRouterDb,
  openBetterSqlite3,
  readRouterModelState,
  saveResearchEvidence,
  saveResearchQueue,
  sendActionableWebhook,
  verifyProviderSourceDomain,
  type ActionableWebhookAlert,
  type RemovedModelReceiptEvidence,
  type ResearchEvidenceRecord,
  type ResearchQueueFile,
  type ResearchQueueItem,
  type ResearchQueueReason,
  type RouterModelState,
  type WebhookDeliveryResult,
} from '@routersync/core';
import type { ComboDefinition, Plan } from '@routersync/adapter-sdk';
import { loadConfigFile, resolveConfigFilePath, resolveRouterDbPath } from '../config/loader.js';
import { createAdapterForRouter } from '../adapters.js';
import {
  HARNESS_WRITE_ADAPTERS,
  inspectTierAHarnessForTick,
  resolveEffectiveHarnessHomeDir,
} from '../apps/write-adapter.js';
import { buildViews } from './sync/sync-plan.js';
import { fetchModelList, type ProviderTarget } from '../sync/providers.js';
import {
  computeDetectionLatencyMs,
  enforceTargetShrinkCap,
  evaluateAbsentStable,
  isUnverifiableScanState,
  summarizeDetectionLatencies,
  type DetectionLatencySummary,
  type ModelVerificationRecord,
} from '../verify/index.js';
import { runL2Scan, PROVIDER_ALIASES } from '../verify/l2-scanner.js';
import { runL3Scan } from '../verify/l3-scanner.js';
import { loadRankingConfig } from '../rank/config.js';
import { isBlacklisted } from '../rank/filters.js';
import { isLowResource, applyLowResourcePriority } from '../low-resource.js';
import { providerHasSingleModelGet } from '../verify/gateways.js';
import { AGENT_APP_ADAPTERS } from '../apps/inspect.js';

export type AutonomyMode = 'observe' | 'propose' | 'auto-safe';
export type EffectiveTickMode = AutonomyMode | 'FROZEN';

export function resolveAutonomyMode(
  value: string | undefined,
  opts?: { allowAutoSafe?: boolean | undefined }
): AutonomyMode {
  if (value === undefined || value === null || value === '') return 'propose';
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'observe') return 'observe';
  if (normalized === 'propose') return 'propose';
  if (normalized === 'auto-safe') {
    if (opts?.allowAutoSafe) return 'auto-safe';
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

interface DetectionLifecycle {
  removedAt?: string | undefined;
  recoveredAt?: string | undefined;
  withdrawnAt?: string | undefined;
  supersededAt?: string | undefined;
  abandonedAt?: string | undefined;
}
export interface ModelPendingRecord extends DetectionLifecycle {
  episodeId: string;
  provider: string;
  modelId: string;
  fullStep: string;
  status: 'model_pending';
  scanStartedAt: string;
  modelPendingAt: string;
  detectionMs: number;
  targetsAffected: string[];
}

export interface OfficialNoticeDetectionRecord extends DetectionLifecycle {
  recordKey: string;
  provider: string;
  modelId: string;
  fullStep: string;
  evidenceId: string;
  previousEvidenceIds?: string[] | undefined;
  previousRecordKeys?: string[] | undefined;
  sourcePublishedAt: string | null;
  firstQualifyingScanStartedAt: string;
  episodeStartedAt?: string | undefined;
  firstPlanCreatedAt: string | null;
  publicationToPlanMs: number | null;
  detectionMs: number | null;
  synthetic: boolean;
  targetsAffected: string[];
}

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
  firstSeenAt?: Record<string, string> | undefined;
  pendingEpisodes?: Record<string, string> | undefined;
  qualifyingScanTimestamps?: string[] | undefined;
  activeTargets?: string[] | undefined;
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
  absenceDetections?: ModelPendingRecord[] | undefined;
  officialNoticeDetections?: OfficialNoticeDetectionRecord[] | undefined;
  routerTargetAliases?: Record<string, string[]> | undefined;
  detectionHistoryError?: 'DETECTION_HISTORY_CAP_EXCEEDED' | undefined;
}

/**
 * K4.8 + C45-WP3 (§4.3 UNVERIFIABLE != ABSENT):
 * Decide whether a model is confirmed present in the L1 catalog.
 * Unscanned, skipped, 401/403, or 5xx providers NEVER fabricate absenceCount > 0.
 * Models in grace-period absence (`absenceCounts[modelId] > 0`) report `l1Exists: false`
 * with their recorded `absenceCount`.
 */
export function resolveCatalogPresence(
  providerEntry: ProviderCatalogEntry | undefined,
  modelId: string
): { l1Exists: boolean; absenceCount: number; scanFailed: boolean } {
  if (!providerEntry) {
    return { l1Exists: false, absenceCount: 0, scanFailed: true };
  }
  if (providerEntry.lastStatus === 429) {
    const recordedAbsence = providerEntry.absenceCounts[modelId] ?? 0;
    const l1Exists = recordedAbsence === 0 && providerEntry.ids.includes(modelId);
    return {
      l1Exists,
      absenceCount: recordedAbsence,
      scanFailed: !l1Exists && providerEntry.ids.length === 0,
    };
  }
  const scanFailed =
    providerEntry.lastStatus === 0 ||
    Boolean(
      providerEntry.skipReason &&
        providerEntry.skipReason !== 'MIN_INTERVAL_SKIPPED' &&
        providerEntry.skipReason !== '304_NOT_MODIFIED'
    ) ||
    providerEntry.lastLabel === 'SHRINK-GUARD-BLOCKED' ||
    (providerEntry.lastStatus >= 400 && providerEntry.lastStatus !== 429);
  if (scanFailed) {
    return { l1Exists: false, absenceCount: 0, scanFailed: true };
  }
  const recordedAbsence = providerEntry.absenceCounts[modelId] ?? 0;
  const l1Exists = recordedAbsence === 0 && providerEntry.ids.includes(modelId);
  return {
    l1Exists,
    absenceCount: recordedAbsence > 0 ? recordedAbsence : l1Exists ? 0 : 1,
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

export interface HarnessProviderTickTarget {
  providerId: string;
  models: string[];
  keyPresent?: boolean | undefined;
  unverifiable?: boolean | undefined;
  unverifiableReason?: string | undefined;
  proxyDelegated?: boolean | undefined;
}

export interface HarnessTickTarget {
  harnessId: string;
  configPath: string;
  defaultModels?: string[] | undefined;
  providers: HarnessProviderTickTarget[];
}

export type BlockedRemovalReason =
  | 'SECONDARY_SOURCE_ONLY'
  | 'SHRINK_CAP_EXCEEDED'
  | 'UNVERIFIABLE_NOT_ABSENT'
  | 'DEFAULT_SLOT_PROTECTED';

export interface TickActionLatencyFields {
  sourcePublishedAt: string | null;
  sourceFirstChangedAt: string | null;
  planCreatedAt: string;
  detectionLatencyMs: number | null;
  detectionKind?: 'absence-settled' | 'official-notice' | 'addition' | undefined;
  episodeId?: string | null | undefined;
  evidenceId?: string | undefined;
  firstQualifyingScanStartedAt?: string | undefined;
  firstPlanCreatedAt?: string | null | undefined;
  publicationToPlanMs?: number | null | undefined;
}

export interface TickRouterPlanAction extends TickActionLatencyFields {
  targetType: 'router';
  router: string;
  comboName: string;
  provider: string;
  modelId: string;
  fullStep: string;
  action: 'ADD_MODEL' | 'ENABLE_MODEL' | 'REMOVE_MODEL' | 'DEPRECATION_WARNING';
  reason: string;
  replacementModelId?: string | null | undefined;
}

export interface TickHarnessPlanAction extends TickActionLatencyFields {
  targetType: 'harness';
  harnessId: string;
  configPath: string;
  providerId: string;
  modelId: string;
  action: 'ADD_MODEL' | 'REMOVE_MODEL' | 'DEPRECATION_WARNING';
  reason: string;
  replacementModelId?: string | null | undefined;
}

export interface BlockedRemovalRecord {
  targetType: 'router' | 'harness';
  targetId: string;
  provider: string;
  modelId: string;
  blockedReason: BlockedRemovalReason;
  detail: string;
}

export interface TickPlanFile {
  version: 1;
  mode: EffectiveTickMode;
  planCreatedAt: string;
  planHash: string;
  accounting: {
    requests: number;
    paidRequests: 0;
    tokens: 0;
    llmCalls: 0;
  };
  routerActions: TickRouterPlanAction[];
  harnessActions: TickHarnessPlanAction[];
  blockedRemovals: BlockedRemovalRecord[];
  detectionLatency: DetectionLatencySummary;
}

export interface TickCommandOptions {
  configPath?: string | undefined;
  mode?: AutonomyMode | string | undefined;
  graceCycles?: number | string | undefined;
  maxShrinkRatio?: number | string | undefined;
  minScanIntervalMs?: number | undefined;
  webhookUrl?: string | undefined;
  webhookTimeoutMs?: number | undefined;
  toast?: boolean | undefined;
  json?: boolean | undefined;
  stateDir?: string | undefined;
  plansDir?: string | undefined;
  homeDir?: string | undefined;
  harnessTargets?: HarnessTickTarget[] | undefined;
  nowMs?: number | undefined;
  clock?: (() => number) | undefined;
  /** Programmatic rehearsal only. Requires an injected clock and transport. */
  allowSyntheticNoticeFixture?: boolean | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
  disabledModels?: Set<string> | undefined;
  routerState?: RouterModelState | undefined;
  routerStates?: Record<string, RouterModelState> | Map<string, RouterModelState> | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface TickRunSummary {
  timestamp: string;
  detectionHistoryError?: 'DETECTION_HISTORY_CAP_EXCEEDED' | undefined;
  mode: AutonomyMode;
  effectiveMode: EffectiveTickMode;
  requests: number;
  paidRequests: 0;
  tokens: 0;
  llmCalls: 0;
  changedProviders: number;
  unchangedProviders: number;
  backoffSkipped: number;
  inboxAdded: number;
  researchQueueCount?: number;
  detectionLatency?: DetectionLatencySummary;
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
  shrinkBlockReasons?: Record<string, string[]>;
  absentNotInCombo?: Record<string, string[]>;
  webhookDelivery?: WebhookDeliveryResult | undefined;
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

function normalizeModelKey(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function selectNewestEvidence(records: ResearchEvidenceRecord[]): ResearchEvidenceRecord | undefined {
  if (records.length === 0) return undefined;
  return [...records].sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))[0];
}

export function isOfficialUrlForProvider(provider: string, rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    return verifyProviderSourceDomain(provider, rawUrl).isOfficial;
  } catch {
    return false;
  }
}

export function isVerifiedOfficialLifecycleEvidence(
  evidence: ResearchEvidenceRecord,
  atMs: number,
  allowSyntheticFixture = false
): boolean {
  if (evidence.sourceTier !== 'official' || !evidence.domainVerified ||
      !isOfficialUrlForProvider(evidence.provider, evidence.url) ||
      (!allowSyntheticFixture && evidence.synthetic === true)) return false;
  const submittedMs = parseRemovalEvidenceTimestamp(evidence.submittedAt);
  if (submittedMs === null || submittedMs > atMs) return false;
  if (evidence.verdict !== 'deprecated') return true;
  const publishedMs = parseRemovalEvidenceTimestamp(evidence.publishedAt);
  const shutdownMs = parseRemovalEvidenceTimestamp(evidence.shutdownDate);
  if (evidence.publishedAt != null && (publishedMs === null || publishedMs > submittedMs)) return false;
  if (evidence.shutdownDate != null && shutdownMs === null) return false;
  return publishedMs !== null || shutdownMs !== null;
}

async function discoverLocalHarnessTargets(
  stateDir: string,
  options: TickCommandOptions
): Promise<HarnessTickTarget[]> {
  if (options.harnessTargets !== undefined) {
    return options.harnessTargets;
  }

  const envSource = options.env ?? process.env;
  const tmpRoot = os.tmpdir();
  const stateInTmp = isPathInsideDir(stateDir, tmpRoot);
  const effectiveHomeDir =
    options.homeDir ??
    envSource['ROUTERSYNC_HOME'] ??
    (stateInTmp ? path.join(stateDir, '__isolated_home__') : os.homedir());

  if (!fs.existsSync(effectiveHomeDir)) {
    return [];
  }

  let tierOneIds = new Set<string>();
  try {
    const matrix = loadHarnessMatrix();
    for (const h of matrix.harnesses) {
      if (h.tier === 'A') {
        tierOneIds.add(h.id);
      }
    }
  } catch {
    tierOneIds = new Set(['hermes', 'opencode', 'dsh', 'openmausbot']);
  }

  const discovered: HarnessTickTarget[] = [];
  const seenHarnessIds = new Set<string>();
  for (const harnessId of tierOneIds) {
    try {
      const tierA = inspectTierAHarnessForTick(harnessId, effectiveHomeDir);
      if (tierA) {
        const directProviders: HarnessProviderTickTarget[] = [];
        for (const prov of tierA.providers) {
          if (prov.proxyDelegated) continue;
          if (prov.models.length === 0 && !prov.keyPresent) continue;
          directProviders.push({
            providerId: prov.providerId,
            models: prov.models,
            keyPresent: prov.keyPresent,
            unverifiable: !prov.keyPresent,
            unverifiableReason: !prov.keyPresent ? 'UNVERIFIABLE' : undefined,
          });
        }
        seenHarnessIds.add(harnessId);
        if (directProviders.length > 0) {
          discovered.push({
            harnessId: tierA.harnessId,
            configPath: tierA.configPath,
            defaultModels: tierA.defaultModels,
            providers: directProviders,
          });
        }
        continue;
      }
    } catch {
      // Fall back to read-only AGENT_APP_ADAPTERS below if needed
    }
  }
  for (const adapter of AGENT_APP_ADAPTERS) {
    if (!tierOneIds.has(adapter.app) || seenHarnessIds.has(adapter.app)) continue;
    try {
      const inspection = await adapter.inspect({ homeDir: effectiveHomeDir });
      const directProviders: HarnessProviderTickTarget[] = [];
      for (const prov of inspection.providers) {
        if (prov.kind === 'router') {
          continue; // WP2 PROXY_DELEGATED rule: skip local router proxy entries
        }
        const provModels = inspection.models
          .filter((m) => m.provider === prov.id)
          .map((m) => m.id);
        if (provModels.length === 0) continue;
        directProviders.push({
          providerId: prov.id,
          models: provModels,
          keyPresent: prov.keyPresent,
          unverifiable: prov.kind === 'unknown' && !prov.keyPresent,
          unverifiableReason: prov.kind === 'unknown' && !prov.keyPresent ? 'UNVERIFIABLE' : undefined,
        });
      }
      if (directProviders.length > 0) {
        discovered.push({
          harnessId: inspection.app,
          configPath: inspection.configPath,
          defaultModels: inspection.activeModel !== 'UNKNOWN' ? [inspection.activeModel] : [],
          providers: directProviders,
        });
      }
    } catch {
      // Uninstalled or unreadable harness config: safely ignore in Tier 0 tick
    }
  }

  return discovered;
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
        detectionHistoryError: parsed.detectionHistoryError === 'DETECTION_HISTORY_CAP_EXCEEDED'
          ? parsed.detectionHistoryError : undefined,
        ...(Array.isArray(parsed.absenceDetections)
          ? { absenceDetections: parsed.absenceDetections as ModelPendingRecord[] }
          : {}),
        ...(Array.isArray(parsed.officialNoticeDetections)
          ? { officialNoticeDetections: parsed.officialNoticeDetections as OfficialNoticeDetectionRecord[] }
          : {}),
        ...(parsed.routerTargetAliases &&
        typeof parsed.routerTargetAliases === 'object' &&
        !Array.isArray(parsed.routerTargetAliases)
          ? { routerTargetAliases: parsed.routerTargetAliases as Record<string, string[]> }
          : {}),
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
  applyLowResourcePriority();
  const requestedMode = resolveAutonomyMode(options.mode, { allowAutoSafe: true });
  const graceCycles = validateGraceCycles(options.graceCycles);
  const maxShrinkRatio = validateMaxShrinkRatio(options.maxShrinkRatio);

  const sDir = resolveTickStateDir(options.stateDir);
  const freezeState = readFreezeState(sDir);
  const effectiveMode: EffectiveTickMode = freezeState.frozen ? 'FROZEN' : requestedMode;
  if (!fs.existsSync(sDir)) fs.mkdirSync(sDir, { recursive: true });

  const hasInjectedClock = typeof options.clock === 'function';
  const readClock = options.clock ?? (() => Date.now());
  const nowMs = hasInjectedClock ? readClock() : (options.nowMs ?? Date.now());
  const readPhaseClock = options.nowMs !== undefined && !hasInjectedClock ? () => nowMs : readClock;
  const lock = tryAcquireTickLock(sDir, process.pid, nowMs);
  if (!lock.acquired) {
    throw new Error(`Another tick instance (pid ${lock.holderPid}) already holds ${lock.lockPath}`);
  }

  try {
    const nowIso = new Date(nowMs).toISOString();
    const resolvedPlansDir = options.plansDir ?? path.join(sDir, 'plans');

    const { config } = loadConfigFile(options.configPath);

    const catalogPath = path.join(sDir, 'tick-catalog.json');
    const statusPath = path.join(sDir, 'status.json');
    const tickLogPath = path.join(sDir, 'tick.log');
    const inboxPath = path.join(sDir, 'inbox.json');
    const tickPlanPath = path.join(resolvedPlansDir, 'tick-plan.json');

    const catalogState = loadCatalogState(catalogPath);
    const usedSteps = collectUsedComboSteps();
    const allCombos = loadAllRouterCombos();
    const harnessTargets = await discoverLocalHarnessTargets(sDir, options);
    const disabledModels = options.disabledModels ?? loadRouterDisabledModels(options.env);
    const evidenceRecords = loadResearchEvidence(sDir);

    const targetsByStep = new Map<string, Set<string>>();
    const targetsByPrefix = new Map<string, Set<string>>();
    const configuredTargetModelsByPrefix = new Map<string, Set<string>>();
    const routerTargetAliases: Record<string, string[]> = {
      ...(catalogState.routerTargetAliases ?? {}),
    };
    for (const c of allCombos) {
      const scopes = new Set<string>([`router:${c.router}/${c.name}`]);
      for (const rCfg of config.routers) {
        if (rCfg.adapter === c.router || rCfg.id === c.router) {
          scopes.add(`router:${rCfg.id}/${c.name}`);
          scopes.add(`router:${rCfg.adapter}/${c.name}`);
        }
      }
      if (scopes.size > 1) {
        const sortedScopes = [...scopes].sort();
        for (const sc of sortedScopes) {
          routerTargetAliases[sc] = sortedScopes;
        }
      }
      for (const m of c.models) {
        const set = targetsByStep.get(m) ?? new Set<string>();
        for (const sc of scopes) set.add(sc);
        targetsByStep.set(m, set);
        const slashIdx = m.indexOf('/');
        if (slashIdx > 0 && slashIdx < m.length - 1) {
          const p = m.slice(0, slashIdx);
          const mId = m.slice(slashIdx + 1);
          const pSet = targetsByPrefix.get(p) ?? new Set<string>();
          for (const sc of scopes) pSet.add(sc);
          targetsByPrefix.set(p, pSet);
          const mSet = configuredTargetModelsByPrefix.get(p) ?? new Set<string>();
          mSet.add(mId);
          configuredTargetModelsByPrefix.set(p, mSet);
        }
      }
    }
    if (Object.keys(routerTargetAliases).length > 0) {
      catalogState.routerTargetAliases = routerTargetAliases;
    }
    const expandTargetAliasGroup = (tgt: string): ReadonlySet<string> => {
      const set = new Set<string>([tgt]);
      for (const alias of routerTargetAliases[tgt] ?? []) {
        set.add(alias);
      }
      const m = /^router:([^/]+)\/(.+)$/.exec(tgt);
      if (m) {
        const [, rId, comboName] = m;
        for (const rCfg of config.routers) {
          if (rCfg.id === rId || rCfg.adapter === rId) {
            set.add(`router:${rCfg.id}/${comboName}`);
            set.add(`router:${rCfg.adapter}/${comboName}`);
          }
        }
      }
      return set;
    };
    for (const ht of harnessTargets) {
      for (const hp of ht.providers) {
        if (hp.proxyDelegated) continue;
        const ref = `harness:${ht.harnessId}`;
        const pSet = targetsByPrefix.get(hp.providerId) ?? new Set<string>();
        pSet.add(ref);
        targetsByPrefix.set(hp.providerId, pSet);
        const explicitUnverifiable =
          Boolean(hp.unverifiable) || isUnverifiableScanState(hp.unverifiableReason);
        for (const m of hp.models) {
          const step = `${hp.providerId}/${m}`;
          const set = targetsByStep.get(step) ?? new Set<string>();
          set.add(ref);
          targetsByStep.set(step, set);
          if (!explicitUnverifiable) {
            const mSet = configuredTargetModelsByPrefix.get(hp.providerId) ?? new Set<string>();
            mSet.add(m);
            configuredTargetModelsByPrefix.set(hp.providerId, mSet);
          }
        }
      }
    }

    const allowSyntheticNoticeFixture =
      options.allowSyntheticNoticeFixture === true &&
      options.clock !== undefined &&
      options.fetchFn !== undefined && isPathInsideDir(sDir, os.tmpdir());
    const isSyntheticNotice = (evidence: ResearchEvidenceRecord): boolean =>
      evidence.synthetic === true;
    const isUsableOfficialEvidence = (evidence: ResearchEvidenceRecord, atMs: number): boolean =>
      isVerifiedOfficialLifecycleEvidence(evidence, atMs, allowSyntheticNoticeFixture);
    function hasActiveVerifiedOfficialDeprecation(
      prefix: string,
      modelId: string,
      atMs: number
    ): boolean {
      const canon = canonicalizeResearchProvider(prefix);
      const fullStep = `${prefix}/${modelId}`;
      const official = selectNewestEvidence(
        evidenceRecords.filter(
          (ev) =>
            (ev.id === fullStep || (ev.provider === canon && ev.modelId === modelId)) &&
            isUsableOfficialEvidence(ev, atMs)
        )
      );
      if (!official || official.verdict !== 'deprecated') return false;
      const shutdownMs = official.shutdownDate ? Date.parse(official.shutdownDate) : null;
      return shutdownMs === null || (Number.isFinite(shutdownMs) && shutdownMs <= atMs);
    }

    const absenceDetections: ModelPendingRecord[] = [...(catalogState.absenceDetections ?? [])];
    const officialNoticeDetections: OfficialNoticeDetectionRecord[] = [
      ...(catalogState.officialNoticeDetections ?? []),
    ];
    const newAbsenceDetectionsThisTick: ModelPendingRecord[] = [];
    const qualifyingScanStarts = new Map<string, number>();
    const newOfficialDetectionSamples: number[] = [];

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

    const routerDeclaredHosts = targets
      .map((t) => {
        if (!t.baseUrl) return '';
        try {
          return new URL(t.baseUrl).hostname;
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    const baseFetch = options.fetchFn ?? globalThis.fetch;
    const strictAccounting = createAccountingFetch(baseFetch);
    const l1AccountingFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      try {
        const rawUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const { host } = assertAllowedOutboundUrl(rawUrl, {
          extraAllowedHosts: routerDeclaredHosts,
          allowInsecureExtraHosts: true,
        });
        strictAccounting.recordHostRequest(host);
      } catch (err) {
        return Promise.reject(err);
      }
      return baseFetch(input, init);
    }) as typeof globalThis.fetch;

    let requests = 0;
    let changedProviders = 0;
    let unchangedProviders = 0;
    let backoffSkipped = 0;
    const providerSummaries: TickRunSummary['providers'] = [];
    const newInboxCandidates: TickInboxItem[] = [];
    const loadedDetectionCount = absenceDetections.length + officialNoticeDetections.length;
    let detectionHistoryCapExceeded = loadedDetectionCount > MAX_DETECTION_RECORDS ||
      (loadedDetectionCount >= MAX_DETECTION_RECORDS &&
        catalogState.detectionHistoryError === 'DETECTION_HISTORY_CAP_EXCEEDED');
    let slotBlockedThisTick = false;
    const completedAt = (episode: DetectionLifecycle): string | undefined =>
      episode.removedAt ?? episode.recoveredAt ?? episode.withdrawnAt ?? episode.supersededAt ?? episode.abandonedAt;
    let completionChanged = false;
    const episodeMatchesOfficialProof = (
      record: OfficialNoticeDetectionRecord,
      evId: string | undefined,
      epKey: string | undefined
    ): boolean => {
      if (!evId) return false;
      const validEvIds = [record.evidenceId, ...(record.previousEvidenceIds ?? [])];
      const validKeys = [record.recordKey, ...(record.previousRecordKeys ?? [])];
      return validEvIds.includes(evId) && (epKey === undefined || validKeys.includes(epKey));
    };
    const receiptMatchesEpisodeRemoval = (
      cand: ReturnType<typeof readApplyHistory>['receipts'][number],
      episode: ModelPendingRecord | OfficialNoticeDetectionRecord
    ): boolean =>
      (cand.removedModels ?? []).some((rm) => {
        if (rm.provider !== episode.provider || rm.modelId !== episode.modelId) return false;
        if ('recordKey' in episode) {
          return episodeMatchesOfficialProof(episode, rm.detectionEvidenceId, rm.detectionEpisodeId);
        }
        return rm.detectionEpisodeId === episode.episodeId;
      });
    const isTargetGroupVerifiedAbsentLive = (
      aliasSet: ReadonlySet<string>,
      episode: ModelPendingRecord | OfficialNoticeDetectionRecord
    ): boolean => {
      const listedTargets = targetsByStep.get(episode.fullStep);
      for (const a of aliasSet) {
        if (listedTargets?.has(a)) return false;
      }
      const sample = [...aliasSet][0];
      if (!sample) return false;
      if (sample.startsWith('router:')) {
        return allCombos.some((combo) => {
          const configured = config.routers.find(
            (router) => router.id === combo.router || router.adapter === combo.router
          );
          const comboAliases = [combo.router, configured?.id, configured?.adapter]
            .filter((r): r is string => Boolean(r))
            .map((r) => `router:${r}/${combo.name}`);
          return (
            comboAliases.some((ref) => aliasSet.has(ref)) &&
            !combo.models.includes(episode.fullStep)
          );
        });
      }
      if (sample.startsWith('harness:')) {
        const hId = sample.slice('harness:'.length);
        const ht = harnessTargets.find((target) => target.harnessId === hId);
        if (!ht || !fs.existsSync(ht.configPath)) return false;
        const hasUnverifiableOrProxy = ht.providers.some(
          (p) =>
            p.providerId === episode.provider &&
            (Boolean(p.unverifiable) ||
              isUnverifiableScanState(p.unverifiableReason) ||
              Boolean(p.proxyDelegated))
        );
        if (hasUnverifiableOrProxy) return false;
        const provModels = ht.providers.find((p) => p.providerId === episode.provider)?.models ?? [];
        return !provModels.includes(episode.modelId) && !provModels.includes(episode.fullStep);
      }
      return false;
    };
    const isEpisodeFullySettledAcrossTargets = (
      history: ReturnType<typeof readApplyHistory>,
      episode: ModelPendingRecord | OfficialNoticeDetectionRecord,
      optionsForSettle: { checkLiveContradiction: boolean; allowLiveVerifiedFallback: boolean }
    ): boolean => {
      if (!history.present || !history.valid || episode.targetsAffected.length === 0) return false;
      const seenGroups = new Set<string>();
      for (const tgt of episode.targetsAffected) {
        const aliasSet = expandTargetAliasGroup(tgt);
        const groupKey = [...aliasSet].sort().join('\0');
        if (seenGroups.has(groupKey)) continue;
        seenGroups.add(groupKey);

        let latestRolledBackIdx = -1;
        let latestActiveIdx = -1;
        history.receipts.forEach((cand, idx) => {
          if (!cand.success || !cand.readBackVerified || !aliasSet.has(cand.target)) return;
          if (!receiptMatchesEpisodeRemoval(cand, episode)) return;
          if (cand.rolledBack) latestRolledBackIdx = idx;
          else latestActiveIdx = idx;
        });

        if (latestRolledBackIdx > latestActiveIdx) {
          return false;
        }
        if (latestActiveIdx >= 0 && latestActiveIdx > latestRolledBackIdx) {
          if (optionsForSettle.checkLiveContradiction) {
            const listedTargets = targetsByStep.get(episode.fullStep);
            for (const a of aliasSet) {
              if (listedTargets?.has(a)) return false;
            }
          }
          continue;
        }
        if (!optionsForSettle.allowLiveVerifiedFallback || !isTargetGroupVerifiedAbsentLive(aliasSet, episode)) {
          return false;
        }
      }
      return true;
    };
    const markRemovalCompleted = (
      models: ReadonlyArray<RemovedModelReceiptEvidence>,
      removedAt: string,
      historySnapshot?: ReturnType<typeof readApplyHistory>,
      checkLiveContradiction = false
    ): void => {
      const effectiveHistory = historySnapshot ?? readApplyHistory(sDir);
      if (!effectiveHistory.present || !effectiveHistory.valid) return;
      for (const model of models) {
        const episode = model.detectionEvidenceId
          ? officialNoticeDetections.find(
              (record) =>
                record.provider === model.provider &&
                record.modelId === model.modelId &&
                episodeMatchesOfficialProof(record, model.detectionEvidenceId, model.detectionEpisodeId)
            )
          : absenceDetections.find((record) => record.episodeId === model.detectionEpisodeId);
        if (!episode || episode.removedAt !== undefined) continue;
        const canComplete = isEpisodeFullySettledAcrossTargets(effectiveHistory, episode, {
          checkLiveContradiction,
          allowLiveVerifiedFallback: true,
        });
        if (canComplete) {
          episode.removedAt = removedAt;
          const provEntry = catalogState.providers[model.provider];
          const epId = 'episodeId' in episode ? episode.episodeId : model.detectionEpisodeId;
          if (provEntry?.pendingEpisodes && provEntry.pendingEpisodes[model.modelId] === epId) {
            delete provEntry.pendingEpisodes[model.modelId];
          }
          completionChanged = true;
        }
      }
    };
    // A signed receipt can survive an interrupted catalog write, while rolled-back or incomplete
    // multi-target receipts keep their affected episodes open until every target is settled.
    const priorApplyHistory = readApplyHistory(sDir);
    if (priorApplyHistory.present && priorApplyHistory.valid) {
      for (const receipt of priorApplyHistory.receipts) {
        if (receipt.success && receipt.readBackVerified && !receipt.rolledBack && receipt.removedModels?.length) {
          markRemovalCompleted(receipt.removedModels, receipt.appliedAt, priorApplyHistory, true);
        }
      }
    }
    // Older propose receipts lack per-model proof. Reconcile terminal state only when apply-history
    // is present & valid and every affected target can be fail-closed verified to no longer list the model.
    if (priorApplyHistory.present && priorApplyHistory.valid) {
      for (const receipt of priorApplyHistory.receipts) {
        if (!receipt.success || !receipt.readBackVerified || receipt.rolledBack ||
            receipt.appliedAtLevel !== 'propose' || receipt.removedModels?.length) continue;
        const appliedAt = parseRemovalEvidenceTimestamp(receipt.appliedAt);
        if (appliedAt === null || appliedAt > nowMs) continue;
        for (const episode of [...absenceDetections, ...officialNoticeDetections]) {
          if (completedAt(episode)) continue;
          const coversReceiptTarget = episode.targetsAffected.some((tgt) =>
            expandTargetAliasGroup(tgt).has(receipt.target)
          );
          if (!coversReceiptTarget) continue;
          const anchor = parseRemovalEvidenceTimestamp(
            'scanStartedAt' in episode ? episode.scanStartedAt : episode.firstQualifyingScanStartedAt
          );
          if (anchor === null || appliedAt <= anchor) continue;
          if (
            isEpisodeFullySettledAcrossTargets(priorApplyHistory, episode, {
              checkLiveContradiction: true,
              allowLiveVerifiedFallback: true,
            })
          ) {
            episode.removedAt = nowIso;
            if ('episodeId' in episode) {
              const provEntry = catalogState.providers[episode.provider];
              if (provEntry?.pendingEpisodes?.[episode.modelId] === episode.episodeId) {
                delete provEntry.pendingEpisodes[episode.modelId];
              }
            }
            completionChanged = true;
          }
        }
      }
    }
    const pruneDetectionHistory = (): void => {
      const oldestAllowed = nowMs - COMPLETED_DETECTION_RETENTION_MS;
      for (const episodes of [absenceDetections, officialNoticeDetections]) {
        for (let index = episodes.length - 1; index >= 0; index--) {
          const terminalMs = parseRemovalEvidenceTimestamp(completedAt(episodes[index]!));
          if (terminalMs !== null && terminalMs < oldestAllowed) episodes.splice(index, 1);
        }
      }
    };
    pruneDetectionHistory();
    if (absenceDetections.length + officialNoticeDetections.length < MAX_DETECTION_RECORDS) {
      detectionHistoryCapExceeded = false;
    }
    const reserveDetectionSlot = (): boolean => {
      pruneDetectionHistory();
      if (absenceDetections.length + officialNoticeDetections.length < MAX_DETECTION_RECORDS) {
        if (!slotBlockedThisTick) detectionHistoryCapExceeded = false;
        return true;
      }
      slotBlockedThisTick = true;
      detectionHistoryCapExceeded = true;
      return false;
    };
    const addedByPrefix = new Map<string, Set<string>>();
    const shrinkBlockReasons = new Map<string, string[]>();
    const absentNotInCombo = new Map<string, string[]>();

    let blacklistPatterns: string[] = [];
    let blacklistEmptyLogged = false;
    try {
      const { config: rankCfg } = loadRankingConfig(undefined, { quiet: true });
      blacklistPatterns = rankCfg.blacklist ?? [];
    } catch {
      blacklistPatterns = [];
    }

    for (const t of targets) {
      const prev = catalogState.providers[t.prefix];
      const activeTargetsForPrefix = [
        ...(targetsByPrefix.get(t.prefix) ?? new Set([`router:${t.router}`])),
      ].sort();

      if (t.skipReason || !t.baseUrl) {
        // C45-WP3 §4.3: Skipped/unverifiable provider NEVER increments absenceCounts
        catalogState.providers[t.prefix] = {
          prefix: t.prefix,
          router: t.router,
          contentHash: prev?.contentHash ?? prev?.hash ?? '',
          serverEtag: prev?.serverEtag ?? null,
          hash: prev?.hash ?? '',
          ids: prev?.ids ?? [],
          absenceCounts: prev?.absenceCounts ?? {},
          firstAbsentAt: prev?.firstAbsentAt,
          firstSeenAt: prev?.firstSeenAt,
          pendingEpisodes: prev?.pendingEpisodes,
          qualifyingScanTimestamps: prev?.qualifyingScanTimestamps,
          activeTargets: activeTargetsForPrefix,
          consecutiveFailures: prev?.consecutiveFailures ?? 0,
          backoffUntilMs: prev?.backoffUntilMs ?? 0,
          lastStatus: 0,
          lastLabel: 'SKIPPED',
          skipReason: t.skipReason ?? (t.baseUrl ? undefined : 'missing-base-url'),
          updatedAt: prev?.updatedAt ?? nowIso,
        };
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
      const tickTimeoutMs = isLowResource() ? 8_000 : 12_000;
      const scanStartedAtMs = readPhaseClock();
      const scanStartedAtIso = new Date(scanStartedAtMs).toISOString();
      const outcome = await fetchModelList(t, {
        fetchFn: l1AccountingFetch,
        timeoutMs: tickTimeoutMs,
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
          firstSeenAt: prev?.firstSeenAt,
          pendingEpisodes: prev?.pendingEpisodes,
          qualifyingScanTimestamps: prev?.qualifyingScanTimestamps,
          activeTargets: activeTargetsForPrefix,
          consecutiveFailures: failures,
          backoffUntilMs: nowMs + backoffMs,
          lastStatus: outcome.status,
          lastLabel: failLabel,
          skipReason,
          updatedAt: scanStartedAtIso,
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

      const nextQualifyingScans = [
        ...(prev?.qualifyingScanTimestamps ?? []),
        scanStartedAtIso,
      ].slice(-50);

      if (outcome.status === 304) {
        qualifyingScanStarts.set(t.prefix, scanStartedAtMs);
        unchangedProviders++;
        catalogState.providers[t.prefix] = {
          ...prev!,
          skipReason: undefined,
          qualifyingScanTimestamps: nextQualifyingScans,
          activeTargets: activeTargetsForPrefix,
          consecutiveFailures: 0,
          backoffUntilMs: 0,
          lastStatus: 304,
          lastLabel: 'UNCHANGED',
          updatedAt: scanStartedAtIso,
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
      const nextFirstSeenAt: Record<string, string> = { ...(prev?.firstSeenAt ?? {}) };
      for (const id of fetchedIds) {
        if (!nextFirstSeenAt[id]) {
          nextFirstSeenAt[id] = scanStartedAtIso;
        }
      }

      const configuredIdsForPrefix =
        effectiveMode !== 'observe'
          ? [...(configuredTargetModelsByPrefix.get(t.prefix) ?? [])]
          : [];
      const fetchedSetForShortcut = new Set(fetchedIds);
      const hasMissingConfiguredTarget = configuredIdsForPrefix.some(
        (id) => !fetchedSetForShortcut.has(id)
      );

      if (
        prev &&
        (prev.contentHash ?? prev.hash) === nextHash &&
        Object.keys(prev.absenceCounts ?? {}).length === 0 &&
        !hasMissingConfiguredTarget
      ) {
        qualifyingScanStarts.set(t.prefix, scanStartedAtMs);
        unchangedProviders++;
        catalogState.providers[t.prefix] = {
          ...prev,
          skipReason: undefined,
          contentHash: nextHash,
          serverEtag: outcome.serverEtag ?? prev.serverEtag ?? null,
          hash: nextHash,
          firstSeenAt: nextFirstSeenAt,
          qualifyingScanTimestamps: nextQualifyingScans,
          activeTargets: activeTargetsForPrefix,
          consecutiveFailures: 0,
          backoffUntilMs: 0,
          lastStatus: outcome.status,
          lastLabel: 'UNCHANGED',
          updatedAt: scanStartedAtIso,
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
            firstSeenAt: prev?.firstSeenAt,
            pendingEpisodes: prev?.pendingEpisodes,
            qualifyingScanTimestamps: prev?.qualifyingScanTimestamps,
            activeTargets: activeTargetsForPrefix,
            consecutiveFailures: 0,
            backoffUntilMs: 0,
            lastStatus: outcome.status,
            lastLabel: 'SHRINK-GUARD-BLOCKED',
            updatedAt: scanStartedAtIso,
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

      qualifyingScanStarts.set(t.prefix, scanStartedAtMs);
      const prevSet = new Set(prevIds);
      const nextSet = new Set(fetchedIds);
      const added = prevIds.length > 0 ? fetchedIds.filter((id) => !prevSet.has(id)) : [];
      addedByPrefix.set(t.prefix, new Set(added));
      const nextAbsence: Record<string, number> = {};
      const nextFirstAbsentAt: Record<string, string> = { ...(prev?.firstAbsentAt ?? {}) };
      const nextPendingEpisodes: Record<string, string> = {};
      for (const [pendModelId, pendEpId] of Object.entries(prev?.pendingEpisodes ?? {})) {
        const openEp = absenceDetections.find(
          (ep) =>
            ep.provider === t.prefix &&
            ep.modelId === pendModelId &&
            ep.episodeId === pendEpId &&
            completedAt(ep) === undefined
        );
        if (openEp) {
          nextPendingEpisodes[pendModelId] = pendEpId;
        }
      }
      const graceAbsent: string[] = [];
      const deadConfirmed: string[] = [];
      const newlyPendingIds: string[] = [];

      const candidatesToCheck = new Set<string>([
        ...prevIds,
        ...Object.keys(prev?.absenceCounts ?? {}),
        ...configuredIdsForPrefix,
      ]);

      for (const id of candidatesToCheck) {
        if (nextSet.has(id)) {
          delete nextFirstAbsentAt[id];
          const activeEpisode = absenceDetections.find((episode) =>
            episode.provider === t.prefix && episode.modelId === id && completedAt(episode) === undefined
          );
          if (activeEpisode) activeEpisode.recoveredAt = scanStartedAtIso;
          delete nextPendingEpisodes[id];
          continue;
        }
        const fullStep = `${t.prefix}/${id}`;
        const firstAbsentIso = nextFirstAbsentAt[id];
        const absentDurationMs = firstAbsentIso ? scanStartedAtMs - Date.parse(firstAbsentIso) : 0;
        if (absentDurationMs > 7 * 24 * 3600 * 1000 && !usedSteps.has(fullStep) && !targetsByStep.has(fullStep)) {
          const episode = absenceDetections.find((record) =>
            record.provider === t.prefix && record.modelId === id && completedAt(record) === undefined
          );
          if (episode) episode.abandonedAt = scanStartedAtIso;
          delete nextFirstAbsentAt[id];
          delete nextAbsence[id];
          delete nextFirstSeenAt[id];
          delete nextPendingEpisodes[id];
          continue;
        }

        if (!nextFirstAbsentAt[id]) {
          nextFirstAbsentAt[id] = scanStartedAtIso;
        }
        const count = (prev?.absenceCounts?.[id] ?? 0) + 1;
        nextAbsence[id] = count;
        if (count < graceCycles) {
          graceAbsent.push(id);
        } else {
          deadConfirmed.push(id);
        }

        if (
          effectiveMode !== 'observe' &&
          !nextPendingEpisodes[id] &&
          (usedSteps.has(fullStep) || targetsByStep.has(fullStep)) &&
          !hasActiveVerifiedOfficialDeprecation(t.prefix, id, scanStartedAtMs)
        ) {
          newlyPendingIds.push(id);
        }
      }

      if (newlyPendingIds.length > 0) {
        const rawCommitMs = readPhaseClock();
        // Fixed or injected clocks can deliberately place both events at the same instant.
        const simulatesClock = hasInjectedClock || options.nowMs !== undefined;
        const modelPendingAtMs =
          simulatesClock && rawCommitMs === scanStartedAtMs ? scanStartedAtMs + 1 : rawCommitMs;
        const modelPendingAtIso = new Date(modelPendingAtMs).toISOString();
        const epDetectionMs = modelPendingAtMs - scanStartedAtMs;
        for (const id of newlyPendingIds) {
          const fullStep = `${t.prefix}/${id}`;
          const episodeId = `ep-${JSON.stringify([t.prefix, id, scanStartedAtMs])}`;
          const existingEpisode = absenceDetections.find((episode) =>
            episode.provider === t.prefix && episode.modelId === id && completedAt(episode) === undefined
          );
          if (existingEpisode) {
            nextPendingEpisodes[id] = existingEpisode.episodeId;
            continue;
          }
          if (!reserveDetectionSlot()) continue;
          nextPendingEpisodes[id] = episodeId;
          const affected = [
            ...(targetsByStep.get(fullStep) ?? targetsByPrefix.get(t.prefix) ?? new Set<string>()),
          ].sort();
          const pendingRec: ModelPendingRecord = {
            episodeId,
            provider: t.prefix,
            modelId: id,
            fullStep,
            status: 'model_pending',
            scanStartedAt: scanStartedAtIso,
            modelPendingAt: modelPendingAtIso,
            detectionMs: epDetectionMs,
            targetsAffected: affected,
          };
          absenceDetections.push(pendingRec);
          newAbsenceDetectionsThisTick.push(pendingRec);
        }
      }

      const effectiveIds = [...new Set([...fetchedIds, ...graceAbsent])].sort();
      const didChange =
        !prev ||
        (prev.contentHash ?? prev.hash) !== nextHash ||
        deadConfirmed.length > 0 ||
        added.length > 0;
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
        firstSeenAt: nextFirstSeenAt,
        pendingEpisodes: nextPendingEpisodes,
        qualifyingScanTimestamps: nextQualifyingScans,
        activeTargets: activeTargetsForPrefix,
        consecutiveFailures: 0,
        backoffUntilMs: 0,
        lastStatus: outcome.status,
        lastLabel: didChange ? 'OK' : 'UNCHANGED',
        updatedAt: scanStartedAtIso,
      };

      const candidateModels = prevIds.length === 0 ? fetchedIds : added;
      if (candidateModels.length > 0) {
        if (blacklistPatterns.length === 0 && !blacklistEmptyLogged) {
          console.log('BLACKLIST=none');
          blacklistEmptyLogged = true;
        }

        const allowedCandidates = candidateModels.filter(
          (candidateId) =>
            !isBlacklisted(candidateId, blacklistPatterns) &&
            !isBlacklisted(`${t.prefix}/${candidateId}`, blacklistPatterns)
        );

        const rState = getRouterStateFor(t.router);
        const tierCModels = allowedCandidates.filter(
          (id) => resolveModelTier(t.prefix, id, usedSteps, disabledModels, rState) === 'C'
        );
        const tierBModels = allowedCandidates.filter(
          (id) => resolveModelTier(t.prefix, id, usedSteps, disabledModels, rState) === 'B'
        );

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

        for (const addedId of prevIds.length > 0 ? allowedCandidates : []) {
          const tier = resolveModelTier(t.prefix, addedId, usedSteps, disabledModels, rState);
          if (tier === 'A' || tier === 'UNKNOWN') continue;

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
          if (asCheck.reasons.length > 0) {
            const existing = shrinkBlockReasons.get(t.prefix) ?? [];
            existing.push(`${deadId}: ${asCheck.reasons.join('; ')}`);
            shrinkBlockReasons.set(t.prefix, existing);
          }
        }

        if (usedSteps.has(fullStep)) {
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
    catalogState.absenceDetections = absenceDetections;
    catalogState.officialNoticeDetections = [...officialNoticeDetections];
    atomicWriteFileSync(catalogPath, JSON.stringify(catalogState, null, 2));

    // A3: Run L2 (1h TTL) and L3 (24h TTL) scans and aggregate requests into unified accounting
    const l2Res = await runL2Scan({ stateDir: sDir, nowMs, fetchFn: strictAccounting.fetchFn });
    const l3Res = await runL3Scan({ stateDir: sDir, nowMs, fetchFn: strictAccounting.fetchFn });
    let totalRequests = requests + l2Res.requests + l3Res.requests;

    // C45-WP3 §3.1: Join research-evidence.json with L1/L2/L3 verification
    const matchedEvidenceRecordIds = new Set<string>();

    const verifyRecordsByStep = new Map<string, ModelVerificationRecord>();
    try {
      const { runVerifyPhase } = await import('../verify/verifier.js');
      const targetSteps = new Set<string>();
      for (const c of allCombos) {
        for (const m of c.models) targetSteps.add(m);
      }
      for (const ht of harnessTargets) {
        for (const hp of ht.providers) {
          for (const m of hp.models) {
            targetSteps.add(`${hp.providerId}/${m}`);
          }
        }
      }
      for (const [prefix, addedSet] of addedByPrefix.entries()) {
        for (const addedId of addedSet) {
          targetSteps.add(`${prefix}/${addedId}`);
        }
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
        const isSkippedScan =
          !provEntry ||
          (Boolean(provEntry.skipReason) &&
            provEntry.skipReason !== 'MIN_INTERVAL_SKIPPED' &&
            provEntry.skipReason !== '304_NOT_MODIFIED' &&
            provEntry.lastStatus === 0);
        const unscannedReason = isSkippedScan
          ? (provEntry?.skipReason ?? (!provEntry ? 'chưa-quét' : undefined))
          : undefined;
        const presence = resolveCatalogPresence(provEntry, id);
        const l1Exists = presence.l1Exists;
        const l1Status = provEntry ? provEntry.lastStatus : 0;
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
          isUnscanned: isSkippedScan,
          unscannedReason,
        });
      }

      const verifySummary = await runVerifyPhase({
        stateDir: sDir,
        nowMs,
        models: realModels,
        combos: allCombos,
        evidenceRecords,
        fetchFn: strictAccounting.fetchFn,
        silent: true,
      });
      totalRequests += verifySummary.accounting?.requests ?? 0;

      for (const rec of verifySummary.records) {
        verifyRecordsByStep.set(rec.fullStep, rec);
      }

      const alertLabels = new Set(['NGHI-NGỪNG', 'SẮP-NGỪNG', 'ĐÃ-XÁC-NHẬN-NGỪNG', 'CHƯA-XÁC-MINH']);
      for (const rec of verifySummary.records) {
        if (!usedSteps.has(rec.fullStep)) continue;
        const isActionable =
          rec.label === 'ĐÃ-XÁC-NHẬN-NGỪNG' ||
          rec.label === 'SẮP-NGỪNG' ||
          ((rec.label === 'NGHI-NGỪNG' || rec.label === 'CHƯA-XÁC-MINH') &&
            !rec.unscannedReason &&
            (rec.l1.absenceCount ?? 0) >= 2);

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

    // Helper: lookup matching submitted evidence records for (prefix, modelId)
    function findEvidenceForModel(prefix: string, modelId: string): {
      official?: ResearchEvidenceRecord | undefined;
      secondary?: ResearchEvidenceRecord | undefined;
      all: ResearchEvidenceRecord[];
    } {
      const canon = canonicalizeResearchProvider(prefix);
      const fullStep = `${prefix}/${modelId}`;
      const matched = evidenceRecords.filter(
        (ev) => ev.id === fullStep || (ev.provider === canon && ev.modelId === modelId)
      );
      for (const ev of matched) {
        matchedEvidenceRecordIds.add(ev.recordId);
      }
      return {
        official: selectNewestEvidence(
          matched.filter((ev) => isUsableOfficialEvidence(ev, qualifyingScanStarts.get(prefix) ?? nowMs))
        ),
        secondary: selectNewestEvidence(matched.filter((ev) => ev.sourceTier === 'secondary')),
        all: matched,
      };
    }

    const latchOfficialScan = (
      provider: string,
      modelId: string,
      evidenceId: string,
      publishedAt: string | null,
      synthetic: boolean,
      effectiveAtMs: number,
      legacyRecordId?: string
    ): OfficialNoticeDetectionRecord | undefined => {
      const fullStep = `${provider}/${modelId}`;
      const scanStartedAtMs = qualifyingScanStarts.get(provider);
      const scoped = officialNoticeDetections.filter((notice) =>
        notice.fullStep === fullStep && notice.synthetic === synthetic
      );
      const current = scoped.find((notice) => !notice.withdrawnAt && !notice.supersededAt &&
        (notice.evidenceId === evidenceId || (legacyRecordId !== undefined && notice.evidenceId === legacyRecordId)));
      if (scanStartedAtMs === undefined) return current;
      if (scanStartedAtMs < effectiveAtMs) return undefined;

      const active = scoped.filter((notice) => completedAt(notice) === undefined);
      const earliestAnchor = Math.min(...active.map((notice) => Date.parse(notice.firstQualifyingScanStartedAt)));
      const canonicalProvider = canonicalizeResearchProvider(provider);
      const gapCandidates = evidenceRecords.filter((evidence) =>
        evidence.provider === canonicalProvider && evidence.modelId === modelId &&
        !isSyntheticNotice(evidence) && isUsableOfficialEvidence(evidence, scanStartedAtMs) &&
        (evidence.verdict === 'active' || evidence.verdict === 'upcoming_deprecation' ||
          (evidence.verdict === 'deprecated' &&
            (parseRemovalEvidenceTimestamp(evidence.shutdownDate) ?? 0) > Date.parse(evidence.submittedAt)))
      );
      const latestGap = selectNewestEvidence(gapCandidates);
      const gapAt = latestGap ? Date.parse(latestGap.submittedAt) : Number.NEGATIVE_INFINITY;
      if (active.length > 0 && gapAt <= earliestAnchor) {
        // Continuous actionable chain (no verified non-actionable gap after earliestAnchor):
        // keep anchor and any existing firstPlanCreatedAt/detectionMs latch intact, updating provenance in place.
        const primary = active.reduce((best, cand) =>
          Date.parse(cand.firstQualifyingScanStartedAt) <= Date.parse(best.firstQualifyingScanStartedAt)
            ? cand
            : best
        );
        const prevEvidenceId = primary.evidenceId;
        const prevRecordKey = primary.recordKey;
        const anchorMs = Math.min(earliestAnchor, scanStartedAtMs);
        primary.firstQualifyingScanStartedAt = new Date(anchorMs).toISOString();
        primary.evidenceId = evidenceId;
        primary.sourcePublishedAt = publishedAt;
        const keyAnchor = primary.episodeStartedAt ?? primary.firstQualifyingScanStartedAt;
        const nextRecordKey = JSON.stringify([fullStep, evidenceId, keyAnchor]);
        primary.recordKey = nextRecordKey;
        if (prevEvidenceId && prevEvidenceId !== evidenceId) {
          const prevEvList = [...(primary.previousEvidenceIds ?? [])];
          if (!prevEvList.includes(prevEvidenceId)) prevEvList.push(prevEvidenceId);
          const filteredEv = prevEvList.filter((id) => id !== evidenceId);
          if (filteredEv.length > 0) primary.previousEvidenceIds = filteredEv;
          else delete primary.previousEvidenceIds;
        } else if (primary.previousEvidenceIds) {
          const filteredEv = primary.previousEvidenceIds.filter((id) => id !== evidenceId);
          if (filteredEv.length > 0) primary.previousEvidenceIds = filteredEv;
          else delete primary.previousEvidenceIds;
        }
        if (prevRecordKey && prevRecordKey !== nextRecordKey) {
          const prevKeyList = [...(primary.previousRecordKeys ?? [])];
          if (!prevKeyList.includes(prevRecordKey)) prevKeyList.push(prevRecordKey);
          const filteredKeys = prevKeyList.filter((k) => k !== nextRecordKey);
          if (filteredKeys.length > 0) primary.previousRecordKeys = filteredKeys;
          else delete primary.previousRecordKeys;
        } else if (primary.previousRecordKeys) {
          const filteredKeys = primary.previousRecordKeys.filter((k) => k !== nextRecordKey);
          if (filteredKeys.length > 0) primary.previousRecordKeys = filteredKeys;
          else delete primary.previousRecordKeys;
        }
        if (primary.firstPlanCreatedAt !== null) {
          const planMs = Date.parse(primary.firstPlanCreatedAt);
          primary.detectionMs = planMs - anchorMs;
          const pubMs = parseRemovalEvidenceTimestamp(publishedAt);
          primary.publicationToPlanMs = pubMs === null ? null : planMs - pubMs;
        }
        for (const tgt of targetsByStep.get(fullStep) ?? []) {
          if (!primary.targetsAffected.includes(tgt)) {
            primary.targetsAffected.push(tgt);
          }
        }
        primary.targetsAffected.sort();
        return primary;
      }
      if (!reserveDetectionSlot()) return undefined;
      const anchor = earliestAnchor < gapAt ? scanStartedAtMs : Math.min(earliestAnchor, scanStartedAtMs);
      const firstQualifyingScanStartedAt = new Date(anchor).toISOString();
      const startedIso = new Date(scanStartedAtMs).toISOString();
      for (const notice of active) {
        if (gapAt > Date.parse(notice.firstQualifyingScanStartedAt)) {
          const gapIso = new Date(gapAt).toISOString();
          if (latestGap?.verdict === 'active') {
            notice.withdrawnAt = gapIso;
          } else {
            notice.supersededAt = gapIso;
          }
        } else {
          notice.supersededAt = startedIso;
        }
      }
      const notice: OfficialNoticeDetectionRecord = {
        recordKey: JSON.stringify([fullStep, evidenceId, startedIso]),
        episodeStartedAt: startedIso,
        evidenceId, fullStep, provider, modelId, synthetic,
        sourcePublishedAt: publishedAt,
        firstQualifyingScanStartedAt,
        firstPlanCreatedAt: null,
        publicationToPlanMs: null,
        detectionMs: null,
        targetsAffected: Array.from(targetsByStep.get(fullStep) ?? []).sort(),
      };
      officialNoticeDetections.push(notice);
      return notice;
    };
    const recordOfficialPlan = (
      notice: OfficialNoticeDetectionRecord | undefined,
      planAt: string,
      target: string
    ): Partial<TickActionLatencyFields> => {
      if (!notice) return { publicationToPlanMs: null };
      if (!notice.targetsAffected.includes(target)) notice.targetsAffected.push(target);
      if (notice.firstPlanCreatedAt === null) {
        notice.firstPlanCreatedAt = planAt;
        const planMs = Date.parse(planAt);
        notice.detectionMs = planMs - Date.parse(notice.firstQualifyingScanStartedAt);
        const publishedMs = parseRemovalEvidenceTimestamp(notice.sourcePublishedAt);
        notice.publicationToPlanMs = publishedMs === null ? null : planMs - publishedMs;
        newOfficialDetectionSamples.push(notice.detectionMs);
      }
      return {
        evidenceId: notice.evidenceId,
        firstQualifyingScanStartedAt: notice.firstQualifyingScanStartedAt,
        firstPlanCreatedAt: notice.firstPlanCreatedAt,
        publicationToPlanMs: notice.publicationToPlanMs,
      };
    };
    // Helper: evaluate WP3 Part 4 removal eligibility for one (prefix, modelId)
    function checkRemovalEligibility(
      prefix: string,
      modelId: string,
      opts: { explicitUnverifiable?: boolean | undefined } = {}
    ): {
      eligible: boolean;
      blockedReason?: BlockedRemovalReason | undefined;
      reason: string;
      sourcePublishedAt: string | null;
      sourceFirstChangedAt: string | null;
      replacementModelId: string | null;
      officialNotice?: OfficialNoticeDetectionRecord | undefined;
    } {
      const provEntry = catalogState.providers[prefix];
      const ev = findEvidenceForModel(prefix, modelId);
      const fullStep = `${prefix}/${modelId}`;
      const verifyRec = verifyRecordsByStep.get(fullStep);

      const providerScanUnverifiable =
        Boolean(opts.explicitUnverifiable) ||
        !provEntry ||
        provEntry.lastStatus === 0 ||
        (provEntry.lastStatus >= 400 && provEntry.lastStatus !== 404) ||
        isUnverifiableScanState(provEntry.lastLabel) ||
        Boolean(
          provEntry.skipReason &&
            provEntry.skipReason !== 'MIN_INTERVAL_SKIPPED' &&
            provEntry.skipReason !== '304_NOT_MODIFIED'
        );

      // §4.3 Hard UNVERIFIABLE != ABSENT guard
      if (providerScanUnverifiable) {
        return {
          eligible: false,
          blockedReason: ev.secondary?.verdict === 'deprecated' ? 'UNVERIFIABLE_NOT_ABSENT' : undefined,
          reason: 'UNVERIFIABLE_NOT_ABSENT',
          sourcePublishedAt: null,
          sourceFirstChangedAt: null,
          replacementModelId: null,
        };
      }

      const firstAbsentAt = provEntry?.firstAbsentAt?.[modelId] ?? null;

      const officialEvidenceAt = qualifyingScanStarts.get(prefix) ?? nowMs;
      // Path 1a: Verified official deprecation evidence in research-evidence.json
      if (ev.official && ev.official.verdict === 'deprecated') {
        const shutdownMs = ev.official.shutdownDate ? Date.parse(ev.official.shutdownDate) : null;
        if (shutdownMs === null || (Number.isFinite(shutdownMs) && shutdownMs <= officialEvidenceAt)) {
          return {
            eligible: true,
            reason: `OFFICIAL_DEPRECATION (${ev.official.url})`,
            sourcePublishedAt: ev.official.publishedAt ?? null,
            officialNotice: latchOfficialScan(prefix, modelId, researchEvidenceIdentity(ev.official),
              ev.official.publishedAt, isSyntheticNotice(ev.official),
              Math.max(shutdownMs ?? 0, Date.parse(ev.official.submittedAt)), ev.official.recordId),
            sourceFirstChangedAt: firstAbsentAt,
            replacementModelId: ev.official.replacementModelId ?? null,
          };
        }
      }

      // Path 1b: Official vendor L3 deprecation + absenceCount >= 2
      if (
        (!ev.official || !['active', 'deprecated', 'upcoming_deprecation'].includes(ev.official.verdict)) &&
        verifyRec &&
        verifyRec.label === 'ĐÃ-XÁC-NHẬN-NGỪNG' &&
        (verifyRec.l1.absenceCount ?? 0) >= 2 &&
        isOfficialUrlForProvider(prefix, verifyRec.l3.url)
      ) {
        const shutdownMs = parseRemovalEvidenceTimestamp(verifyRec.l3.noticeDate);
        if (shutdownMs !== null && shutdownMs <= officialEvidenceAt) {
          return {
            eligible: true,
            reason: `OFFICIAL_L3_DEPRECATION (${verifyRec.l3.url ?? 'l3'})`,
            sourcePublishedAt: null,
            officialNotice: latchOfficialScan(prefix, modelId,
              JSON.stringify([verifyRec.l3.url, verifyRec.l3.noticeDate]), null, false, shutdownMs),
            sourceFirstChangedAt: firstAbsentAt,
            replacementModelId: null,
          };
        }
      }

      // Path 2: Multi-cycle ABSENT-STABLE (absenceCount >= 3, >= 24h, not in L2)
      const presence = resolveCatalogPresence(provEntry, modelId);
      if (!presence.l1Exists && presence.absenceCount >= 3 && firstAbsentAt) {
        const firstAbsentMs = Date.parse(firstAbsentAt);
        const l2Exists = Boolean(verifyRec?.l2.exists);
        const providerCovered = Boolean(
          verifyRec?.flags.includes('CÒN-Ở-NGUỒN-NGOÀI') || l2Exists
        );
        const baseAsCheck = evaluateAbsentStable({
          id: modelId,
          prefix,
          absenceCount: presence.absenceCount,
          firstAbsentAtMs: Number.isFinite(firstAbsentMs) ? firstAbsentMs : nowMs,
          nowMs,
          lastLabel: provEntry.lastLabel,
          l2ExternalExists: l2Exists,
          providerCoveredByExternal: providerCovered,
          comboStepCount: 10, // per-target shrink cap checked uniformly below
          dropCount: 1,
        });
        if (baseAsCheck.isAbsentStable) {
          return {
            eligible: true,
            reason: `ABSENT_STABLE (absenceCount=${presence.absenceCount})`,
            sourcePublishedAt: null,
            sourceFirstChangedAt: firstAbsentAt,
            replacementModelId: null,
          };
        }
      }

      // Explicit Prohibition (§4.1): secondary-only deprecation NEVER removes
      if (ev.secondary && ev.secondary.verdict === 'deprecated') {
        return {
          eligible: false,
          blockedReason: 'SECONDARY_SOURCE_ONLY',
          reason: `Secondary source (${ev.secondary.url}) cannot authorize model removal without official domain confirmation.`,
          sourcePublishedAt: ev.secondary.publishedAt ?? null,
          sourceFirstChangedAt: firstAbsentAt,
          replacementModelId: ev.secondary.replacementModelId ?? null,
        };
      }

      return {
        eligible: false,
        reason: 'NOT_DEPRECATED_OR_ABSENT_STABLE',
        sourcePublishedAt: null,
        sourceFirstChangedAt: null,
        replacementModelId: null,
      };
    }

    // C45-WP3 §3.2 & §4.2: Multi-Target Plan Generation (Routers + Keyed Harnesses)
    const routerActions: TickRouterPlanAction[] = [];
    const harnessActions: TickHarnessPlanAction[] = [];
    const blockedRemovals: BlockedRemovalRecord[] = [];

    // 1) Evaluate Router Combos
    for (const combo of allCombos) {
      const targetId = `${combo.router}/${combo.name}`;
      const eligibleInCombo: Array<{
        prefix: string;
        modelId: string;
        fullStep: string;
        reason: string;
        sourcePublishedAt: string | null;
        sourceFirstChangedAt: string | null;
        replacementModelId: string | null;
        officialNotice?: OfficialNoticeDetectionRecord | undefined;
      }> = [];

      for (const fullStep of combo.models) {
        const slashIdx = fullStep.indexOf('/');
        if (slashIdx <= 0 || slashIdx >= fullStep.length - 1) continue;
        const prefix = fullStep.slice(0, slashIdx);
        const modelId = fullStep.slice(slashIdx + 1);

        const check = checkRemovalEligibility(prefix, modelId);
        if (check.eligible) {
          eligibleInCombo.push({
            prefix,
            modelId,
            fullStep,
            reason: check.reason,
            sourcePublishedAt: check.sourcePublishedAt,
            sourceFirstChangedAt: check.sourceFirstChangedAt,
            replacementModelId: check.replacementModelId,
            officialNotice: check.officialNotice,
          });
        } else if (check.blockedReason) {
          blockedRemovals.push({
            targetType: 'router',
            targetId,
            provider: prefix,
            modelId,
            blockedReason: check.blockedReason,
            detail: check.reason,
          });
        }
      }

      if (eligibleInCombo.length > 0) {
        const capCheck = enforceTargetShrinkCap(
          'router',
          combo.models.length,
          eligibleInCombo.length
        );
        if (!capCheck.allowed) {
          for (const rem of eligibleInCombo) {
            blockedRemovals.push({
              targetType: 'router',
              targetId,
              provider: rem.prefix,
              modelId: rem.modelId,
              blockedReason: 'SHRINK_CAP_EXCEEDED',
              detail: capCheck.reason ?? 'Router combo shrink > 10%',
            });
            const existingReasons = shrinkBlockReasons.get(rem.prefix) ?? [];
            existingReasons.push(`${rem.modelId}: Hạn mức co rút (${capCheck.reason ?? '> 10%'})`);
            shrinkBlockReasons.set(rem.prefix, existingReasons);
          }
          newInboxCandidates.push({
            id: `shrink-guard-router-${combo.router}-${combo.name}`,
            title: `[SHRINK-GUARD] Router combo ${combo.name} vượt hạn mức gỡ 10% (${eligibleInCombo.length}/${combo.models.length})`,
            type: 'warning',
            timestamp: nowIso,
            body: `Đã chặn tự động gỡ ${eligibleInCombo.length}/${combo.models.length} model trong combo ${combo.name} (${capCheck.reason}). Cần chủ sở hữu duyệt thủ công.`,
            provider: eligibleInCombo[0]!.prefix,
            label: 'SHRINK-GUARD',
            proposed_by: { kind: 'system', source: 'tick' },
          });
        } else {
          const planActionNowMs = readPhaseClock();
          const planActionNowIso = new Date(planActionNowMs).toISOString();
          for (const rem of eligibleInCombo) {
            const isOfficialRemoval = rem.reason.startsWith('OFFICIAL_');
            const epId = !isOfficialRemoval
              ? (catalogState.providers[rem.prefix]?.pendingEpisodes?.[rem.modelId] ??
                `ep-${rem.prefix}-${rem.modelId}-${rem.sourceFirstChangedAt ?? planActionNowIso}`)
              : null;
            const noticeFields = isOfficialRemoval
              ? recordOfficialPlan(rem.officialNotice, planActionNowIso, `router:${combo.router}/${combo.name}`)
              : {};
            const latencyMs = rem.officialNotice?.detectionMs ?? null;
            routerActions.push({
              targetType: 'router',
              router: combo.router,
              comboName: combo.name,
              provider: rem.prefix,
              modelId: rem.modelId,
              fullStep: rem.fullStep,
              action: 'REMOVE_MODEL',
              reason: rem.reason,
              replacementModelId: rem.replacementModelId,
              sourcePublishedAt: rem.sourcePublishedAt,
              sourceFirstChangedAt: rem.sourceFirstChangedAt,
              planCreatedAt: planActionNowIso,
              detectionLatencyMs: latencyMs,
              ...noticeFields,
              detectionKind: isOfficialRemoval ? 'official-notice' : 'absence-settled',
              episodeId: rem.officialNotice?.recordKey ?? epId,
            });

            const alreadyProposed = newInboxCandidates.some(
              (item) =>
                item.action === 'REMOVE_MODEL' &&
                item.provider === rem.prefix &&
                item.modelId === rem.modelId
            );
            if (!alreadyProposed) {
              newInboxCandidates.push({
                id: `official-deprecated-${combo.name}-${rem.prefix}-${rem.modelId}`,
                title: `[ĐÃ-XÁC-NHẬN-NGỪNG] Đề xuất gỡ ${rem.fullStep} khỏi combo ${combo.name}`,
                type: 'proposal',
                timestamp: nowIso,
                body: `Model ${rem.fullStep} đủ điều kiện gỡ an toàn (${rem.reason}; co rút 1/${combo.models.length} <= 10%).`,
                provider: rem.prefix,
                modelId: rem.modelId,
                action: 'REMOVE_MODEL',
                targetTier: 'B',
                label: 'ĐÃ-XÁC-NHẬN-NGỪNG',
                proposed_by: { kind: 'system', source: 'tick' },
              });
            }
          }
        }
      }

      // Router ADD_MODEL plan actions for newly discovered non-blacklisted models
      const prefixesInCombo = new Set(
        combo.models
          .map((m) => (m.includes('/') ? m.slice(0, m.indexOf('/')) : ''))
          .filter(Boolean)
      );
      for (const prefix of prefixesInCombo) {
        const addedSet = addedByPrefix.get(prefix);
        if (!addedSet || addedSet.size === 0) continue;
        const provEntry = catalogState.providers[prefix];
        const rState = getRouterStateFor(combo.router);

        for (const addedId of addedSet) {
          const fullStep = `${prefix}/${addedId}`;
          if (combo.models.includes(fullStep)) continue;
          if (
            isBlacklisted(addedId, blacklistPatterns) ||
            isBlacklisted(fullStep, blacklistPatterns)
          ) {
            continue;
          }
          const verifyRec = verifyRecordsByStep.get(fullStep);
          if (
            verifyRec?.label === 'SẮP-NGỪNG' ||
            verifyRec?.label === 'ĐÃ-XÁC-NHẬN-NGỪNG' ||
            verifyRec?.label === 'QUOTA'
          ) {
            continue;
          }
          const tier = resolveModelTier(prefix, addedId, usedSteps, disabledModels, rState);
          if (tier === 'A' || tier === 'UNKNOWN') continue;

          const ev = findEvidenceForModel(prefix, addedId);
          const sourcePublishedAt = ev.official?.publishedAt ?? null;
          const sourceFirstChangedAt = provEntry?.firstSeenAt?.[addedId] ?? nowIso;
          const actionKind = tier === 'B' ? 'ENABLE_MODEL' : 'ADD_MODEL';

          routerActions.push({
            targetType: 'router',
            router: combo.router,
            comboName: combo.name,
            provider: prefix,
            modelId: addedId,
            fullStep,
            action: actionKind,
            reason: `Discovered in L1 scan (${tier === 'B' ? 'Tier B disabled' : 'Tier C new'})`,
            sourcePublishedAt,
            sourceFirstChangedAt,
            planCreatedAt: nowIso,
            detectionLatencyMs: computeDetectionLatencyMs({
              planCreatedAt: nowIso,
              sourcePublishedAt,
              sourceFirstChangedAt,
            }),
          });
        }
      }
    }

    // 2) Evaluate Keyed Harness Provider Model Lists
    for (const ht of harnessTargets) {
      const defaultSlots = new Set(ht.defaultModels ?? []);
      for (const hp of ht.providers) {
        if (hp.proxyDelegated) continue;

        const targetId = `${ht.harnessId}/${hp.providerId}`;
        const explicitUnverifiable =
          Boolean(hp.unverifiable) || isUnverifiableScanState(hp.unverifiableReason);

        const eligibleInHarness: Array<{
          modelId: string;
          reason: string;
          sourcePublishedAt: string | null;
          sourceFirstChangedAt: string | null;
          replacementModelId: string | null;
          officialNotice?: OfficialNoticeDetectionRecord | undefined;
        }> = [];

        for (const modelId of hp.models) {
          const check = checkRemovalEligibility(hp.providerId, modelId, {
            explicitUnverifiable,
          });
          if (!check.eligible) {
            if (check.blockedReason) {
              blockedRemovals.push({
                targetType: 'harness',
                targetId,
                provider: hp.providerId,
                modelId,
                blockedReason: check.blockedReason,
                detail: check.reason,
              });
            }
            continue;
          }

          const fullStep = `${hp.providerId}/${modelId}`;
          const canonHp = canonicalizeResearchProvider(hp.providerId);
          const hpCatalogEntry = catalogState.providers[hp.providerId];
          const liveIdsForHp = new Set(
            (hpCatalogEntry?.ids ?? []).filter((m) => resolveCatalogPresence(hpCatalogEntry, m).l1Exists)
          );
          const rawRep = check.replacementModelId?.trim();
          const normRep = rawRep
            ? rawRep.startsWith(`${hp.providerId}/`)
              ? rawRep.slice(hp.providerId.length + 1)
              : rawRep.startsWith(`${canonHp}/`) && !liveIdsForHp.has(rawRep)
                ? rawRep.slice(canonHp.length + 1)
                : rawRep
            : undefined;
          const hasLiveReplacement = Boolean(normRep && normRep !== modelId && liveIdsForHp.has(normRep));
          if (
            (defaultSlots.has(modelId) ||
              defaultSlots.has(fullStep) ||
              defaultSlots.has(`${canonHp}/${modelId}`)) &&
            !hasLiveReplacement
          ) {
            blockedRemovals.push({
              targetType: 'harness',
              targetId,
              provider: hp.providerId,
              modelId,
              blockedReason: 'DEFAULT_SLOT_PROTECTED',
              detail: `Model ${fullStep} is an active default slot without a verified replacement.`,
            });
            continue;
          }

          eligibleInHarness.push({
            modelId,
            reason: check.reason,
            sourcePublishedAt: check.sourcePublishedAt,
            sourceFirstChangedAt: check.sourceFirstChangedAt,
            replacementModelId: check.replacementModelId,
            officialNotice: check.officialNotice,
          });
        }

        if (eligibleInHarness.length > 0) {
          const capCheck = enforceTargetShrinkCap(
            'harness',
            hp.models.length,
            eligibleInHarness.length
          );
          if (!capCheck.allowed) {
            for (const rem of eligibleInHarness) {
              blockedRemovals.push({
                targetType: 'harness',
                targetId,
                provider: hp.providerId,
                modelId: rem.modelId,
                blockedReason: 'SHRINK_CAP_EXCEEDED',
                detail: capCheck.reason ?? 'Harness provider shrink > 10%',
              });
            }
            newInboxCandidates.push({
              id: `shrink-guard-harness-${ht.harnessId}-${hp.providerId}`,
              title: `[SHRINK-GUARD] Harness ${ht.harnessId}/${hp.providerId} vượt hạn mức gỡ 10% (${eligibleInHarness.length}/${hp.models.length})`,
              type: 'warning',
              timestamp: nowIso,
              body: `Đã chặn tự động gỡ ${eligibleInHarness.length}/${hp.models.length} model trong ${ht.harnessId} (${hp.providerId}): ${capCheck.reason}. Cần chủ sở hữu duyệt thủ công.`,
              provider: hp.providerId,
              label: 'SHRINK-GUARD',
              proposed_by: { kind: 'system', source: 'tick' },
            });
          } else {
            const planActionNowMs = readPhaseClock();
            const planActionNowIso = new Date(planActionNowMs).toISOString();
            for (const rem of eligibleInHarness) {
              const isOfficialRemoval = rem.reason.startsWith('OFFICIAL_');
              const fullStep = `${hp.providerId}/${rem.modelId}`;
              const epId = !isOfficialRemoval
                ? (catalogState.providers[hp.providerId]?.pendingEpisodes?.[rem.modelId] ??
                  `ep-${hp.providerId}-${rem.modelId}-${rem.sourceFirstChangedAt ?? planActionNowIso}`)
                : null;
              const noticeFields = isOfficialRemoval
                ? recordOfficialPlan(rem.officialNotice, planActionNowIso, `harness:${ht.harnessId}`)
                : {};
              const latencyMs = rem.officialNotice?.detectionMs ?? null;
              harnessActions.push({
                targetType: 'harness',
                harnessId: ht.harnessId,
                configPath: ht.configPath,
                providerId: hp.providerId,
                modelId: rem.modelId,
                action: 'REMOVE_MODEL',
                reason: rem.reason,
                replacementModelId: rem.replacementModelId,
                sourcePublishedAt: rem.sourcePublishedAt,
                sourceFirstChangedAt: rem.sourceFirstChangedAt,
                planCreatedAt: planActionNowIso,
                detectionLatencyMs: latencyMs,
                ...noticeFields,
                detectionKind: isOfficialRemoval ? 'official-notice' : 'absence-settled',
                episodeId: rem.officialNotice?.recordKey ?? epId,
              });
              newInboxCandidates.push({
                id: `harness-remove-${ht.harnessId}-${hp.providerId}-${rem.modelId}`,
                title: `[HARNESS-REMOVE] Đề xuất gỡ ${hp.providerId}/${rem.modelId} khỏi ${ht.harnessId}`,
                type: 'proposal',
                timestamp: nowIso,
                body: `Model ${hp.providerId}/${rem.modelId} đã xác nhận ngừng phục vụ (${rem.reason}). Đề xuất gỡ khỏi ${ht.harnessId}.`,
                provider: hp.providerId,
                modelId: rem.modelId,
                action: 'REMOVE_MODEL',
                targetTier: 'B',
                label: 'ĐÃ-XÁC-NHẬN-NGỪNG',
                proposed_by: { kind: 'system', source: 'tick' },
              });
            }
          }
        }

        // Harness ADD_MODEL actions for newly discovered non-blacklisted models
        if (!explicitUnverifiable) {
          const addedSet = addedByPrefix.get(hp.providerId);
          const provEntry = catalogState.providers[hp.providerId];
          if (addedSet && addedSet.size > 0) {
            for (const addedId of addedSet) {
              const fullStep = `${hp.providerId}/${addedId}`;
              if (hp.models.includes(addedId)) continue;
              if (
                isBlacklisted(addedId, blacklistPatterns) ||
                isBlacklisted(fullStep, blacklistPatterns)
              ) {
                continue;
              }
              const verifyRec = verifyRecordsByStep.get(fullStep);
              if (
                verifyRec?.label === 'SẮP-NGỪNG' ||
                verifyRec?.label === 'ĐÃ-XÁC-NHẬN-NGỪNG' ||
                verifyRec?.label === 'QUOTA'
              ) {
                continue;
              }
              const ev = findEvidenceForModel(hp.providerId, addedId);
              const sourcePublishedAt = ev.official?.publishedAt ?? null;
              const sourceFirstChangedAt = provEntry?.firstSeenAt?.[addedId] ?? nowIso;
              harnessActions.push({
                targetType: 'harness',
                harnessId: ht.harnessId,
                configPath: ht.configPath,
                providerId: hp.providerId,
                modelId: addedId,
                action: 'ADD_MODEL',
                reason: 'Discovered in L1 scan',
                sourcePublishedAt,
                sourceFirstChangedAt,
                planCreatedAt: nowIso,
                detectionLatencyMs: computeDetectionLatencyMs({
                  planCreatedAt: nowIso,
                  sourcePublishedAt,
                  sourceFirstChangedAt,
                }),
              });
            }
          }
        }
      }
    }

    // Stamp consumedAt on newly consumed evidence records
    if (matchedEvidenceRecordIds.size > 0) {
      let didStampEvidence = false;
      const stamped = evidenceRecords.map((rec) => {
        if (rec.consumedAt === null && matchedEvidenceRecordIds.has(rec.recordId)) {
          didStampEvidence = true;
          return { ...rec, consumedAt: nowIso };
        }
        return rec;
      });
      if (didStampEvidence) {
        saveResearchEvidence(sDir, stamped);
      }
    }

    // C45-WP3 §3.3: Build deterministic 4-trigger <stateDir>/research-queue.json
    const prevQueueFile = loadResearchQueue(sDir);
    const prevFirstQueuedById = new Map<string, string>();
    if (prevQueueFile) {
      for (const item of prevQueueFile.items) {
        prevFirstQueuedById.set(item.queueId, item.firstQueuedAt);
      }
    }

    for (const notice of officialNoticeDetections) {
      if (completedAt(notice)) continue;
      const current = findEvidenceForModel(notice.provider, notice.modelId).official;
      if (current && !isSyntheticNotice(current) &&
          (current.verdict === 'active' || current.verdict === 'upcoming_deprecation' ||
            (current.verdict === 'deprecated' &&
              (parseRemovalEvidenceTimestamp(current.shutdownDate) ?? 0) > nowMs)) &&
          Date.parse(current.submittedAt) > Date.parse(notice.firstQualifyingScanStartedAt)) {
        const planAt = parseRemovalEvidenceTimestamp(notice.firstPlanCreatedAt);
        if (planAt !== null && Date.parse(current.submittedAt) < planAt) continue;
        if (current.verdict === 'active') notice.withdrawnAt = current.submittedAt;
        else notice.supersededAt = current.submittedAt;
      }
    }
    catalogState.officialNoticeDetections = officialNoticeDetections;
    catalogState.detectionHistoryError = detectionHistoryCapExceeded ? 'DETECTION_HISTORY_CAP_EXCEEDED' : undefined;
    atomicWriteFileSync(catalogPath, JSON.stringify(catalogState, null, 2));
    if (detectionHistoryCapExceeded) {
      newInboxCandidates.push({
        id: 'detection-history-cap-exceeded',
        title: '[AUTO-SAFE-BLOCKED] DETECTION_HISTORY_CAP_EXCEEDED',
        type: 'warning',
        timestamp: nowIso,
        body: 'Detection history is full. Existing evidence was preserved and auto-safe writes were blocked.',
        label: 'INVARIANT-BLOCKED',
        proposed_by: { kind: 'system', source: 'tick' },
      });
    }

    const nextQueueMap = new Map<string, ResearchQueueItem>();
    function upsertQueueItem(params: {
      queueId: string;
      id: string;
      prefix: string;
      modelId: string | null;
      label: string;
      reason: ResearchQueueReason;
      extraMissing?: string[];
      targets: string[];
      verifiedAt: string | null;
    }): void {
      const existing = nextQueueMap.get(params.queueId);
      if (existing) {
        if (!existing.reasons.includes(params.reason)) {
          existing.reasons.push(params.reason);
        }
        for (const m of [params.reason, ...(params.extraMissing ?? [])]) {
          if (!existing.missing.includes(m)) existing.missing.push(m);
        }
        for (const t of params.targets) {
          if (!existing.targetsAffected.includes(t)) existing.targetsAffected.push(t);
        }
        return;
      }
      const missing = [...new Set([params.reason, ...(params.extraMissing ?? [])])];
      nextQueueMap.set(params.queueId, {
        queueId: params.queueId,
        id: params.id,
        prefix: params.prefix,
        modelId: params.modelId,
        label: params.label,
        reasons: [params.reason],
        missing,
        targetsAffected: [...new Set(params.targets)].sort(),
        firstQueuedAt: prevFirstQueuedById.get(params.queueId) ?? nowIso,
        updatedAt: nowIso,
        verifiedAt: params.verifiedAt,
      });
    }

    // Trigger 1: NO_MODEL_LIST_API (active keyed provider with missing-param / unknown-prefix / no list URL)
    for (const t of targets) {
      const hasNoListApi =
        t.skipReason === 'missing-param' ||
        t.skipReason === 'unknown-prefix' ||
        (!t.baseUrl &&
          t.keySource !== 'none' &&
          t.skipReason !== 'no-key' &&
          t.skipReason !== 'oauth-router-managed' &&
          t.skipReason !== 'key-encrypted');
      if (!hasNoListApi) continue;

      const canon = canonicalizeResearchProvider(t.prefix);
      const resolvedByOfficial = evidenceRecords.some(
        (ev) =>
          ev.provider === canon &&
          ev.sourceTier === 'official' &&
          ev.domainVerified &&
          ev.verdict !== 'inconclusive'
      );
      if (resolvedByOfficial) continue;

      const queueId = `${t.prefix}/*`;
      upsertQueueItem({
        queueId,
        id: queueId,
        prefix: t.prefix,
        modelId: null,
        label: 'CHƯA-QUÉT',
        reason: 'NO_MODEL_LIST_API',
        targets: [...(targetsByPrefix.get(t.prefix) ?? new Set([`router:${t.router}`]))],
        verifiedAt: null,
      });
    }

    // Precompute normalized L1 & L2 keys per provider for CROSS_SOURCE_ID_CONFLICT
    const l2NormKeysByProvider = new Map<string, Map<string, string>>();
    for (const l2Key of Object.keys(l2Res.state.models)) {
      const slash = l2Key.indexOf('/');
      if (slash <= 0) continue;
      const p = l2Key.slice(0, slash).toLowerCase();
      const m = l2Key.slice(slash + 1);
      const bucket = l2NormKeysByProvider.get(p) ?? new Map<string, string>();
      bucket.set(normalizeModelKey(m), m);
      l2NormKeysByProvider.set(p, bucket);
    }

    // Triggers 2, 3, 4 on verified model records (strictly excluding 429/5xx/401/unscanned transport failures)
    for (const [fullStep, rec] of verifyRecordsByStep.entries()) {
      const provEntry = catalogState.providers[rec.prefix];
      const isTransportOrUnscanned =
        Boolean(rec.unscannedReason) ||
        rec.label === 'CHƯA-QUÉT' ||
        rec.label === 'QUOTA' ||
        rec.label === 'QUOTA-NO-LIST' ||
        !provEntry ||
        provEntry.lastStatus === 0 ||
        (provEntry.lastStatus >= 400 && provEntry.lastStatus !== 404);
      if (isTransportOrUnscanned) continue;

      const ev = findEvidenceForModel(rec.prefix, rec.id);
      const isActiveTargetModel = targetsByStep.has(fullStep);
      const isAddedCandidate = addedByPrefix.get(rec.prefix)?.has(rec.id) ?? false;
      const affectedTargets = [
        ...(targetsByStep.get(fullStep) ?? targetsByPrefix.get(rec.prefix) ?? new Set<string>()),
      ];

      // Trigger 2: AMBIGUOUS_DEPRECATION
      if (isActiveTargetModel) {
        const hasOfficialLifecycleVerdict = Boolean(
          ev.official &&
            (ev.official.verdict === 'deprecated' ||
              ev.official.verdict === 'upcoming_deprecation' ||
              ev.official.verdict === 'active')
        );
        const l3LifecycleNotice =
          rec.l3.hasNotice &&
          (rec.l3.noticeType === 'upcoming_deprecation' || rec.l3.noticeType === 'deprecated');
        const l3AlreadyConfirmedOfficial =
          rec.label === 'ĐÃ-XÁC-NHẬN-NGỪNG' &&
          Boolean(rec.l3.noticeDate) &&
          isOfficialUrlForProvider(rec.prefix, rec.l3.url);
        const secondaryLifecycleClaim = Boolean(
          ev.secondary &&
            (ev.secondary.verdict === 'deprecated' ||
              ev.secondary.verdict === 'upcoming_deprecation')
        );

        if (
          !hasOfficialLifecycleVerdict &&
          ((l3LifecycleNotice && (!rec.l3.noticeDate || !l3AlreadyConfirmedOfficial)) ||
            secondaryLifecycleClaim)
        ) {
          upsertQueueItem({
            queueId: fullStep,
            id: fullStep,
            prefix: rec.prefix,
            modelId: rec.id,
            label: rec.label,
            reason: 'AMBIGUOUS_DEPRECATION',
            extraMissing: rec.l3.hasNotice ? ['L3_NOTICE'] : [],
            targets: affectedTargets,
            verifiedAt: rec.verifiedAt,
          });
        }
      }

      // Trigger 3: UNKNOWN_PRICING_TIER (newly added candidates with hidden-zero, single-source-zero, or missing price)
      if (isAddedCandidate && rec.l1.exists) {
        const hasOfficialPricing = Boolean(
          ev.official &&
            (ev.official.verdict === 'pricing_confirmed' || ev.official.verdict === 'deprecated')
        );
        const unknownPricing =
          rec.l2.price === null ||
          rec.l2.isZeroPriceHidden ||
          (rec.l2.price === 0 && rec.l2.source !== 'both');
        if (!hasOfficialPricing && unknownPricing) {
          upsertQueueItem({
            queueId: fullStep,
            id: fullStep,
            prefix: rec.prefix,
            modelId: rec.id,
            label: rec.label,
            reason: 'UNKNOWN_PRICING_TIER',
            targets: affectedTargets,
            verifiedAt: rec.verifiedAt,
          });
        }
      }

      // Trigger 4: CROSS_SOURCE_ID_CONFLICT
      if (isActiveTargetModel) {
        const hasOfficialResolution = Boolean(
          ev.official &&
            (ev.official.verdict === 'id_resolved' ||
              ev.official.verdict === 'active' ||
              ev.official.verdict === 'deprecated' ||
              ev.official.verdict === 'upcoming_deprecation')
        );
        if (!hasOfficialResolution) {
          const absentL1PresentL2 = !rec.l1.exists && rec.l2.exists;
          const pastL3NoticeMs = rec.l3.noticeDate ? Date.parse(rec.l3.noticeDate) : Number.NaN;
          const presentL1PastDeprecatedL3 =
            rec.l1.exists &&
            rec.l3.hasNotice &&
            rec.l3.noticeType === 'deprecated' &&
            Number.isFinite(pastL3NoticeMs) &&
            pastL3NoticeMs <= nowMs;

          const aliasPrefix = PROVIDER_ALIASES[rec.prefix.toLowerCase()] ?? rec.prefix.toLowerCase();
          const l2Bucket =
            l2NormKeysByProvider.get(rec.prefix.toLowerCase()) ??
            l2NormKeysByProvider.get(aliasPrefix);
          const matchedCanonId = l2Bucket?.get(normalizeModelKey(rec.id));
          const divergentIdConflict = Boolean(matchedCanonId && matchedCanonId !== rec.id);

          if (absentL1PresentL2 || presentL1PastDeprecatedL3 || divergentIdConflict) {
            upsertQueueItem({
              queueId: fullStep,
              id: fullStep,
              prefix: rec.prefix,
              modelId: rec.id,
              label: rec.label,
              reason: 'CROSS_SOURCE_ID_CONFLICT',
              extraMissing: !rec.l1.exists ? ['L1_ABSENT'] : [],
              targets: affectedTargets,
              verifiedAt: rec.verifiedAt,
            });
          }
        }
      }
    }

    const nextQueueItems = [...nextQueueMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    const nextQueueFile: ResearchQueueFile = {
      version: 1,
      updatedAt: nowIso,
      items: nextQueueItems,
    };
    saveResearchQueue(sDir, nextQueueFile);
    const researchQueueCount = nextQueueItems.length;

    // Persist deterministic <plansDir>/tick-plan.json
    const detectionLatency = summarizeDetectionLatencies([
      ...newAbsenceDetectionsThisTick.map((d) => d.detectionMs),
      ...newOfficialDetectionSamples,
      ...routerActions.filter((a) => a.detectionKind !== 'official-notice').map((a) => a.detectionLatencyMs),
      ...harnessActions.filter((a) => a.detectionKind !== 'official-notice').map((a) => a.detectionLatencyMs),
    ]);
    const planCreatedAtFinalIso = new Date(
      readPhaseClock()
    ).toISOString();
    const planHash =
      computeCanonicalTickPlanHash({
        routerActions,
        harnessActions,
      }) ?? createHash('sha256').update('[]').digest('hex').slice(0, 16);
    const tickPlan: TickPlanFile = {
      version: 1,
      mode: effectiveMode,
      planCreatedAt: planCreatedAtFinalIso,
      planHash,
      accounting: {
        requests: totalRequests,
        paidRequests: 0,
        tokens: 0,
        llmCalls: 0,
      },
      routerActions,
      harnessActions,
      blockedRemovals,
      detectionLatency,
    };
    atomicWriteFileSync(tickPlanPath, JSON.stringify(tickPlan, null, 2));

    const autoSafeWebhookAlerts: ActionableWebhookAlert[] = [];
    const removalEvidence = (
      provider: string,
      modelId: string,
      reason: string,
      appliedIso: string
    ): RemovedModelReceiptEvidence => {
      // Use the same provider catalog persisted for this tick, before a later scan
      // can overwrite the evidence used for this removal.
      const entry = catalogState.providers[provider];
      const entryPresence = resolveCatalogPresence(entry, modelId);
      const inProviderCatalog =
        entry &&
        [200, 304].includes(entry.lastStatus) &&
        !entryPresence.scanFailed &&
        !isUnverifiableScanState(entry.lastLabel) &&
        Array.isArray(entry.ids)
          ? entryPresence.l1Exists
          : null;
      const removalPath = reason.startsWith('OFFICIAL_') ? 'official-notice' : 'absence-only';
      const qualifyingScanCount = entry?.absenceCounts?.[modelId] ?? 0;

      if (removalPath === 'official-notice') {
        const ev = findEvidenceForModel(provider, modelId);
        const verifyRec = verifyRecordsByStep.get(`${provider}/${modelId}`);
        const isLedgerOfficial = reason.startsWith('OFFICIAL_DEPRECATION') && Boolean(ev.official);
        const officialDomainVerified = isLedgerOfficial
          ? Boolean(ev.official!.sourceTier === 'official' && ev.official!.domainVerified)
          : isOfficialUrlForProvider(provider, verifyRec?.l3.url);
        const officialPublishedAt = isLedgerOfficial ? ev.official!.publishedAt : null;
        const officialShutdownDate = isLedgerOfficial
          ? (ev.official!.shutdownDate ?? null)
          : (verifyRec?.l3.noticeDate ?? null);
        const syntheticNotice = isLedgerOfficial
          ? isSyntheticNotice(ev.official!)
          : false;
        const firstObservedAbsentAt =
          entry?.firstAbsentAt?.[modelId] ?? officialPublishedAt ?? appliedIso;
        const removalSettleMs =
          firstObservedAbsentAt && Number.isFinite(Date.parse(firstObservedAbsentAt))
            ? Date.parse(appliedIso) - Date.parse(firstObservedAbsentAt)
            : null;
        return {
          provider,
          modelId,
          inProviderCatalog,
          removalPath,
          firstObservedAbsentAt,
          removedAt: appliedIso,
          removalSettleMs,
          qualifyingScanCount,
          officialDomainVerified,
          officialPublishedAt,
          officialShutdownDate,
          syntheticNotice,
        };
      }

      const firstObservedAbsentAt = entry?.firstAbsentAt?.[modelId] ?? null;
      const removalSettleMs =
        firstObservedAbsentAt && Number.isFinite(Date.parse(firstObservedAbsentAt))
          ? Date.parse(appliedIso) - Date.parse(firstObservedAbsentAt)
          : null;
      return {
        provider,
        modelId,
        inProviderCatalog,
        removalPath,
        firstObservedAbsentAt,
        removedAt: appliedIso,
        removalSettleMs,
        qualifyingScanCount,
      };
    };

    // C45-WP4 §3.1: Controlled auto-safe execution phase (strictly gated per target)
    if (effectiveMode === 'auto-safe' && !detectionHistoryCapExceeded) {
      const consent = readStandingConsent(sDir, nowMs);
      if (consent.valid && consent.activeTargets.length > 0) {
        let autoSafeCircuitTripped = false;
        const sanitizeRollbackDetail = (rawDetail: unknown): string => {
          const base = sanitizeUntrustedString(
            rawDetail instanceof Error
              ? rawDetail.message
              : typeof rawDetail === 'string' && rawDetail.trim().length > 0
                ? rawDetail
                : 'post-write verification failed',
            240
          );
          return base
            .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, '<redacted-path>')
            .replace(/\/(?:Users|home)\/[^/\s"']+/g, '<redacted-path>');
        };
        const recordAutoSafeRollbackAndTripFreeze = (
          targetScope: string,
          idSuffix: string,
          rawDetail: unknown,
          rolledBack: boolean
        ): void => {
          const cleanDetail = sanitizeRollbackDetail(rawDetail);
          const action = rolledBack ? 'Rolled back' : 'Rollback unconfirmed for';
          const title = `[AUTO-ROLLBACK] ${action} ${targetScope} (planHash=${planHash})`;
          newInboxCandidates.push({
            id: `auto-rollback-${idSuffix}-${planHash}`,
            title,
            type: 'warning',
            timestamp: nowIso,
            body: `Auto-safe update on ${targetScope} tripped emergency freeze (${cleanDetail}).`,
            label: 'AUTO-ROLLBACK',
            proposed_by: { kind: 'system', source: 'tick' },
          });
          autoSafeWebhookAlerts.push({
            kind: 'auto_rollback',
            providerOrRouter: targetScope,
            code: 'AUTO_ROLLBACK',
            message: `${title}: ${cleanDetail}`,
          });
          activateFreeze(sDir, 'auto-rollback-circuit-breaker', nowMs);
          autoSafeCircuitTripped = true;
        };

        const autoSafeTargets = new Set(
          consent.activeTargets
            .filter((entry) => entry.level === 'auto-safe')
            .map((entry) => entry.target)
        );
        const pendingRemovals = [...routerActions, ...harnessActions].filter(
          (action) => action.action === 'REMOVE_MODEL'
        );
        const removalProofs = new Map<
          TickRouterPlanAction | TickHarnessPlanAction,
          RemovedModelReceiptEvidence
        >();
        const hasPendingRemovals = pendingRemovals.length > 0 && autoSafeTargets.size > 0;
        // Reuse the validated write-boundary timestamp when signing the receipt.
        const writeStartedAt = new Date(hasPendingRemovals ? readPhaseClock() : nowMs);
        const writeStartedMs = writeStartedAt.getTime();
        const writeStartedIso = Number.isFinite(writeStartedMs) ? writeStartedAt.toISOString() : nowIso;
        if (hasPendingRemovals) {
          if (!Number.isFinite(writeStartedMs) ||
              writeStartedMs < Math.max(nowMs, Date.parse(planCreatedAtFinalIso))) {
            autoSafeCircuitTripped = true;
          } else {
            for (const action of pendingRemovals) {
              const provider = action.targetType === 'router' ? action.provider : action.providerId;
              const proof = removalEvidence(provider, action.modelId, action.reason, writeStartedIso);
              const scanCount = proof.qualifyingScanCount;
              if (deriveRemovalSettlementMs(proof, writeStartedIso, { allowSyntheticFixture: allowSyntheticNoticeFixture }) === null ||
                  scanCount === undefined || !Number.isSafeInteger(scanCount) || scanCount < 0) {
                autoSafeCircuitTripped = true;
                break;
              }
              removalProofs.set(action, {
                ...proof,
                ...(action.evidenceId ? { detectionEvidenceId: action.evidenceId } : {}),
                ...(action.episodeId ? { detectionEpisodeId: action.episodeId } : {}),
              });
            }
          }
          if (autoSafeCircuitTripped) {
            newInboxCandidates.push({
              id: `auto-safe-removal-evidence-invalid-${planHash}`,
              title: '[AUTO-SAFE-BLOCKED] REMOVAL_EVIDENCE_INVALID',
              type: 'warning',
              timestamp: nowIso,
              body: 'Removal settlement evidence or the pre-write clock failed validation. No target changed.',
              label: 'INVARIANT-BLOCKED',
              proposed_by: { kind: 'system', source: 'tick' },
            });
          }
        }
        const configDir = path.dirname(path.resolve(resolveConfigFilePath(options.configPath)));

        // 1. Router combo auto-safe execution
        const groupedRouterActions = new Map<
          string,
          { routerKey: string; comboName: string; actions: TickRouterPlanAction[] }
        >();
        for (const action of routerActions) {
          const gKey = `${action.router}::${action.comboName}`;
          const existing = groupedRouterActions.get(gKey);
          if (existing) {
            existing.actions.push(action);
          } else {
            groupedRouterActions.set(gKey, {
              routerKey: action.router,
              comboName: action.comboName,
              actions: [action],
            });
          }
        }

        for (const group of groupedRouterActions.values()) {
          if (autoSafeCircuitTripped) break;
          const routerCfg = config.routers.find(
            (r) => r.id === group.routerKey || r.adapter === group.routerKey
          );
          if (!routerCfg) continue;

          const primaryScope = `router:${routerCfg.id}/${group.comboName}`;
          const adapterScope = `router:${routerCfg.adapter}/${group.comboName}`;
          const matchedScope = autoSafeTargets.has(primaryScope)
            ? primaryScope
            : autoSafeTargets.has(adapterScope)
              ? adapterScope
              : null;
          if (!matchedScope) continue;

          // Defense-in-depth C45 §3.2 runtime gate (kills M1)
          try {
            assertEligibleForAutoSafe(sDir, matchedScope);
          } catch {
            continue;
          }

          const dbPath = resolveRouterDbPath(routerCfg, configDir);
          assertControlledWriteSandbox(dbPath, 'router-db');

          const adapter = createAdapterForRouter(routerCfg, sDir);
          const liveCombos = await adapter.readCombos();
          const liveCombo = liveCombos.find(
            (c) => c.name === group.comboName || c.id === group.comboName
          );
          if (!liveCombo) continue;

          const removeSteps = new Set(
            group.actions.filter((a) => a.action === 'REMOVE_MODEL').map((a) => a.fullStep)
          );
          const addSteps = group.actions
            .filter((a) => a.action === 'ADD_MODEL' || a.action === 'ENABLE_MODEL')
            .map((a) => a.fullStep);

          const nextModels = liveCombo.models.filter((m) => !removeSteps.has(m));
          for (const step of addSteps) {
            if (!nextModels.includes(step)) nextModels.push(step);
          }

          if (
            nextModels.length === liveCombo.models.length &&
            nextModels.every((m, idx) => m === liveCombo.models[idx])
          ) {
            continue;
          }

          const managedSpec = config.combos.find(
            (c) => c.name === group.comboName && c.routers.includes(routerCfg.id)
          );
          let dbKindFree = false;
          try {
            const roDb = openBetterSqlite3(dbPath, { readOnly: true, busyTimeoutMs: 2000 });
            try {
              const row = roDb
                .prepare('SELECT kind FROM combos WHERE name = ? OR id = ?')
                .get(group.comboName, group.comboName) as { kind?: string | null } | undefined;
              dbKindFree = row?.kind === 'free';
            } finally {
              roDb.close();
            }
          } catch {
            // ignore
          }
          const freeOnly = Boolean(
            managedSpec?.constraints?.freeOnly ||
              (liveCombo as { freeOnly?: boolean }).freeOnly ||
              dbKindFree
          );

          const modifiedCombo: ComboDefinition = {
            ...liveCombo,
            models: nextModels,
            managed: Boolean(managedSpec) || Boolean(liveCombo.managed),
            freeOnly,
          };
          const postCombos = liveCombos.map((c) =>
            c.id === liveCombo.id || c.name === liveCombo.name ? modifiedCombo : c
          );

          const allReferencedSteps = new Set<string>();
          for (const c of postCombos) {
            for (const m of c.models) allReferencedSteps.add(m);
          }

          const catalog: ModelInfo[] = [...allReferencedSteps].map((step) => {
            const slash = step.indexOf('/');
            const prov = slash > 0 ? step.slice(0, slash) : 'unknown';
            const modId = slash > 0 ? step.slice(slash + 1) : step;
            const l2Entry =
              l2Res.state.models[step] ??
              l2Res.state.models[`${PROVIDER_ALIASES[prov.toLowerCase()] ?? prov}/${modId}`];
            const ev = findEvidenceForModel(prov, modId);

            let pricing: ModelInfo['pricing'] = undefined;
            if (ev.official?.verdict === 'pricing_confirmed') {
              pricing = { promptCostPerToken: 0, completionCostPerToken: 0 };
            } else if (l2Entry && l2Entry.price !== null && l2Entry.price !== undefined) {
              if (l2Entry.price > 0) {
                pricing = {
                  promptCostPerToken: l2Entry.price / 1_000_000,
                  completionCostPerToken: l2Entry.price / 1_000_000,
                };
              } else if (!l2Entry.isZeroPriceHidden && l2Entry.source === 'both') {
                pricing = { promptCostPerToken: 0, completionCostPerToken: 0 };
              }
            } else if (!freeOnly) {
              pricing = { promptCostPerToken: 0, completionCostPerToken: 0 };
            }

            return {
              id: step,
              name: modId,
              provider: prov,
              contextLength: 128000,
              status: 'active',
              capabilities: { functionCalling: true, streaming: true, vision: false },
              ...(pricing ? { pricing } : {}),
            };
          });

          const singlePlan: Plan = {
            id: `tick-auto-safe-${planHash}-${group.comboName}`,
            target: routerCfg.id,
            timestamp: nowIso,
            additions: [],
            modifications: [modifiedCombo],
            deletions: [],
            reasons: { [liveCombo.id]: `tick-auto-safe:${planHash}` },
          };

          const adoptedSet = new Set<string>([
            group.comboName,
            ...(config.adopt ?? [])
              .filter((a) => a.router === routerCfg.id)
              .map((a) => a.name),
          ]);

          // Mandatory I1..I8 pre-flight invariant check (kills M6)
          const inv = validateInvariants({
            combos: postCombos,
            catalog,
            plan: singlePlan,
            adoptedCombos: Array.from(adoptedSet),
            writeSequence: ['providers', 'models', 'combos', 'defaultSlots'],
          });
          if (!inv.valid) {
            newInboxCandidates.push({
              id: `auto-safe-blocked-inv-${group.comboName}-${planHash}`,
              title: `[AUTO-SAFE-BLOCKED] Invariant violation on ${matchedScope}`,
              type: 'warning',
              timestamp: nowIso,
              body: inv.violations.map((v) => `${v.code}: ${v.message}`).join('; '),
              label: 'INVARIANT-BLOCKED',
              proposed_by: { kind: 'system', source: 'tick' },
            });
            continue;
          }

          const removedModels = group.actions
            .filter((action) => action.action === 'REMOVE_MODEL' &&
              liveCombo.models.includes(action.fullStep) && !nextModels.includes(action.fullStep))
            .map((action) => removalProofs.get(action)!);
          const snapshot = await adapter.createSnapshot();
          snapshot.metadata = {
            ...(snapshot.metadata ?? {}),
            touchedComboIds: [
              ...singlePlan.additions.map((a) => a.id),
              ...singlePlan.modifications.map((m) => m.id),
              ...singlePlan.deletions,
            ],
          };
          saveSnapshot(snapshot, sDir);
          const applyRes = await applyPlanSafe(adapter, singlePlan, { dryRun: false });

          // I4 post-apply idempotency check
          let i4Verified = Boolean(applyRes.success && applyRes.readBackVerified);
          let rolledBack = applyRes.rollbackExecuted === true;
          if (i4Verified) {
            try {
              const afterCombos = await adapter.readCombos();
              const rePlan = planCombos(
                afterCombos.filter((c) => c.name === group.comboName || c.id === group.comboName),
                catalog,
                [
                  {
                    comboId: liveCombo.id,
                    name: group.comboName,
                    strategy: liveCombo.strategy ?? 'priority',
                    minSteps: 2,
                    freeOnly,
                    requiredCapabilities: [],
                    excludedModels: [],
                    pinnedModels: nextModels,
                    maxSteps: Math.max(5, nextModels.length),
                  },
                ],
                {
                  target: routerCfg.id,
                  adopt: Array.from(adoptedSet).map((name) => ({ name, mode: 'full' })),
                }
              );
              if (
                rePlan.additions.length > 0 ||
                rePlan.modifications.length > 0 ||
                rePlan.deletions.length > 0
              ) {
                i4Verified = false;
              }
            } catch {
              i4Verified = false;
            }
            if (!i4Verified) rolledBack = await adapter.rollback(snapshot).catch(() => false);
          }

          const finalSuccess = Boolean(applyRes.success && i4Verified);
          appendApplyReceipt(sDir, {
            target: matchedScope,
            planHash,
            appliedAt: writeStartedIso,
            appliedAtLevel: 'auto-safe',
            authorizedVia: 'standing-consent',
            success: finalSuccess,
            readBackVerified: i4Verified,
            readBackLevel: applyRes.readBackLevel ?? 'db-only',
            rolledBack,
            snapshotOrBackupRef: snapshot.id,
            removedModels: finalSuccess && !rolledBack ? removedModels : [],
          }, { allowSyntheticFixture: allowSyntheticNoticeFixture });
          if (finalSuccess && !rolledBack) markRemovalCompleted(removedModels, writeStartedIso);

          if (finalSuccess) {
            newInboxCandidates.push({
              id: `auto-safe-applied-${group.comboName}-${planHash}`,
              title: `[AUTO-SAFE-APPLIED] Updated ${matchedScope} (planHash=${planHash})`,
              type: 'info',
              timestamp: nowIso,
              body: `Applied ${group.actions.length} verified action(s) to ${matchedScope}.`,
              label: 'AUTO-SAFE-APPLIED',
              proposed_by: { kind: 'system', source: 'tick' },
            });
            autoSafeWebhookAlerts.push({
              kind: 'auto_safe_applied',
              providerOrRouter: matchedScope,
              code: 'AUTO_SAFE_APPLIED',
              message: `[AUTO-SAFE-APPLIED] Updated ${matchedScope} (planHash=${planHash})`,
            });
          } else {
            recordAutoSafeRollbackAndTripFreeze(
              matchedScope,
              `router-${group.comboName}`,
              applyRes.error ?? 'router post-write read-back or I4 idempotency check failed',
              rolledBack
            );
            break;
          }
        }

        // 2. Harness config auto-safe execution
        const groupedHarnessActions = new Map<string, TickHarnessPlanAction[]>();
        for (const hAct of harnessActions) {
          const list = groupedHarnessActions.get(hAct.harnessId) ?? [];
          list.push(hAct);
          groupedHarnessActions.set(hAct.harnessId, list);
        }

        for (const [harnessId, hActions] of groupedHarnessActions.entries()) {
          if (autoSafeCircuitTripped) break;
          const targetScope = `harness:${harnessId}`;
          if (!autoSafeTargets.has(targetScope)) continue;
          try {
            assertEligibleForAutoSafe(sDir, targetScope);
          } catch {
            continue;
          }
          const writeAdapter = HARNESS_WRITE_ADAPTERS.find((w) => w.app === harnessId && w.directionAMode === 'write-adapter');
          const cfgFile = hActions[0]?.configPath;
          if (!writeAdapter || !cfgFile) continue;

          assertControlledWriteSandbox(cfgFile, 'harness-config');
          const ht = harnessTargets.find((x) => x.harnessId === harnessId);
          const harnessCatalog: Record<string, { liveModels: string[]; deprecatedModels: string[] }> = {};
          for (const hp of ht?.providers ?? []) {
            const rems = hActions
              .filter((a) => a.providerId === hp.providerId && a.action === 'REMOVE_MODEL')
              .map((a) => a.modelId);
            const adds = hActions
              .filter((a) => a.providerId === hp.providerId && a.action === 'ADD_MODEL')
              .map((a) => a.modelId);
            harnessCatalog[hp.providerId] = {
              liveModels: [...hp.models.filter((m) => !rems.includes(m)), ...adds],
              deprecatedModels: rems,
            };
          }

          let rolledBack = false;
          try {
            const explicitTickHome =
              options.homeDir ?? (options.env ?? process.env)['ROUTERSYNC_HOME'];
            const homeDir = resolveEffectiveHarnessHomeDir(cfgFile, explicitTickHome);
            const harnessPlan = await writeAdapter.plan({ configPath: cfgFile, homeDir, catalog: harnessCatalog });
            const removedModels = harnessPlan.removals.map((removal) => {
              const action = hActions.find((candidate) =>
                candidate.action === 'REMOVE_MODEL' &&
                candidate.providerId === removal.provider && candidate.modelId === removal.model
              );
              const proof = action ? removalProofs.get(action) : undefined;
              if (!proof) throw new Error('REMOVAL_EVIDENCE_INVALID: Harness plan removal has no validated evidence.');
              return proof;
            });
            const hRes = await writeAdapter.apply({
              configPath: cfgFile,
              homeDir,
              catalog: harnessCatalog,
              expectedPlanHash: harnessPlan.planHash,
            });
            rolledBack = hRes.rolledBack;
            appendApplyReceipt(sDir, {
              target: targetScope,
              planHash,
              appliedAt: writeStartedIso,
              appliedAtLevel: 'auto-safe',
              authorizedVia: 'standing-consent',
              success: hRes.applied && !hRes.rolledBack,
              readBackVerified: hRes.readBackVerified,
              readBackLevel: 'file-byte-verified',
              rolledBack: hRes.rolledBack,
              snapshotOrBackupRef: hRes.backupPath,
              preDigest: hRes.preSha256,
              postDigest: hRes.postSha256,
              removedModels: hRes.applied && hRes.readBackVerified && !rolledBack ? removedModels : [],
            }, { allowSyntheticFixture: allowSyntheticNoticeFixture });
            if (hRes.applied && hRes.readBackVerified && !rolledBack) markRemovalCompleted(removedModels, writeStartedIso);
            if (hRes.applied && !hRes.rolledBack) {
              newInboxCandidates.push({
                id: `auto-safe-applied-harness-${harnessId}-${planHash}`,
                title: `[AUTO-SAFE-APPLIED] Updated ${targetScope} (planHash=${planHash})`,
                type: 'info',
                timestamp: nowIso,
                body: `Applied ${hActions.length} verified model list change(s) to ${targetScope}.`,
                label: 'AUTO-SAFE-APPLIED',
                proposed_by: { kind: 'system', source: 'tick' },
              });
              autoSafeWebhookAlerts.push({
                kind: 'auto_safe_applied',
                providerOrRouter: targetScope,
                code: 'AUTO_SAFE_APPLIED',
                message: `[AUTO-SAFE-APPLIED] Updated ${targetScope} (planHash=${planHash})`,
              });
            } else if (hRes.rolledBack || !hRes.readBackVerified) {
              recordAutoSafeRollbackAndTripFreeze(
                targetScope,
                `harness-${harnessId}`,
                'harness post-write byte/semantic verification failed',
                rolledBack
              );
              break;
            }
          } catch (err) {
            appendApplyReceipt(sDir, {
              target: targetScope,
              planHash,
              appliedAt: writeStartedIso,
              appliedAtLevel: 'auto-safe',
              authorizedVia: 'standing-consent',
              success: false,
              readBackVerified: false,
              readBackLevel: 'file-byte-verified',
              rolledBack,
              snapshotOrBackupRef: `${cfgFile}.routersync.bak`,
            });
            recordAutoSafeRollbackAndTripFreeze(targetScope, `harness-${harnessId}`, err, rolledBack);
            break;
          }
        }
      }
    }

    if (completionChanged) atomicWriteFileSync(catalogPath, JSON.stringify(catalogState, null, 2));
    let inboxAdded = 0;
    const newlyAddedInboxItems: TickInboxItem[] = [];
    if (effectiveMode === 'propose' || effectiveMode === 'auto-safe' || detectionHistoryCapExceeded) {
      const existingInbox = loadInboxItems(inboxPath);
      const existingIds = new Set(existingInbox.map((i) => i.id));
      for (const item of newInboxCandidates) {
        if (!existingIds.has(item.id)) {
          existingInbox.unshift(item);
          existingIds.add(item.id);
          newlyAddedInboxItems.push(item);
          inboxAdded++;
        }
      }
      if (inboxAdded > 0 || !fs.existsSync(inboxPath) || existingInbox.length > 200) {
        const nowMsTick = nowMs;
        const isActive = (item: TickInboxItem) => {
          const st = item.status;
          if (st === 'acknowledged') return false;
          if (st === 'snoozed') {
            const snoozeMs = item.snoozeUntil ? Date.parse(item.snoozeUntil) : Number.NaN;
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
        atomicWriteFileSync(
          inboxPath,
          JSON.stringify({ updatedAt: nowIso, items: itemsToWrite }, null, 2)
        );
      }
    }

    const envSource = options.env ?? process.env;
    const envWebhookUrl = envSource['ROUTERSYNC_WEBHOOK_URL'];
    const configWebhookUrl =
      config.webhook && config.webhook.enabled !== false ? config.webhook.url : undefined;
    const resolvedWebhookUrl =
      options.webhookUrl !== undefined && options.webhookUrl.trim() !== ''
        ? options.webhookUrl
        : envWebhookUrl !== undefined && envWebhookUrl.trim() !== ''
          ? envWebhookUrl
          : configWebhookUrl;
    const resolvedWebhookTimeoutMs = options.webhookTimeoutMs ?? config.webhook?.timeoutMs;
    const changedProviderNames = providerSummaries
      .filter((p) => p.changed)
      .map((p) => p.prefix);
    const webhookAlerts: ActionableWebhookAlert[] = [
      ...autoSafeWebhookAlerts,
      ...newlyAddedInboxItems
        .filter((item) => item.label !== 'AUTO-SAFE-APPLIED' && item.label !== 'AUTO-ROLLBACK')
        .map((item) => ({
          kind: 'inbox_item' as const,
          providerOrRouter: item.provider ?? 'unknown',
          code: item.label ?? item.action ?? item.type,
          message: `${item.title}: ${item.body}`,
        })),
    ];

    const webhookDelivery = await sendActionableWebhook({
      url: resolvedWebhookUrl,
      source: 'cli.tick',
      timestamp: nowIso,
      inboxAdded,
      changedProviders: changedProviderNames,
      alerts: webhookAlerts,
      timeoutMs: resolvedWebhookTimeoutMs,
      fetchImpl: options.fetchFn,
    });

    const summary: TickRunSummary = {
      timestamp: nowIso,
      detectionHistoryError: catalogState.detectionHistoryError,
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
      researchQueueCount,
      detectionLatency,
      providers: providerSummaries,
      shrinkBlockReasons: Object.fromEntries(shrinkBlockReasons),
      absentNotInCombo: Object.fromEntries(absentNotInCombo),
      webhookDelivery,
    };

    const netSnap = strictAccounting.snapshot();
    appendTickCostEntry(sDir, {
      timestamp: nowIso,
      nowMs,
      mode: requestedMode,
      totalHttpRequests: netSnap.totalHttpRequests,
      domainRequests: netSnap.domainRequests,
    });

    atomicWriteFileSync(statusPath, JSON.stringify(summary, null, 2));

    const latencyLogToken =
      detectionLatency.maxMs !== null ? String(detectionLatency.maxMs) : 'na';
    const logLine = `${nowIso} mode=${effectiveMode} requests=${totalRequests} changed=${changedProviders} unchanged=${unchangedProviders} backoff=${backoffSkipped} inbox_added=${inboxAdded} paid-requests=0 tokens=0 llm-calls=0 shrink_blocks=${JSON.stringify(Object.fromEntries(shrinkBlockReasons))} research_queue=${researchQueueCount} detection_latency_ms=${latencyLogToken}\n`;
    fs.appendFileSync(tickLogPath, logLine, 'utf8');

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const scannedCount = providerSummaries.filter(
        (p) => p.label !== 'SKIPPED' && p.label !== 'BACKOFF'
      ).length;
      const skippedCount = providerSummaries.filter((p) => p.label === 'SKIPPED').length;
      console.log(
        `TICK-SUMMARY mode=${effectiveMode} scanned=${scannedCount} skipped=${skippedCount} changed=${changedProviders} unchanged=${unchangedProviders} backoff=${backoffSkipped} inbox_added=${inboxAdded}`
      );
      for (const p of providerSummaries) {
        if (p.label === 'SKIPPED') {
          console.log(
            `  PROVIDER prefix=${p.prefix} label=${p.label} status=0 models=${p.models} changed=no reason=${p.skipReason ?? 'SKIPPED'}`
          );
          continue;
        }
        const reasonPart = p.skipReason ? ` reason=${p.skipReason}` : '';
        const backoffPart = p.backoffSec > 0 ? ` backoff=${p.backoffSec}s` : '';
        console.log(
          `  PROVIDER prefix=${p.prefix} label=${p.label} status=${p.status} models=${p.models} changed=${p.changed ? 'yes' : 'no'}${reasonPart} added=${p.added.length} grace=${p.graceAbsent.length} dead=${p.deadConfirmed.length}${backoffPart}`
        );
      }
      console.log(
        `TICK requests=${totalRequests} paid-requests=0 tokens=0 llm-calls=0`
      );
      if (options.toast && inboxAdded > 0) {
        console.log(
          `[routersync toast] ${inboxAdded} new proposal(s) added to inbox (mode=${effectiveMode}).`
        );
      }
    }

    return summary;
  } finally {
    releaseTickLock(sDir, process.pid);
  }
}
