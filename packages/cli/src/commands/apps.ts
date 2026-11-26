/**
 * packages/cli/src/commands/apps.ts
 *
 * `routersync apps inspect` — read-only view of an agent app's provider and
 * model configuration.
 *
 * C45-WP2 (`Phục vụ: S3`): adds `apps plan`, `apps apply`, and `apps rollback`
 * backed by `HarnessWriteAdapter` with strict sandbox-copy enforcement.
 *
 * C46-F3 (`Phục vụ: S9, I4, I5`): adds controlled `--write` mode on `apps apply`
 * (enforcing `--yes` rejection, `freeze` gate, `assertControlledWriteSandbox`,
 * `readStandingConsent`, `propose` interactive TTY `'chay'` confirmation,
 * `auto-safe` runtime receipt verification, and `appendApplyReceipt`),
 * optional `--catalog` fallback to `<stateDir>/tick-catalog.json`, and
 * receipt rollback marking in `apps rollback`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { maskHomePath } from '@routersync/adapter-sdk';
import type { AgentAppInspection, HarnessCatalogInput, HarnessModelPlan } from '@routersync/adapter-sdk';
import {
  ConsentValidationError,
  appendApplyReceipt,
  atomicWriteFileSync,
  releaseTickLock,
  tryAcquireTickLock,
  deriveRemovalSettlementMs,
  MAX_DETECTION_RECORDS,
  parseRemovalEvidenceTimestamp,
  researchEvidenceIdentity,
  type RemovedModelReceiptEvidence,
  assertControlledWriteSandbox,
  canonicalizeResearchProvider,
  findVerifiedProposeReceipt,
  loadResearchEvidence,
  markApplyReceiptRolledBack,
  readApplyHistory,
  readFreezeState,
  readStandingConsent,
  resolveControlStateDir,
} from '@routersync/core';
import {
  AGENT_APP_ADAPTERS,
  AgentAppInspectError,
  getAgentAppAdapter,
} from '../apps/inspect.js';
import {
  assertOpenMausBotSafeFile,
  getHarnessWriteAdapter,
  inspectHarnessConfiguredModels,
  inspectTierAHarnessForTick,
  isHarnessRemovalProtectedDefaultSlot,
  listHarnessWriteAdapters,
  resolveEffectiveHarnessHomeDir,
} from '../apps/write-adapter.js';

import {
  isOfficialUrlForProvider,
  isVerifiedOfficialLifecycleEvidence,
  loadAllRouterCombos,
  loadCatalogState,
  resolveCatalogPresence,
} from './tick.js';
import { loadL2Cache } from '../verify/l2-scanner.js';
import { loadL3Cache } from '../verify/l3-scanner.js';
import { enforceTargetShrinkCap, evaluateAbsentStable, isUnverifiableScanState } from '../verify/verifier.js';

export interface AppsInspectOptions {
  app?: string | undefined;
  home?: string | undefined;
  config?: string | undefined;
  json?: boolean | undefined;
}

export interface AppsPlanCommandOptions {
  app: string;
  config?: string | undefined;
  catalog?: string | undefined;
  stateDir?: string | undefined;
  home?: string | undefined;
  json?: boolean | undefined;
}

export interface AppsApplyCommandOptions {
  app: string;
  config: string;
  catalog?: string | undefined;
  stateDir?: string | undefined;
  home?: string | undefined;
  sandboxCopy?: boolean | undefined;
  write?: boolean | undefined;
  yes?: boolean | undefined;
  planHash?: string | undefined;
  backup?: string | undefined;
  json?: boolean | undefined;
  /** Programmatic test seams (mirrors apply.ts / consent.ts / freeze.ts) */
  isTTY?: boolean | undefined;
  promptFn?: ((question: string) => Promise<string>) | undefined;
}

export interface AppsRollbackCommandOptions {
  app: string;
  config: string;
  backup?: string | undefined;
  expectedPreSha256?: string | undefined;
  stateDir?: string | undefined;
  write?: boolean | undefined;
  json?: boolean | undefined;
}

function statusLabel(enabled: AgentAppInspection['models'][number]['enabled']): string {
  if (enabled === true) return 'bật';
  if (enabled === false) return 'tắt';
  return 'UNKNOWN';
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function renderTable(rows: string[][]): string {
  const widths = [0, 0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i] ?? 0, row[i]?.length ?? 0);
  }
  return rows
    .map((row) => row.map((cell, i) => pad(cell, widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');
}

function askAppsConfirmation(
  promptText: string,
  expectedWord = 'chay',
  customPrompt?: (question: string) => Promise<string>,
  useStderr = false
): Promise<boolean> {
  if (customPrompt) {
    return customPrompt(promptText).then(
      (ans) => ans.trim().toLowerCase() === expectedWord
    );
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: useStderr ? process.stderr : process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === expectedWord);
    });
  });
}

export async function runAppsInspectCommand(options: AppsInspectOptions = {}): Promise<void> {
  const homeDir = options.home ?? os.homedir();
  const wanted = options.app?.trim();

  let adapters = AGENT_APP_ADAPTERS;
  if (wanted) {
    const adapter = getAgentAppAdapter(wanted);
    if (!adapter) {
      process.stderr.write(
        `app không hỗ trợ: ${wanted} (hỗ trợ: ${AGENT_APP_ADAPTERS.map((a) => a.app).join(', ')})\n`
      );
      process.exitCode = 1;
      return;
    }
    adapters = [adapter];
  }

  const results: AgentAppInspection[] = [];
  const failures: Array<{ app: string; code: string; message: string }> = [];

  for (const adapter of adapters) {
    try {
      const inspection = await adapter.inspect({
        ...(options.config && adapters.length === 1 ? { configPath: options.config } : {}),
        homeDir,
      });
      results.push(inspection);
    } catch (error) {
      const code = error instanceof AgentAppInspectError ? error.code : 'UNSUPPORTED';
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ app: adapter.app, code, message });
    }
  }

  const masked = results.map((inspection) => ({
    ...inspection,
    configPath: maskHomePath(inspection.configPath, homeDir),
  }));

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ apps: masked, failures }, null, 2)}\n`);
    return;
  }

  const rows: string[][] = [['app', 'provider', 'model', 'trạng thái']];
  for (const inspection of masked) {
    if (inspection.models.length === 0) {
      rows.push([inspection.app, '—', '—', 'UNKNOWN']);
      continue;
    }
    for (const model of inspection.models) {
      rows.push([inspection.app, model.provider, model.id, statusLabel(model.enabled)]);
    }
  }

  const lines: string[] = [];
  lines.push(renderTable(rows));

  for (const inspection of masked) {
    lines.push('');
    lines.push(`[${inspection.app}]`);
    lines.push(`  cấu hình      : ${inspection.configPath} (${inspection.format}, chỉ đọc)`);
    lines.push(`  model đang dùng: ${inspection.activeModel}`);
    lines.push(`  router        : ${inspection.routerRef}`);
    lines.push(`  độ chắc chắn  : ${inspection.certainty}`);
    for (const warning of inspection.warnings) lines.push(`  cảnh báo      : ${warning}`);
  }

  for (const failure of failures) {
    lines.push('');
    lines.push(`[${failure.app}] không đọc được (${failure.code}): ${failure.message}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

type CatalogNormalizeMode = 'plan' | 'auto-safe' | 'propose' | 'sandbox-copy';

interface NormalizeCatalogOptions {
  stateDir?: string | undefined;
  mode: CatalogNormalizeMode;
  explicitCatalog?: boolean | undefined;
  targetScope?: string | undefined;
  nowMs?: number | undefined;
}

interface NormalizedCatalogBundle {
  catalog: HarnessCatalogInput;
  blockedCatalog: HarnessCatalogInput;
  hasBlockedCandidates: boolean;
}

function normalizeCatalogObject(
  parsed: Record<string, unknown>,
  options: NormalizeCatalogOptions
): NormalizedCatalogBundle {
  const out: HarnessCatalogInput = {};
  const blockedOut: HarnessCatalogInput = {};
  let hasBlockedCandidates = false;

  // Format B / C: `{ providers: { ... } }` (including `<stateDir>/tick-catalog.json`)
  if (
    parsed['providers'] &&
    typeof parsed['providers'] === 'object' &&
    !Array.isArray(parsed['providers'])
  ) {
    const providersObj = parsed['providers'] as Record<string, unknown>;
    const nowMs = options.nowMs ?? Date.now();
    const isIsolatedSandbox = options.mode === 'sandbox-copy';

    const stateDir = !isIsolatedSandbox ? options.stateDir : undefined;
    let evidenceRecords: ReturnType<typeof loadResearchEvidence> = [];
    let l2Models: ReturnType<typeof loadL2Cache>['models'] = {};
    let l3Notices: ReturnType<typeof loadL3Cache>['notices'] = [];
    let catalogState: ReturnType<typeof loadCatalogState> | undefined;

    if (stateDir) {
      try {
        evidenceRecords = loadResearchEvidence(stateDir);
      } catch {
        evidenceRecords = [];
      }
      try {
        l2Models = loadL2Cache(path.join(stateDir, 'l2-cache.json')).models;
      } catch {
        l2Models = {};
      }
      try {
        l3Notices = loadL3Cache(path.join(stateDir, 'l3-cache.json')).notices;
      } catch {
        l3Notices = [];
      }
      try {
        const tickCatPath = path.join(stateDir, 'tick-catalog.json');
        if (fs.existsSync(tickCatPath)) {
          catalogState = loadCatalogState(tickCatPath);
        }
      } catch {
        catalogState = undefined;
      }
    }

    const absenceEpisodes = catalogState?.absenceDetections ?? [];
    const noticeEpisodes = catalogState?.officialNoticeDetections ?? [];

    // Group verified official lifecycle records per (canonicalProvider, modelId), newest submittedAt first
    const lifecycleByCanonModel = new Map<string, ReturnType<typeof loadResearchEvidence>>();
    const modelsInOfficialByCanon = new Map<string, Set<string>>();
    for (const rec of evidenceRecords) {
      if (
        !['active', 'upcoming_deprecation', 'deprecated'].includes(rec.verdict) ||
        !isVerifiedOfficialLifecycleEvidence(rec, nowMs, true)
      ) {
        continue;
      }
      const key = `${rec.provider}\0${rec.modelId}`;
      const arr = lifecycleByCanonModel.get(key) ?? [];
      arr.push(rec);
      lifecycleByCanonModel.set(key, arr);
      const mSet = modelsInOfficialByCanon.get(rec.provider) ?? new Set<string>();
      mSet.add(rec.modelId);
      modelsInOfficialByCanon.set(rec.provider, mSet);
    }
    for (const arr of lifecycleByCanonModel.values()) {
      arr.sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
    }

    for (const [provId, rawEntry] of Object.entries(providersObj)) {
      if (Array.isArray(rawEntry)) {
        const liveModels = rawEntry.filter((m): m is string => typeof m === 'string');
        out[provId] = { liveModels, deprecatedModels: [] };
        blockedOut[provId] = { liveModels, deprecatedModels: [] };
        continue;
      }
      if (!rawEntry || typeof rawEntry !== 'object') {
        continue;
      }
      const entryObj = rawEntry as Record<string, unknown>;
      if (Array.isArray(entryObj['liveModels'])) {
        const liveModels = (entryObj['liveModels'] as unknown[]).filter(
          (m): m is string => typeof m === 'string'
        );
        const liveSet = new Set(liveModels);
        const deprecatedModels = Array.isArray(entryObj['deprecatedModels'])
          ? (entryObj['deprecatedModels'] as unknown[]).filter(
              (m): m is string => typeof m === 'string' && !liveSet.has(m)
            )
          : [];
        out[provId] = { liveModels, deprecatedModels };
        blockedOut[provId] = { liveModels, deprecatedModels: [] };
        continue;
      }
      if (Array.isArray(entryObj['ids'])) {
        const rawIds = (entryObj['ids'] as unknown[]).filter(
          (m): m is string => typeof m === 'string'
        );
        const deprecatedSet = new Set<string>();
        const blockedSet = new Set<string>();
        const absenceCounts =
          entryObj['absenceCounts'] &&
          typeof entryObj['absenceCounts'] === 'object' &&
          !Array.isArray(entryObj['absenceCounts'])
            ? (entryObj['absenceCounts'] as Record<string, unknown>)
            : {};

        if (isIsolatedSandbox) {
          const liveModels = rawIds.filter((m) => {
            const cnt = absenceCounts[m];
            return typeof cnt !== 'number' || cnt <= 0;
          });
          const liveSet = new Set(liveModels);
          for (const [modelId, rawCount] of Object.entries(absenceCounts)) {
            if (typeof rawCount === 'number' && rawCount >= 2 && !liveSet.has(modelId)) {
              deprecatedSet.add(modelId);
            }
          }
          out[provId] = { liveModels, deprecatedModels: [...deprecatedSet] };
          blockedOut[provId] = { liveModels, deprecatedModels: [] };
          continue;
        }

        const typedEntry = (
          options.explicitCatalog ? entryObj : (catalogState?.providers?.[provId] ?? entryObj)
        ) as Parameters<typeof resolveCatalogPresence>[0];
        const liveModels = rawIds.filter((m) => resolveCatalogPresence(typedEntry, m).l1Exists);
        const liveSet = new Set(liveModels);
        const isLegacyFormatC =
          typedEntry?.firstAbsentAt === undefined &&
          typedEntry?.pendingEpisodes === undefined &&
          typedEntry?.qualifyingScanTimestamps === undefined &&
          parsed['absenceDetections'] === undefined &&
          parsed['officialNoticeDetections'] === undefined &&
          (options.explicitCatalog ||
            (catalogState?.absenceDetections === undefined &&
              catalogState?.officialNoticeDetections === undefined));
        const canonProv = canonicalizeResearchProvider(provId);
        const candidateModels = new Set<string>(Object.keys(absenceCounts));
        for (const m of modelsInOfficialByCanon.get(canonProv) ?? []) {
          candidateModels.add(m);
        }
        for (const ep of absenceEpisodes) {
          if (ep.provider === provId || ep.fullStep.startsWith(`${provId}/`)) {
            candidateModels.add(ep.modelId);
          }
        }
        for (const ep of noticeEpisodes) {
          if (ep.provider === provId || ep.fullStep.startsWith(`${provId}/`)) {
            candidateModels.add(ep.modelId);
          }
        }
        for (const notice of l3Notices) {
          if (isOfficialUrlForProvider(provId, notice.url) && Array.isArray(notice.modelMatches)) {
            for (const rawMatch of notice.modelMatches) {
              if (typeof rawMatch !== 'string') continue;
              const unpref = rawMatch.startsWith(`${provId}/`)
                ? rawMatch.slice(provId.length + 1)
                : rawMatch;
              candidateModels.add(unpref);
            }
          }
        }

        const scanAt = parseRemovalEvidenceTimestamp(
          (typedEntry as { updatedAt?: unknown } | undefined)?.updatedAt
        );
        const lastStatus = (typedEntry as { lastStatus?: unknown } | undefined)?.lastStatus;
        const lastLabel = (typedEntry as { lastLabel?: string } | undefined)?.lastLabel;
        const providerVerifiable =
          Boolean(typedEntry) &&
          (scanAt === null ? options.mode === 'plan' && typedEntry?.updatedAt === undefined : scanAt <= nowMs) &&
          (typeof lastStatus === 'number' ? [200, 304].includes(lastStatus) : false) &&
          !isUnverifiableScanState(lastLabel);

        const requireEpisodeMatch =
          (options.mode === 'auto-safe' || (options.mode === 'propose' && !isLegacyFormatC)) &&
          Boolean(options.targetScope);

        const matchesOpenEpisode = (
          record: (typeof absenceEpisodes)[number] | (typeof noticeEpisodes)[number],
          modelId: string
        ): boolean =>
          record.provider === provId &&
          record.modelId === modelId &&
          record.fullStep === `${provId}/${modelId}` &&
          (!options.targetScope ||
            (Array.isArray(record.targetsAffected) &&
              record.targetsAffected.includes(options.targetScope))) &&
          !record.removedAt &&
          !record.recoveredAt &&
          !record.withdrawnAt &&
          !record.supersededAt &&
          !record.abandonedAt;

        for (const modelId of candidateModels) {
          if (!modelId || liveSet.has(modelId)) {
            continue;
          }
          const presence = resolveCatalogPresence(typedEntry, modelId);
          if (
            !providerVerifiable ||
            presence.scanFailed ||
            presence.l1Exists ||
            !Number.isSafeInteger(presence.absenceCount) ||
            presence.absenceCount < 0
          ) {
            blockedSet.add(modelId);
            continue;
          }

          const fullStep = `${provId}/${modelId}`;
          const firstAbsentRaw = typedEntry?.firstAbsentAt?.[modelId];
          const absentAt = parseRemovalEvidenceTimestamp(firstAbsentRaw);
          if (firstAbsentRaw != null && absentAt === null) {
            blockedSet.add(modelId);
            continue;
          }

          const lifecycle = lifecycleByCanonModel.get(`${canonProv}\0${modelId}`) ?? [];
          const current = lifecycle[0];
          if (current) {
            if (current.synthetic === true) {
              blockedSet.add(modelId);
              continue;
            }
            const shutdownMs = current.shutdownDate ? Date.parse(current.shutdownDate) : null;
            const isEffectiveDeprecated =
              current.verdict === 'deprecated' &&
              (shutdownMs === null || (Number.isFinite(shutdownMs) && shutdownMs <= nowMs));
            if (!isEffectiveDeprecated) {
              // Authoritative active / upcoming_deprecation / future shutdownDate overrides older notices & absence
              blockedSet.add(modelId);
              continue;
            }
            if (requireEpisodeMatch) {
              const evId = researchEvidenceIdentity(current);
              const pubAt = current.publishedAt ?? null;
              const pubMs = parseRemovalEvidenceTimestamp(pubAt);
              const matched = noticeEpisodes.some((rec) => {
                const started = parseRemovalEvidenceTimestamp(rec.firstQualifyingScanStartedAt);
                const planned = parseRemovalEvidenceTimestamp(rec.firstPlanCreatedAt);
                const activated = rec.episodeStartedAt ?? rec.firstQualifyingScanStartedAt;
                const activatedMs = parseRemovalEvidenceTimestamp(activated);
                return (
                  matchesOpenEpisode(rec, modelId) &&
                  rec.synthetic === false &&
                  rec.evidenceId === evId &&
                  rec.sourcePublishedAt === pubAt &&
                  started !== null &&
                  planned !== null &&
                  activatedMs !== null &&
                  activatedMs >= started &&
                  activatedMs <= planned &&
                  planned <= nowMs &&
                  (pubMs === null || pubMs <= nowMs) &&
                  rec.detectionMs === planned - started &&
                  rec.publicationToPlanMs === (pubMs === null ? null : planned - pubMs) &&
                  (rec.recordKey === JSON.stringify([fullStep, evId, activated]) ||
                    rec.recordKey === JSON.stringify([fullStep, evId]))
                );
              });
              if (!matched) {
                blockedSet.add(modelId);
                continue;
              }
            }
            deprecatedSet.add(modelId);
            continue;
          }

          // Block if a synthetic notice episode is open for this model
          if (noticeEpisodes.some((rec) => matchesOpenEpisode(rec, modelId) && rec.synthetic === true)) {
            blockedSet.add(modelId);
            continue;
          }

          // Path 1b: Official L3 notice when no ledger lifecycle record exists
          const l3Notice =
            presence.absenceCount >= 2
              ? l3Notices.find(
                  (notice) =>
                    ['deprecated', 'upcoming_deprecation'].includes(notice.noticeType) &&
                    isOfficialUrlForProvider(provId, notice.url) &&
                    Array.isArray(notice.modelMatches) &&
                    notice.modelMatches.some((id) => id === modelId || id === fullStep)
                )
              : undefined;
          if (l3Notice) {
            const l3Effective = parseRemovalEvidenceTimestamp(l3Notice.date);
            if (
              l3Notice.noticeType !== 'deprecated' ||
              l3Effective === null ||
              l3Effective > nowMs
            ) {
              blockedSet.add(modelId);
              continue;
            }
            if (requireEpisodeMatch) {
              const evId = JSON.stringify([l3Notice.url, l3Notice.date]);
              const matched = noticeEpisodes.some((rec) => {
                const started = parseRemovalEvidenceTimestamp(rec.firstQualifyingScanStartedAt);
                const planned = parseRemovalEvidenceTimestamp(rec.firstPlanCreatedAt);
                const activated = rec.episodeStartedAt ?? rec.firstQualifyingScanStartedAt;
                const activatedMs = parseRemovalEvidenceTimestamp(activated);
                return (
                  matchesOpenEpisode(rec, modelId) &&
                  rec.synthetic === false &&
                  rec.evidenceId === evId &&
                  rec.sourcePublishedAt === null &&
                  started !== null &&
                  planned !== null &&
                  activatedMs !== null &&
                  activatedMs >= started &&
                  activatedMs <= planned &&
                  planned <= nowMs &&
                  rec.detectionMs === planned - started &&
                  rec.publicationToPlanMs === null &&
                  (rec.recordKey === JSON.stringify([fullStep, evId, activated]) ||
                    rec.recordKey === JSON.stringify([fullStep, evId]))
                );
              });
              if (!matched) {
                blockedSet.add(modelId);
                continue;
              }
            }
            deprecatedSet.add(modelId);
            continue;
          }

          // Path 2: Absence-only path
          const external = l2Models[modelId];
          const l2Exists = Boolean(
            l2Models[fullStep] ||
              l2Models[`${canonProv}/${modelId}`] ||
              (external &&
                (!external.provider ||
                  canonicalizeResearchProvider(external.provider) === canonProv))
          );
          if (presence.absenceCount < 3 || l2Exists) {
            blockedSet.add(modelId);
            continue;
          }

          const rawScanTimes = typedEntry?.qualifyingScanTimestamps ?? [];
          const parsedScans = rawScanTimes.map(parseRemovalEvidenceTimestamp);
          if (parsedScans.some((t) => t === null || t > nowMs)) {
            blockedSet.add(modelId);
            continue;
          }
          const scans = new Set(
            parsedScans.filter(
              (t): t is number => t !== null && (absentAt === null || t >= absentAt)
            )
          );
          const lastQualifyingScan = Math.max(-Infinity, ...scans);

          if (requireEpisodeMatch) {
            const episodeId = typedEntry?.pendingEpisodes?.[modelId];
            const pending = absenceEpisodes.find((rec) => {
              const started = parseRemovalEvidenceTimestamp(rec.scanStartedAt);
              const committed = parseRemovalEvidenceTimestamp(rec.modelPendingAt);
              return (
                matchesOpenEpisode(rec, modelId) &&
                rec.status === 'model_pending' &&
                episodeId === rec.episodeId &&
                started !== null &&
                (absentAt === null || started >= absentAt) &&
                committed !== null &&
                committed >= started &&
                committed <= nowMs &&
                rec.detectionMs === committed - started &&
                (episodeId === `ep-${JSON.stringify([provId, modelId, started])}` ||
                  episodeId === `ep-${provId}-${modelId}-${started}`)
              );
            });
            if (!pending) {
              blockedSet.add(modelId);
              continue;
            }
          }

          if (options.mode === 'propose') {
            deprecatedSet.add(modelId);
            continue;
          }

          if (options.mode === 'plan' && isLegacyFormatC && absentAt === null) {
            deprecatedSet.add(modelId);
            continue;
          }

          // 'plan' and 'auto-safe': require >= 3 qualifying scans and >= 24h settle
          const effectiveNowForSettle =
            scans.size > 0 ? lastQualifyingScan : scanAt ?? nowMs;
          const effectiveScanCount =
            rawScanTimes.length > 0 ? Math.min(presence.absenceCount, scans.size) : 0;
          if (
            absentAt === null ||
            !evaluateAbsentStable({
              id: modelId,
              prefix: provId,
              absenceCount: effectiveScanCount,
              firstAbsentAtMs: absentAt,
              nowMs: effectiveNowForSettle,
              lastLabel: typedEntry?.lastLabel ?? 'OK',
              l2ExternalExists: false,
              providerCoveredByExternal: false,
              comboStepCount: 0,
              dropCount: 0,
            }).isAbsentStable
          ) {
            blockedSet.add(modelId);
            continue;
          }

          deprecatedSet.add(modelId);
        }

        if (blockedSet.size > 0) {
          hasBlockedCandidates = true;
        }
        out[provId] = {
          liveModels,
          deprecatedModels: [...deprecatedSet],
        };
        blockedOut[provId] = {
          liveModels,
          deprecatedModels: [...blockedSet],
        };
      }
    }
    return { catalog: out, blockedCatalog: blockedOut, hasBlockedCandidates };
  }

  // Format A: Direct `HarnessCatalogInput` (`{ openai: { liveModels, deprecatedModels } }`)
  for (const [provId, rawEntry] of Object.entries(parsed)) {
    if (Array.isArray(rawEntry)) {
      const liveModels = rawEntry.filter((m): m is string => typeof m === 'string');
      out[provId] = { liveModels, deprecatedModels: [] };
      blockedOut[provId] = { liveModels, deprecatedModels: [] };
      continue;
    }
    if (rawEntry && typeof rawEntry === 'object') {
      const rec = rawEntry as Record<string, unknown>;
      if (Array.isArray(rec['liveModels']) || Array.isArray(rec['deprecatedModels'])) {
        const liveModels = Array.isArray(rec['liveModels'])
          ? (rec['liveModels'] as unknown[]).filter((m): m is string => typeof m === 'string')
          : [];
        const liveSet = new Set(liveModels);
        const deprecatedModels = Array.isArray(rec['deprecatedModels'])
          ? (rec['deprecatedModels'] as unknown[]).filter(
              (m): m is string => typeof m === 'string' && !liveSet.has(m)
            )
          : [];
        out[provId] = { liveModels, deprecatedModels };
        blockedOut[provId] = { liveModels, deprecatedModels: [] };
      }
    }
  }

  return { catalog: out, blockedCatalog: blockedOut, hasBlockedCandidates: false };
}

function loadCatalogBundle(
  explicitCatalogPath: string | undefined,
  explicitStateDir: string | undefined,
  mode: CatalogNormalizeMode,
  targetScope?: string | undefined
): NormalizedCatalogBundle {
  const hasExplicit = Boolean(explicitCatalogPath && explicitCatalogPath.trim().length > 0);
  const sDir = mode === 'sandbox-copy' && hasExplicit
    ? undefined
    : resolveControlStateDir(explicitStateDir);
  const resolvedPath = hasExplicit
    ? explicitCatalogPath!.trim()
    : path.join(sDir ?? resolveControlStateDir(explicitStateDir), 'tick-catalog.json');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `CATALOG_NOT_FOUND: Không tìm thấy tệp catalog: ${resolvedPath} (truyền --catalog <path> hoặc chạy 'routersync tick --mode observe' trước).`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Tệp catalog không hợp lệ: ${resolvedPath}`);
  }
  return normalizeCatalogObject(parsed as Record<string, unknown>, {
    stateDir: sDir,
    mode,
    explicitCatalog: hasExplicit,
    targetScope,
  });
}

function loadCatalogJson(
  explicitCatalogPath: string | undefined,
  explicitStateDir?: string | undefined,
  mode: CatalogNormalizeMode = 'plan',
  targetScope?: string | undefined
): HarnessCatalogInput {
  return loadCatalogBundle(explicitCatalogPath, explicitStateDir, mode, targetScope).catalog;
}

function requireWriteAdapter(app: string) {
  const adapter = getHarnessWriteAdapter(app);
  if (!adapter) {
    const supported = listHarnessWriteAdapters().map((a) => a.app).join(', ');
    throw new Error(`Harness không hỗ trợ: ${app} (hỗ trợ: ${supported})`);
  }
  return adapter;
}

function failAppsWrite(error: Error, json?: boolean): never {
  process.exitCode = 1;
  if (json) {
    const errorCode = error instanceof ConsentValidationError ? error.code : undefined;
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          ...(errorCode ? { errorCode } : {}),
          error: error.message,
          status: 'FAILED',
        },
        null,
        2
      )}\n`
    );
  }
  throw error;
}

export async function runAppsPlanCommand(options: AppsPlanCommandOptions): Promise<void> {
  const adapter = requireWriteAdapter(options.app);
  const catalog = loadCatalogJson(options.catalog, options.stateDir);
  const effectiveHomeDir = resolveEffectiveHarnessHomeDir(options.config, options.home);
  const maskBaseHome = options.home ?? os.homedir();
  const plan = await adapter.plan({
    configPath: options.config,
    homeDir: effectiveHomeDir,
    catalog,
  });
  const maskedPlan = {
    ...plan,
    configPath: maskHomePath(plan.configPath, maskBaseHome),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(maskedPlan, null, 2)}\n`);
    return;
  }

  const lines = [
    `[${maskedPlan.app}] chế độ=${maskedPlan.directionAMode} editable=${maskedPlan.editable} planHash=${maskedPlan.planHash}`,
    `  cấu hình        : ${maskedPlan.configPath}`,
    `  provider đích   : ${maskedPlan.targetProviders.join(', ') || '—'}`,
    `  thêm model      : ${maskedPlan.additions.map((a) => `${a.provider}/${a.model}`).join(', ') || '0'}`,
    `  gỡ model        : ${maskedPlan.removals.map((r) => `${r.provider}/${r.model}`).join(', ') || '0'}`,
  ];
  for (const w of maskedPlan.defaultSlotWarnings) {
    lines.push(`  cảnh báo default: ${w.slot}=${w.currentModel} -> gợi ý ${w.suggestion}`);
  }
  for (const g of maskedPlan.guidance) {
    lines.push(`  hướng dẫn       : ${g}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function readAppsRemovalProofs(
  stateDir: string,
  target: string,
  plan: HarnessModelPlan,
  candidateCatalog: HarnessCatalogInput,
  appliedAt: string,
  manual: boolean,
  hasExplicitCatalog = false,
  isTTY = false,
  harnessContext?: { app: string; configPath: string; homeDir: string | undefined }
): { proofs: RemovedModelReceiptEvidence[]; warnings: string[] } {
  const warnings: string[] = [];
  if (plan.removals.length === 0) return { proofs: [], warnings };
  if (!manual) {
    for (const provider of new Set(plan.removals.map((removal) => removal.provider))) {
      const removed = new Set(plan.removals.filter((item) => item.provider === provider).map((item) => item.model));
      const additions = new Set(plan.additions.filter((item) => item.provider === provider).map((item) => item.model));
      // The adapter preview proves which catalog candidates already exist in the target.
      // A conservative lower bound keeps custom or partially observed configs fail-closed.
      const existing = new Set((candidateCatalog[provider]?.liveModels ?? [])
        .filter((model) => !additions.has(model) && !removed.has(model)));
      const cap = enforceTargetShrinkCap('harness', existing.size + removed.size, removed.size);
      if (!cap.allowed) throw new Error(`C48_REMOVAL_INELIGIBLE: SHRINK_CAP_EXCEEDED for ${target}/${provider}.`);
    }
  }
  const catalog = loadCatalogState(path.join(stateDir, 'tick-catalog.json'));
  const absence = catalog.absenceDetections ?? [];
  const notices = catalog.officialNoticeDetections ?? [];
  if (catalog.detectionHistoryError || absence.length + notices.length > MAX_DETECTION_RECORDS) {
    throw new Error('C48_REMOVAL_INELIGIBLE: DETECTION_HISTORY_CAP_EXCEEDED.');
  }
  const evidence = loadResearchEvidence(stateDir);
  const l2 = loadL2Cache(path.join(stateDir, 'l2-cache.json')).models;
  const l3 = loadL3Cache(path.join(stateDir, 'l3-cache.json')).notices;
  const now = Date.parse(appliedAt);
  const proofs = plan.removals.map(({ provider, model }): RemovedModelReceiptEvidence => {
    const fullStep = `${provider}/${model}`;
    const reject = (): never => {
      throw new Error(`C48_REMOVAL_INELIGIBLE: No eligible C48 removal evidence for ${target}/${fullStep}.`);
    };
    const matchesEpisode = (record: (typeof absence)[number] | (typeof notices)[number]): boolean =>
      record.provider === provider && record.modelId === model && record.fullStep === fullStep &&
      Array.isArray(record.targetsAffected) && record.targetsAffected.includes(target) &&
      !record.removedAt && !record.recoveredAt && !record.withdrawnAt && !record.supersededAt && !record.abandonedAt;
    const canonical = canonicalizeResearchProvider(provider);
    const lifecycle = evidence.filter((record) =>
      record.provider === canonical && record.modelId === model &&
      ['active', 'upcoming_deprecation', 'deprecated'].includes(record.verdict) &&
      isVerifiedOfficialLifecycleEvidence(record, now, manual)
    ).sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
    const current = lifecycle[0];
    if (manual && current &&
        (current.synthetic === true || current.verdict !== 'deprecated' ||
          (current.shutdownDate != null && Date.parse(current.shutdownDate) > now))) return reject();
    if (manual && !current && notices.some((record) =>
      matchesEpisode(record) && record.synthetic === true
    )) return reject();
    const external = l2[model];
    const l2Exists = Boolean(l2[fullStep] || l2[`${canonical}/${model}`] ||
      (external && (!external.provider || canonicalizeResearchProvider(external.provider) === canonical)));

    const entry = catalog.providers[provider];
    if (!entry) {
      if (!manual || !hasExplicitCatalog) return reject();
      const rawL3Notice = !current ? l3.find((notice) =>
        ['deprecated', 'upcoming_deprecation'].includes(notice.noticeType) &&
        isOfficialUrlForProvider(provider, notice.url) && Array.isArray(notice.modelMatches) &&
        notice.modelMatches.some((id) => id === model || id === fullStep)
      ) : undefined;
      const rawL3Effective = parseRemovalEvidenceTimestamp(rawL3Notice?.date);
      if (rawL3Notice && (rawL3Effective === null || rawL3Effective > now ||
          rawL3Notice.noticeType === 'upcoming_deprecation')) return reject();
      if (!current && !rawL3Notice && l2Exists) return reject();
      if (isTTY) {
        warnings.push(`C48_TTY_OVERRIDE: ${fullStep}: explicit --catalog file override.`);
      }
      return {
        provider,
        modelId: model,
        removedAt: appliedAt,
        inProviderCatalog: null,
      };
    }

    const presence = resolveCatalogPresence(entry, model);
    const scanAt = parseRemovalEvidenceTimestamp(entry.updatedAt);
    if (scanAt === null || scanAt > now || ![200, 304].includes(entry.lastStatus) || isUnverifiableScanState(entry.lastLabel) ||
        presence.scanFailed || presence.l1Exists ||
        !Number.isSafeInteger(presence.absenceCount) || presence.absenceCount < 0) return reject();

    const ledgerOfficial = current?.verdict === 'deprecated' &&
      (current.shutdownDate == null || Date.parse(current.shutdownDate) <= now) ? current : undefined;
    const l3Notice = !current && presence.absenceCount >= 2 ? l3.find((notice) =>
      ['deprecated', 'upcoming_deprecation'].includes(notice.noticeType) &&
      isOfficialUrlForProvider(provider, notice.url) && Array.isArray(notice.modelMatches) &&
      notice.modelMatches.some((id) => id === model || id === fullStep)
    ) : undefined;
    const l3Effective = parseRemovalEvidenceTimestamp(l3Notice?.date);
    if (manual && l3Notice && (l3Effective === null || l3Effective > now ||
        l3Notice.noticeType === 'upcoming_deprecation')) return reject();
    const l3Official = l3Notice?.noticeType === 'deprecated' && l3Effective !== null &&
      l3Effective <= now ? l3Notice : undefined;
    const evidenceId = ledgerOfficial ? researchEvidenceIdentity(ledgerOfficial)
      : l3Official ? JSON.stringify([l3Official.url, l3Official.date]) : null;
    const publishedAt = ledgerOfficial?.publishedAt ?? null;
    const shutdownDate = ledgerOfficial?.shutdownDate ?? l3Official?.date ?? null;
    const officialEpisode = evidenceId === null ? undefined : notices.find((record) => {
      const started = parseRemovalEvidenceTimestamp(record.firstQualifyingScanStartedAt);
      const planned = parseRemovalEvidenceTimestamp(record.firstPlanCreatedAt);
      const activated = record.episodeStartedAt ?? record.firstQualifyingScanStartedAt;
      const activatedMs = parseRemovalEvidenceTimestamp(activated);
      const publicationMs = parseRemovalEvidenceTimestamp(publishedAt);
      return matchesEpisode(record) && record.synthetic === false && record.evidenceId === evidenceId &&
        record.sourcePublishedAt === publishedAt && started !== null && planned !== null &&
        activatedMs !== null && activatedMs >= started && activatedMs <= planned && planned <= now &&
        (publicationMs === null || publicationMs <= now) &&
        (shutdownDate === null || (parseRemovalEvidenceTimestamp(shutdownDate) ?? Infinity) <= now) &&
        record.detectionMs === planned - started &&
        record.publicationToPlanMs === (publicationMs === null ? null : planned - publicationMs) &&
        (record.recordKey === JSON.stringify([fullStep, evidenceId, activated]) ||
          record.recordKey === JSON.stringify([fullStep, evidenceId]));
    });
    const firstAbsentAt = entry.firstAbsentAt?.[model];
    const absentAt = parseRemovalEvidenceTimestamp(firstAbsentAt);
    if (firstAbsentAt != null && absentAt === null) return reject();
    const proof: RemovedModelReceiptEvidence = {
      provider, modelId: model, removedAt: appliedAt, inProviderCatalog: false,
      qualifyingScanCount: presence.absenceCount,
    };
    if (officialEpisode) {
      const start = absentAt ?? Date.parse(officialEpisode.firstQualifyingScanStartedAt);
      Object.assign(proof, {
        removalPath: 'official-notice',
        firstObservedAbsentAt: new Date(start).toISOString(), removalSettleMs: now - start,
        officialDomainVerified: true, officialPublishedAt: publishedAt, officialShutdownDate: shutdownDate,
        syntheticNotice: false, detectionEvidenceId: evidenceId, detectionEpisodeId: officialEpisode.recordKey,
      });
    } else if (manual && hasExplicitCatalog && (ledgerOfficial || l3Official)) {
      // Genuine effective official notice confirmed via explicit --catalog propose override before tick episode creation.
    } else {
      if ((!manual && absentAt === null) || presence.absenceCount < 3 || l2Exists) return reject();
      const observedScans = (entry.qualifyingScanTimestamps ?? []).map(parseRemovalEvidenceTimestamp);
      if (observedScans.some((time) => time === null || time > now)) return reject();
      const scans = new Set(observedScans.filter((time): time is number => time !== null &&
        (absentAt === null || time >= absentAt)));
      const lastQualifyingScan = Math.max(-Infinity, ...scans);
      const isLegacyTickCatalogEntry =
        entry.firstAbsentAt === undefined &&
        entry.pendingEpisodes === undefined &&
        entry.qualifyingScanTimestamps === undefined &&
        catalog.absenceDetections === undefined &&
        catalog.officialNoticeDetections === undefined;
      if (manual && isLegacyTickCatalogEntry) {
        if (isTTY) {
          warnings.push(`C48_TTY_OVERRIDE: ${fullStep}: firstAbsentAt is missing.`);
        }
      } else {
        const episodeId = entry.pendingEpisodes?.[model];
        const pending = absence.find((record) => {
          const started = parseRemovalEvidenceTimestamp(record.scanStartedAt);
          const committed = parseRemovalEvidenceTimestamp(record.modelPendingAt);
          return matchesEpisode(record) && record.status === 'model_pending' && episodeId === record.episodeId &&
            started !== null && (absentAt === null || started >= absentAt) && committed !== null && committed >= started &&
            committed <= now && record.detectionMs === committed - started &&
            (episodeId === `ep-${JSON.stringify([provider, model, started])}` ||
              episodeId === `ep-${provider}-${model}-${started}`);
        });
        if (!pending) return reject();
        if (manual && isTTY && (absentAt === null || lastQualifyingScan - absentAt < 86_400_000)) {
          warnings.push(`C48_TTY_OVERRIDE: ${fullStep}: ${absentAt === null ? 'firstAbsentAt is missing' : 'absence is under 24 hours'}.`);
        }
        if (!manual && (absentAt === null || !evaluateAbsentStable({
          id: model, prefix: provider, absenceCount: Math.min(presence.absenceCount, scans.size),
          firstAbsentAtMs: absentAt, nowMs: lastQualifyingScan, lastLabel: entry.lastLabel,
          l2ExternalExists: l2Exists, providerCoveredByExternal: l2Exists, comboStepCount: 0, dropCount: 0,
        }).isAbsentStable)) return reject();
        proof.detectionEpisodeId = pending.episodeId;
        if (absentAt !== null) {
          Object.assign(proof, {
            removalPath: 'absence-only', firstObservedAbsentAt: new Date(absentAt).toISOString(),
            removalSettleMs: now - absentAt,
          });
        }
      }
    }
    const canonicalFullStep = `${canonical}/${model}`;
    const isProtectedDefault = harnessContext
      ? isHarnessRemovalProtectedDefaultSlot(
          harnessContext.app,
          harnessContext.configPath,
          harnessContext.homeDir,
          provider,
          model,
          candidateCatalog
        )
      : plan.defaultSlotWarnings.some(
          (warning) =>
            warning.currentModel === model ||
            warning.currentModel === fullStep ||
            warning.currentModel === canonicalFullStep
        );
    if (!manual && isProtectedDefault) {
      const rawReplacement = officialEpisode ? ledgerOfficial?.replacementModelId?.trim() : undefined;
      const replacement = rawReplacement
        ? rawReplacement.startsWith(`${provider}/`)
          ? rawReplacement.slice(provider.length + 1)
          : rawReplacement.startsWith(`${canonical}/`) &&
              !resolveCatalogPresence(entry, rawReplacement).l1Exists
            ? rawReplacement.slice(canonical.length + 1)
            : rawReplacement
        : null;
      if (
        !replacement ||
        replacement === model ||
        !resolveCatalogPresence(entry, replacement).l1Exists ||
        !candidateCatalog[provider]?.liveModels.includes(replacement) ||
        plan.removals.some((removal) => removal.provider === provider && removal.model === replacement)
      ) {
        throw new Error(`C48_REMOVAL_INELIGIBLE: DEFAULT_SLOT_PROTECTED for ${target}/${fullStep}.`);
      }
    }
    if (proof.removalPath !== undefined && deriveRemovalSettlementMs(proof, appliedAt) === null) return reject();
    if (
      manual &&
      isTTY &&
      hasExplicitCatalog &&
      !warnings.some((warning) => warning.startsWith(`C48_TTY_OVERRIDE: ${fullStep}:`))
    ) {
      warnings.push(`C48_TTY_OVERRIDE: ${fullStep}: explicit --catalog file override.`);
    }
    return proof;
  });
  return { proofs, warnings };
}

function expandCatalogTargetAliasGroup(
  tgt: string,
  routerTargetAliases?: Record<string, string[]> | undefined
): ReadonlySet<string> {
  const set = new Set<string>([tgt]);
  for (const alias of routerTargetAliases?.[tgt] ?? []) {
    set.add(alias);
  }
  return set;
}

function appsEpisodeMatchesOfficialProof(
  record: NonNullable<ReturnType<typeof loadCatalogState>['officialNoticeDetections']>[number],
  evId: string | undefined,
  epKey: string | undefined
): boolean {
  if (!evId) return false;
  const validEvIds = [record.evidenceId, ...(record.previousEvidenceIds ?? [])];
  const validKeys = [record.recordKey, ...(record.previousRecordKeys ?? [])];
  return validEvIds.includes(evId) && (epKey === undefined || validKeys.includes(epKey));
}

function terminalizeAppsRemovals(
  stateDir: string,
  target: string,
  proofs: RemovedModelReceiptEvidence[],
  appliedAt: string,
  effectiveHomeDir?: string | undefined
): void {
  const trackedProofs = proofs.filter((proof) => proof.detectionEpisodeId !== undefined);
  if (trackedProofs.length === 0) return;
  const catalogPath = path.join(stateDir, 'tick-catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as ReturnType<typeof loadCatalogState>;
  const episodes = [...(catalog.absenceDetections ?? []), ...(catalog.officialNoticeDetections ?? [])];
  const history = readApplyHistory(stateDir);
  const tmpRoot = os.tmpdir();
  const relStateToTmp = path.relative(tmpRoot, path.resolve(stateDir));
  const stateInTmp =
    relStateToTmp === '' || (!relStateToTmp.startsWith('..') && !path.isAbsolute(relStateToTmp));
  const hasIsolatedRouterDb =
    Boolean(process.env['ROUTERSYNC_9ROUTER_DB']) || Boolean(process.env['ROUTERSYNC_OMNIROUTE_DB']);
  let cachedRouterCombos: Array<{ name: string; router: string; models: string[] }> | undefined;
  const getVerifiableRouterCombos = (): Array<{ name: string; router: string; models: string[] }> => {
    if (stateInTmp && !hasIsolatedRouterDb) return [];
    if (cachedRouterCombos === undefined) {
      cachedRouterCombos = loadAllRouterCombos();
    }
    return cachedRouterCombos;
  };

  const isSiblingVerifiedAbsentLive = (
    aliasSet: ReadonlySet<string>,
    episode: (typeof episodes)[number]
  ): boolean => {
    const sample = [...aliasSet][0];
    if (!sample) return false;
    if (sample.startsWith('harness:')) {
      if (!effectiveHomeDir) return false;
      const hId = sample.slice('harness:'.length);
      try {
        const tierA = inspectTierAHarnessForTick(hId, effectiveHomeDir);
        if (!tierA || !fs.existsSync(tierA.configPath)) return false;
        const hasProxy = tierA.providers.some(
          (p) => p.providerId === episode.provider && Boolean(p.proxyDelegated)
        );
        if (hasProxy) return false;
        const provModels =
          tierA.providers.find((p) => p.providerId === episode.provider)?.models ?? [];
        return !provModels.includes(episode.modelId) && !provModels.includes(episode.fullStep);
      } catch {
        return false;
      }
    }
    if (sample.startsWith('router:')) {
      const combos = getVerifiableRouterCombos();
      return combos.some(
        (c) =>
          aliasSet.has(`router:${c.router}/${c.name}`) && !c.models.includes(episode.fullStep)
      );
    }
    return false;
  };

  let changed = false;
  for (const proof of trackedProofs) {
    const episode = episodes.find((record) => {
      if (record.provider !== proof.provider || record.modelId !== proof.modelId) return false;
      if (!record.targetsAffected.includes(target)) return false;
      if (
        record.removedAt ||
        record.recoveredAt ||
        record.withdrawnAt ||
        record.supersededAt ||
        record.abandonedAt
      ) {
        return false;
      }
      if ('recordKey' in record) {
        const validKeys = [record.recordKey, ...(record.previousRecordKeys ?? [])];
        return validKeys.includes(proof.detectionEpisodeId!);
      }
      return record.episodeId === proof.detectionEpisodeId;
    });
    if (!episode) throw new Error('C48_REMOVAL_INELIGIBLE: The verified detection episode changed.');

    // Never settle an episode when apply-history.json is absent or invalid
    if (!history.present || !history.valid || episode.targetsAffected.length === 0) {
      continue;
    }

    const seenGroups = new Set<string>();
    let allTargetsSettled = true;
    for (const affectedTarget of episode.targetsAffected) {
      const aliasSet = expandCatalogTargetAliasGroup(affectedTarget, catalog.routerTargetAliases);
      const groupKey = [...aliasSet].sort().join('\0');
      if (seenGroups.has(groupKey)) continue;
      seenGroups.add(groupKey);

      let latestRolledBackIdx = -1;
      let latestActiveIdx = -1;
      history.receipts.forEach((cand, idx) => {
        if (!cand.success || !cand.readBackVerified || !aliasSet.has(cand.target)) return;
        const matchesModel = (cand.removedModels ?? []).some((rm) => {
          if (rm.provider !== episode.provider || rm.modelId !== episode.modelId) return false;
          if ('recordKey' in episode) {
            return appsEpisodeMatchesOfficialProof(episode, rm.detectionEvidenceId, rm.detectionEpisodeId);
          }
          return rm.detectionEpisodeId === episode.episodeId;
        });
        if (!matchesModel) return;
        if (cand.rolledBack) latestRolledBackIdx = idx;
        else latestActiveIdx = idx;
      });

      if (latestRolledBackIdx > latestActiveIdx) {
        allTargetsSettled = false;
        break;
      }
      if (latestActiveIdx >= 0 && latestActiveIdx > latestRolledBackIdx) {
        continue;
      }
      if (!isSiblingVerifiedAbsentLive(aliasSet, episode)) {
        allTargetsSettled = false;
        break;
      }
    }

    if (allTargetsSettled) {
      episode.removedAt = appliedAt;
      const provEntry = catalog.providers?.[proof.provider];
      const epId = 'episodeId' in episode ? episode.episodeId : proof.detectionEpisodeId;
      if (provEntry?.pendingEpisodes && provEntry.pendingEpisodes[proof.modelId] === epId) {
        delete provEntry.pendingEpisodes[proof.modelId];
      }
      changed = true;
    }
  }
  if (changed) {
    atomicWriteFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  }
}

export function reconcileRolledBackRemovalEpisodes(
  stateDir: string,
  restoredModels: ReadonlyArray<{ target: string; proofs: ReadonlyArray<RemovedModelReceiptEvidence> }>,
  confirmPresent?: (target: string, provider: string, modelId: string) => boolean
): void {
  if (restoredModels.length === 0) return;
  const catalogPath = path.join(stateDir, 'tick-catalog.json');
  if (!fs.existsSync(catalogPath)) return;
  let catalog: ReturnType<typeof loadCatalogState>;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as ReturnType<typeof loadCatalogState>;
  } catch {
    return;
  }
  const absence = catalog.absenceDetections ?? [];
  const notices = catalog.officialNoticeDetections ?? [];
  let changed = false;

  for (const { target, proofs } of restoredModels) {
    for (const proof of proofs) {
      if (confirmPresent && !confirmPresent(target, proof.provider, proof.modelId)) {
        continue;
      }
      const targetAliases = expandCatalogTargetAliasGroup(target, catalog.routerTargetAliases);
      const officialEp = proof.detectionEvidenceId
        ? notices.find(
            (record) =>
              record.provider === proof.provider &&
              record.modelId === proof.modelId &&
              record.targetsAffected.some((tgt) => targetAliases.has(tgt)) &&
              appsEpisodeMatchesOfficialProof(record, proof.detectionEvidenceId, proof.detectionEpisodeId)
          )
        : undefined;
      if (officialEp && officialEp.removedAt !== undefined) {
        delete officialEp.removedAt;
        changed = true;
      }

      const absenceEp = !proof.detectionEvidenceId
        ? absence.find(
            (record) =>
              record.provider === proof.provider &&
              record.modelId === proof.modelId &&
              record.targetsAffected.some((tgt) => targetAliases.has(tgt)) &&
              record.episodeId === proof.detectionEpisodeId
          )
        : undefined;
      if (absenceEp) {
        if (absenceEp.removedAt !== undefined) {
          delete absenceEp.removedAt;
          changed = true;
        }
        const isStillOpen =
          !absenceEp.recoveredAt &&
          !absenceEp.withdrawnAt &&
          !absenceEp.supersededAt &&
          !absenceEp.abandonedAt;
        const provEntry = catalog.providers?.[proof.provider];
        const restoredPresence = resolveCatalogPresence(provEntry, proof.modelId);
        if (
          isStillOpen &&
          provEntry &&
          !restoredPresence.scanFailed &&
          !restoredPresence.l1Exists
        ) {
          provEntry.pendingEpisodes = provEntry.pendingEpisodes ?? {};
          if (provEntry.pendingEpisodes[proof.modelId] !== absenceEp.episodeId) {
            provEntry.pendingEpisodes[proof.modelId] = absenceEp.episodeId;
            changed = true;
          }
        }
      }
    }
  }

  if (changed) {
    atomicWriteFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  }
}

export async function runAppsApplyCommand(options: AppsApplyCommandOptions): Promise<void> {
  // 1. Prohibit --yes bypass unconditionally (Rule R11 / C46-F3)
  if (options.yes) {
    failAppsWrite(
      new ConsentValidationError(
        'CONSENT_BYPASS_FORBIDDEN',
        'CONSENT_BYPASS_FORBIDDEN: Security Violation: The --yes flag is prohibited by security policy.'
      ),
      options.json
    );
  }

  // 2. Legacy C45-WP2 isolated sandbox-copy mode (100% backward-compatible, strictly os.tmpdir() only)
  if (options.sandboxCopy && !options.write) {
    try {
      assertOpenMausBotSafeFile(options.config);
      assertControlledWriteSandbox(options.config, 'harness-config', {});
      assertControlledWriteSandbox(
        options.backup ?? `${options.config}.routersync.bak`,
        'harness-config',
        {}
      );
    } catch (err) {
      failAppsWrite(err instanceof Error ? err : new Error(String(err)), options.json);
    }
    const adapter = requireWriteAdapter(options.app);
    const catalog = loadCatalogJson(options.catalog, options.stateDir, 'sandbox-copy');
    const effectiveHomeDir = resolveEffectiveHarnessHomeDir(options.config, options.home);
    const res = await adapter.apply({
      configPath: options.config,
      homeDir: effectiveHomeDir,
      catalog,
      expectedPlanHash: options.planHash,
      backupPath: options.backup,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `[${res.app}] applied=${res.applied} readBackVerified=${res.readBackVerified} preSha256=${res.preSha256} postSha256=${res.postSha256}\n`
    );
    return;
  }

  if (!options.write) {
    failAppsWrite(
      new Error(
        'Yêu cầu cờ --write (có kiểm soát qua standing-consent) hoặc --sandbox-copy (chỉ áp dụng trên bản sao tạm trong os.tmpdir()) khi chạy `routersync apps apply`.'
      ),
      options.json
    );
  }

  // 3. Controlled `--write` mode (C46-F3)
  const sDir = resolveControlStateDir(options.stateDir);

  // 3a. Emergency Freeze Gate (fail-closed on active or corrupted freeze.json)
  const freeze = readFreezeState(sDir);
  if (freeze.frozen) {
    failAppsWrite(
      new ConsentValidationError(
        'FREEZE_ACTIVE',
        `FREEZE_ACTIVE (WRITE_FROZEN): Write execution blocked because emergency freeze is active (${freeze.reason ?? 'frozen'}).`
      ),
      options.json
    );
  }

  // 3b. Sandbox & forbidden runtime file guard (`bots.json` / `routines.json` + `os.tmpdir()` vs `ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1`)
  try {
    assertOpenMausBotSafeFile(options.config);
    assertControlledWriteSandbox(options.config, 'harness-config');
    assertControlledWriteSandbox(
      options.backup ?? `${options.config}.routersync.bak`,
      'harness-config'
    );
  } catch (err) {
    failAppsWrite(err instanceof Error ? err : new Error(String(err)), options.json);
  }

  const adapter = requireWriteAdapter(options.app);
  if (adapter.directionAMode !== 'write-adapter') {
    failAppsWrite(
      new Error(
        `REPORT_ONLY_HARNESS: Harness '${adapter.app}' is report-only and cannot be modified via 'apps apply --write'.`
      ),
      options.json
    );
  }

  const targetScope = `harness:${adapter.app}`;

  // 3c. Standing Consent & Apply History HMAC/Schema Verification
  const consent = readStandingConsent(sDir);
  if (consent.present && !consent.valid) {
    const code = consent.errorCode ?? 'CONSENT_HMAC_INVALID';
    failAppsWrite(
      new ConsentValidationError(
        code,
        `${code}: Standing consent file (<stateDir>/standing-consent.json) failed integrity verification.`
      ),
      options.json
    );
  }

  const historyCheck = readApplyHistory(sDir);
  if (historyCheck.present && !historyCheck.valid) {
    const code = historyCheck.errorCode ?? 'CONSENT_HMAC_INVALID';
    failAppsWrite(
      new ConsentValidationError(
        code,
        `${code}: Apply history ledger (<stateDir>/apply-history.json) failed integrity verification.`
      ),
      options.json
    );
  }

  const activeEntry = consent.activeTargets.find(
    (entry) =>
      entry.target === targetScope &&
      (entry.level === 'propose' || entry.level === 'auto-safe')
  );
  if (!activeEntry) {
    failAppsWrite(
      new ConsentValidationError(
        'CONSENT_REQUIRED',
        `CONSENT_REQUIRED: Active standing consent ('propose' or 'auto-safe') is required for '${targetScope}'. Run 'routersync consent grant --target ${targetScope} --level propose'.`
      ),
      options.json
    );
  }

  let authorizedVia: 'standing-consent' | 'interactive-tty';
  let appliedAtLevel: 'auto-safe' | 'propose';

  if (activeEntry.level === 'auto-safe') {
    if (!findVerifiedProposeReceipt(sDir, targetScope)) {
      failAppsWrite(
        new ConsentValidationError(
          'AUTO_SAFE_RECEIPT_MISSING',
          `AUTO_SAFE_RECEIPT_MISSING: Runtime auto-safe check failed for '${targetScope}': apply-history.json is missing, tampered, or lacks a verified non-rolled-back propose receipt.`
        ),
        options.json
      );
    }
    authorizedVia = 'standing-consent';
    appliedAtLevel = 'auto-safe';
  } else {
    authorizedVia = 'interactive-tty';
    appliedAtLevel = 'propose';
  }

  const manual = authorizedVia === 'interactive-tty';
  const hasExplicitCatalog = Boolean(options.catalog && options.catalog.trim().length > 0);
  const effectiveIsTTY = Boolean(options.isTTY ?? process.stdin.isTTY);
  if (!manual && options.catalog !== undefined) {
    failAppsWrite(new Error('C48_REMOVAL_INELIGIBLE: CUSTOM_CATALOG_FORBIDDEN under auto-safe consent.'), options.json);
  }
  if (manual && !effectiveIsTTY) {
    failAppsWrite(
      new Error("TTY_REQUIRED: apps apply --write at consent level 'propose' requires an interactive TTY terminal."),
      options.json
    );
  }
  const effectiveHomeDir = resolveEffectiveHarnessHomeDir(options.config, options.home);
  const prepare = async () => {
    const bundle = loadCatalogBundle(options.catalog, sDir, appliedAtLevel, targetScope);
    const { catalog, blockedCatalog, hasBlockedCandidates } = bundle;
    const preview = await adapter.plan({ configPath: options.config, homeDir: effectiveHomeDir, catalog });
    if (options.planHash !== undefined && options.planHash !== preview.planHash) {
      throw new Error('C48_REMOVAL_INELIGIBLE: The requested plan hash no longer matches the preview.');
    }
    const appliedAt = new Date().toISOString();
    if (
      preview.additions.length === 0 &&
      preview.removals.length === 0 &&
      hasBlockedCandidates
    ) {
      const blockedPreview = await adapter.plan({
        configPath: options.config,
        homeDir: effectiveHomeDir,
        catalog: blockedCatalog,
      });
      if (blockedPreview.removals.length > 0) {
        readAppsRemovalProofs(
          sDir,
          targetScope,
          blockedPreview,
          blockedCatalog,
          appliedAt,
          manual,
          hasExplicitCatalog,
          effectiveIsTTY,
          { app: adapter.app, configPath: options.config, homeDir: effectiveHomeDir }
        );
        const blocked = blockedPreview.removals[0]!;
        throw new Error(
          `C48_REMOVAL_INELIGIBLE: No eligible C48 removal evidence for ${targetScope}/${blocked.provider}/${blocked.model}.`
        );
      }
    }
    const { proofs, warnings } = readAppsRemovalProofs(
      sDir,
      targetScope,
      preview,
      catalog,
      appliedAt,
      manual,
      hasExplicitCatalog,
      effectiveIsTTY,
      { app: adapter.app, configPath: options.config, homeDir: effectiveHomeDir }
    );
    return { catalog, preview, appliedAt, proofs, warnings };
  };

  let ownerPreview: Awaited<ReturnType<typeof prepare>> | undefined;
  if (manual) {
    try {
      ownerPreview = await prepare();
    } catch (err) {
      failAppsWrite(err instanceof Error ? err : new Error(String(err)), options.json);
    }
    const { preview, warnings } = ownerPreview;
    const summaryWriter = options.json ? process.stderr : process.stdout;
    summaryWriter.write(
      `\n[routersync] REVIEWING HARNESS CHANGES BEFORE WRITING ${targetScope}\n` +
        `  Additions: ${preview.additions.length}, Removals: ${preview.removals.length}\n` +
        preview.removals.map(({ provider, model }) => `  Remove ${provider}/${model}\n`).join('') +
        warnings.map((warning) => `  WARNING ${warning}\n`).join('')
    );
    const confirmed = await askAppsConfirmation(
      `Apply changes to ${targetScope}? Type 'chay' to confirm: `,
      'chay', options.promptFn, Boolean(options.json)
    );
    if (!confirmed) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, applied: false, cancelled: true, target: targetScope }, null, 2)}\n`);
      } else {
        process.stdout.write('[routersync] Write operation cancelled by user. Zero changes applied.\n');
      }
      return;
    }
  }

  const lock = tryAcquireTickLock(sDir, process.pid, Date.now());
  if (!lock.acquired) failAppsWrite(new Error('C48_REMOVAL_INELIGIBLE: Another tick or apply is active.'), options.json);
  try {
    if (readFreezeState(sDir).frozen || !readStandingConsent(sDir).activeTargets.some(
      (entry) => entry.target === targetScope && entry.level === appliedAtLevel
    )) {
      throw new Error('C48_REMOVAL_INELIGIBLE: Freeze or standing consent changed before apply.');
    }
    const latestHistory = readApplyHistory(sDir);
    if (latestHistory.present && !latestHistory.valid) {
      throw new Error('CONSENT_HMAC_INVALID: Apply history changed before apply.');
    }
    if (!manual && !findVerifiedProposeReceipt(sDir, targetScope)) {
      throw new Error('AUTO_SAFE_RECEIPT_MISSING: Verified propose receipt changed before apply.');
    }
    const { catalog, preview, appliedAt, proofs, warnings } = await prepare();
    const binding = (items: RemovedModelReceiptEvidence[]) => items.map(
      (item) => [item.provider, item.modelId, item.detectionEpisodeId, item.detectionEvidenceId]
    );
    if (ownerPreview && (ownerPreview.preview.planHash !== preview.planHash ||
        JSON.stringify(binding(ownerPreview.proofs)) !== JSON.stringify(binding(proofs)) ||
        JSON.stringify(ownerPreview.warnings) !== JSON.stringify(warnings))) {
      throw new Error('C48_REMOVAL_INELIGIBLE: The confirmed plan or removal evidence changed. Review it again.');
    }
    const res = await adapter.apply({
      configPath: options.config,
      homeDir: effectiveHomeDir,
      catalog,
      expectedPlanHash: preview.planHash,
      backupPath: options.backup,
    });
    const success = res.applied && res.readBackVerified && !res.rolledBack;
    appendApplyReceipt(sDir, {
      target: targetScope,
      planHash: res.planHash,
      appliedAt,
      appliedAtLevel,
      authorizedVia,
      success,
      readBackVerified: res.readBackVerified,
      readBackLevel: 'file-byte-verified',
      rolledBack: res.rolledBack,
      snapshotOrBackupRef: res.backupPath,
      preDigest: res.preSha256,
      postDigest: res.postSha256,
      removedModels: success ? proofs : [],
    });
    if (!res.readBackVerified || res.rolledBack) {
      throw new Error(`[${res.app}] Post-write read-back verification failed for ${targetScope}.`);
    }
    if (success) terminalizeAppsRemovals(sDir, targetScope, proofs, appliedAt, effectiveHomeDir);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      process.stdout.write(
        `[${res.app}] applied=${res.applied} readBackVerified=${res.readBackVerified} preSha256=${res.preSha256} postSha256=${res.postSha256}\n`
      );
    }
  } catch (err) {
    failAppsWrite(err instanceof Error ? err : new Error(String(err)), options.json);
  } finally {
    releaseTickLock(sDir, process.pid);
  }
}

export async function runAppsRollbackCommand(options: AppsRollbackCommandOptions): Promise<void> {
  assertOpenMausBotSafeFile(options.config);
  assertControlledWriteSandbox(options.config, 'harness-config');
  if (options.backup) {
    assertControlledWriteSandbox(options.backup, 'harness-config');
  }
  const adapter = requireWriteAdapter(options.app);
  const sDir = resolveControlStateDir(options.stateDir);
  const target = `harness:${adapter.app}`;
  const resolvedBackupPath = options.backup ?? `${options.config}.routersync.bak`;

  const historyBefore = readApplyHistory(sDir);
  const activeBeforeIds = new Set(
    historyBefore.valid
      ? historyBefore.receipts.filter((r) => !r.rolledBack && r.target === target).map((r) => r.receiptId)
      : []
  );
  const candidates = historyBefore.valid
    ? historyBefore.receipts
        .filter(
          (receipt) =>
            receipt.target === target &&
            !receipt.rolledBack &&
            receipt.success &&
            receipt.readBackVerified &&
            /^[0-9a-f]{64}$/i.test(receipt.preDigest ?? '')
        )
        .reverse()
    : [];
  const inferredReceipt =
    options.expectedPreSha256 !== undefined
      ? candidates.find(
          (receipt) => receipt.preDigest?.toLowerCase() === options.expectedPreSha256!.toLowerCase()
        )
      : candidates.find(
          (receipt) => path.resolve(receipt.snapshotOrBackupRef) === path.resolve(resolvedBackupPath)
        );
  const effectiveExpectedSha = options.expectedPreSha256 ?? inferredReceipt?.preDigest;

  let res: Awaited<ReturnType<typeof adapter.rollback>>;
  try {
    res = await adapter.rollback({
      configPath: options.config,
      backupPath: options.backup,
      expectedPreSha256: effectiveExpectedSha,
    });
  } catch (err) {
    failAppsWrite(err instanceof Error ? err : new Error(String(err)), options.json);
  }

  if (!res.restored || !res.byteIdenticalToPreApply) {
    failAppsWrite(
      new Error(
        `[${res.app}] Rollback verification failed for ${target}: backup digest mismatch or restore incomplete.`
      ),
      options.json
    );
  }

  if (historyBefore.valid && activeBeforeIds.size > 0) {
    const expected = (effectiveExpectedSha ?? res.postSha256).toLowerCase();
    const receiptToVerify =
      candidates.find((receipt) => receipt.preDigest?.toLowerCase() === expected) ??
      candidates.find(
        (receipt) => path.resolve(receipt.snapshotOrBackupRef) === path.resolve(res.backupPath)
      );
    markApplyReceiptRolledBack(sDir, {
      target,
      snapshotOrBackupRef: receiptToVerify?.snapshotOrBackupRef ?? res.backupPath,
      verifyRollback: (receipt) => {
        const beforeDigest = receipt.preDigest;
        if (receipt.receiptId !== receiptToVerify?.receiptId || !beforeDigest) return undefined;
        return { beforeDigest: beforeDigest.toLowerCase(), afterDigest: res.postSha256.toLowerCase() };
      },
    });

    const historyAfter = readApplyHistory(sDir);
    if (historyAfter.valid) {
      const verifiedPivot = Boolean(
        receiptToVerify &&
          historyAfter.receipts.find((r) => r.receiptId === receiptToVerify.receiptId)
            ?.rollbackVerified === true
      );
      if (verifiedPivot) {
        const newlyRolledBack = historyAfter.receipts.filter(
          (r) => activeBeforeIds.has(r.receiptId) && r.rolledBack && (r.removedModels?.length ?? 0) > 0
        );
        if (newlyRolledBack.length > 0) {
          const effectiveHomeDir = resolveEffectiveHarnessHomeDir(res.configPath, undefined) ?? os.homedir();
          const restoredByProv = inspectHarnessConfiguredModels(
            adapter.app,
            res.configPath,
            effectiveHomeDir
          );
          reconcileRolledBackRemovalEpisodes(
            sDir,
            newlyRolledBack.map((r) => ({ target: r.target, proofs: r.removedModels ?? [] })),
            (_tgt, prov, modelId) => (restoredByProv.get(prov) ?? []).includes(modelId)
          );
        }
      }
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `[${res.app}] restored=${res.restored} byteIdenticalToPreApply=${res.byteIdenticalToPreApply} postSha256=${res.postSha256}\n`
  );
}
