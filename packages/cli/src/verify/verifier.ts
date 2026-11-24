/**
 * packages/cli/src/verify/verifier.ts
 *
 * Implements the VERIFY phase (Round C4b F3b + C45-WP3):
 *  - 6+ canonical labels: ĐÃ-XÁC-NHẬN-CÒN, ĐÃ-XÁC-NHẬN-NGỪNG, SẮP-NGỪNG, NGHI-NGỪNG, CHƯA-XÁC-MINH, QUOTA, CHƯA-QUÉT
 *  - ABSENT-STABLE classification for gateways without single-model GET endpoints (F4)
 *  - NEW-CANDIDATE proposal generator for combos & agent configs (F5)
 *  - C45-WP3: Official vs Secondary research evidence joining, 10% target shrink cap
 *    (`TARGET_REMOVAL_MAX_SHRINK_RATIO = 0.10`), `UNVERIFIABLE != ABSENT` helper, and
 *    `computeDetectionLatencyMs` / `summarizeDetectionLatencies`
 *  - Deterministic accounting line: `VERIFY requests=<n> paid=0 tokens=0 llm-calls=0`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  atomicWriteFileSync,
  canonicalizeResearchProvider,
  loadResearchEvidence,
  type ResearchEvidenceRecord,
} from '@routersync/core';
import type {
  VerificationLabel,
  ModelVerificationRecord,
  AbsentStableCheckInput,
  AbsentStableResult,
  NewCandidateProposal,
  VerifyPhaseSummary,
  VerifyAccounting,
  DetectionLatencyInput,
  DetectionLatencySummary,
  ShrinkCapEvaluation,
} from './types.js';
import { runL2Scan, PROVIDER_ALIASES, type L2ScannerOptions } from './l2-scanner.js';
import { runL3Scan, type L3ScannerOptions } from './l3-scanner.js';
import { isBlacklisted } from '../rank/filters.js';
import { loadRankingConfig } from '../rank/config.js';

export const TARGET_REMOVAL_MAX_SHRINK_RATIO = 0.10;

export const UNVERIFIABLE_SCAN_STATES = new Set<string>([
  'UNVERIFIABLE',
  'CHƯA-XÁC-MINH',
  'CHƯA-QUÉT',
  'UPSTREAM-UNREACHABLE',
  'ACCESS-RESTRICTED-OR-ABSENT',
  'QUOTA',
  'QUOTA-NO-LIST',
  'AUTH_ERROR',
  'TRANSIENT',
  'PROXY_DELEGATED',
  'SKIPPED',
  'BACKOFF',
  'SHRINK-GUARD-BLOCKED',
]);

export function isUnverifiableScanState(stateOrLabel: string | null | undefined): boolean {
  if (!stateOrLabel) return false;
  return UNVERIFIABLE_SCAN_STATES.has(stateOrLabel.trim());
}

export function computeDetectionLatencyMs(input: DetectionLatencyInput): number | null {
  const sourceRaw = input.sourcePublishedAt ?? input.sourceFirstChangedAt ?? null;
  if (!sourceRaw || typeof sourceRaw !== 'string' || sourceRaw.trim().length === 0) {
    return null;
  }
  const planMs = Date.parse(input.planCreatedAt);
  const sourceMs = Date.parse(sourceRaw);
  if (!Number.isFinite(planMs) || !Number.isFinite(sourceMs)) {
    return null;
  }
  return Math.max(0, planMs - sourceMs);
}

export function summarizeDetectionLatencies(
  latencies: Array<number | null | undefined>
): DetectionLatencySummary {
  const valid = latencies
    .filter((val): val is number => typeof val === 'number' && Number.isFinite(val) && val >= 0)
    .sort((a, b) => a - b);
  if (valid.length === 0) {
    return {
      measuredCount: 0,
      minMs: null,
      maxMs: null,
      p50Ms: null,
    };
  }
  const minMs = valid[0]!;
  const maxMs = valid[valid.length - 1]!;
  const midIdx = Math.floor((valid.length - 1) / 2);
  return {
    measuredCount: valid.length,
    minMs,
    maxMs,
    p50Ms: valid[midIdx]!,
  };
}

export function enforceTargetShrinkCap(
  targetType: 'router' | 'harness',
  currentCount: number,
  dropCount: number
): ShrinkCapEvaluation {
  const minRemainingRequired = targetType === 'router' ? 2 : 1;
  if (dropCount <= 0) {
    return {
      allowed: true,
      shrinkRatio: 0,
      remainingCount: currentCount,
      minRemainingRequired,
    };
  }
  const denom = Math.max(1, currentCount);
  const shrinkRatio = dropCount / denom;
  const remainingCount = currentCount - dropCount;

  if (shrinkRatio > TARGET_REMOVAL_MAX_SHRINK_RATIO) {
    return {
      allowed: false,
      shrinkRatio,
      remainingCount,
      minRemainingRequired,
      reason: `shrinkRatio=${(shrinkRatio * 100).toFixed(1)}% > ${(TARGET_REMOVAL_MAX_SHRINK_RATIO * 100).toFixed(0)}%`,
    };
  }
  if (currentCount > 0 && remainingCount < minRemainingRequired) {
    return {
      allowed: false,
      shrinkRatio,
      remainingCount,
      minRemainingRequired,
      reason: `remainingCount=${remainingCount} < ${minRemainingRequired}`,
    };
  }
  return {
    allowed: true,
    shrinkRatio,
    remainingCount,
    minRemainingRequired,
  };
}

export interface VerifyPhaseOptions {
  stateDir?: string | undefined;
  nowMs?: number | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
  models?: Array<{
    id: string;
    prefix: string;
    l1Status?: number | undefined;
    l1Exists?: number | boolean | undefined;
    absenceCount?: number | undefined;
    firstAbsentAtMs?: number | undefined;
    lastSeenAt?: string | undefined;
    lastLabel?: string | undefined;
    comboStepCount?: number | undefined;
    dropCount?: number | undefined;
    isAdded?: boolean | undefined;
    isUnscanned?: boolean | undefined;
    unscannedReason?: string | undefined;
  }> | undefined;
  addedModelIds?: Set<string> | undefined;
  combos?: Array<{ name: string; router: string; models: string[] }> | undefined;
  agents?: Array<{ name: string; client: string; model?: string }> | undefined;
  coveredProviders?: Record<string, boolean> | undefined;
  evidenceRecords?: ResearchEvidenceRecord[] | undefined;
  l2Options?: L2ScannerOptions | undefined;
  l3Options?: L3ScannerOptions | undefined;
  silent?: boolean | undefined;
}

export function classifyVerificationLabel(
  l1: { exists: boolean; status: number; absenceCount: number; isUnscanned?: boolean | undefined; unscannedReason?: string | undefined },
  l2: { exists: boolean },
  l3: { hasNotice: boolean; noticeType?: string | undefined },
  providerCovered: boolean
): VerificationLabel {
  // 0. If provider was not scanned or skipped (Round C4d B4 & C45-WP3 UNVERIFIABLE != ABSENT)
  if (l1.isUnscanned) {
    return 'CHƯA-QUÉT';
  }

  // 1. If HTTP 429 received
  if (l1.status === 429) {
    return l1.exists ? 'QUOTA' : 'QUOTA-NO-LIST';
  }

  // 1b. Non-authoritative HTTP failures (401/403/5xx/0) must never become NGHI-NGỪNG or ĐÃ-XÁC-NHẬN-NGỪNG
  if (l1.status === 0 || (l1.status >= 400 && l1.status !== 404)) {
    return 'CHƯA-XÁC-MINH';
  }

  // 2. If present in L1 scan with valid key
  if (l1.exists) {
    if (l3.hasNotice && l3.noticeType === 'upcoming_deprecation') {
      return 'SẮP-NGỪNG';
    }
    return 'ĐÃ-XÁC-NHẬN-CÒN';
  }

  // 3. Absent in L1 scan
  if (!providerCovered) {
    return 'CHƯA-XÁC-MINH';
  }

  // A5: Confirmed deprecation notice in L3 requires absenceCount >= 2 for ĐÃ-XÁC-NHẬN-NGỪNG
  if (l3.hasNotice && l3.noticeType === 'deprecated') {
    if (l1.absenceCount >= 2) {
      return 'ĐÃ-XÁC-NHẬN-NGỪNG';
    }
    return 'NGHI-NGỪNG';
  }

  // Stably absent on L1 (>= 2 cycles), but no L2/L3 confirmation
  if (l1.absenceCount >= 2) {
    return 'NGHI-NGỪNG';
  }

  return 'CHƯA-XÁC-MINH';
}

export function evaluateAbsentStable(input: AbsentStableCheckInput): AbsentStableResult {
  const reasons: string[] = [];
  const hoursAbsent = (input.nowMs - input.firstAbsentAtMs) / (3600 * 1000);

  // 0. UNVERIFIABLE != ABSENT guard
  if (isUnverifiableScanState(input.lastLabel)) {
    reasons.push(`lastLabel=${input.lastLabel} is unverifiable/non-authoritative`);
  }

  // 1. Absent in >= 3 scans
  if (input.absenceCount < 3) {
    reasons.push(`absenceCount=${input.absenceCount} < 3`);
  }

  // 2. Spanning >= 24h
  if (hoursAbsent < 24) {
    reasons.push(`hoursAbsent=${hoursAbsent.toFixed(1)} < 24h`);
  }

  // 3. Not in independent external source when provider is covered
  if (input.providerCoveredByExternal && input.l2ExternalExists) {
    reasons.push(`model still exists in independent external source (CÒN-Ở-NGUỒN-NGOÀI)`);
  }

  // 4. Shrinking <= TARGET_REMOVAL_MAX_SHRINK_RATIO (10%) per combo per cycle
  const stepCount = Math.max(1, input.comboStepCount);
  const shrinkRatio = input.dropCount / stepCount;
  if (shrinkRatio > TARGET_REMOVAL_MAX_SHRINK_RATIO) {
    reasons.push(
      `Hạn mức co rút (shrinkRatio=${(shrinkRatio * 100).toFixed(1)}% > ${(TARGET_REMOVAL_MAX_SHRINK_RATIO * 100).toFixed(0)}%)`
    );
  }

  // 5. Combo retains >= 2 steps (Invariant I3)
  const remaining = input.comboStepCount - input.dropCount;
  if (input.comboStepCount > 0 && remaining < 2) {
    reasons.push(`remainingSteps=${remaining} < 2 (Invariant I3)`);
  }

  const isAbsentStable = reasons.length === 0;
  return {
    isAbsentStable,
    reasons,
    canAutoRemove: isAbsentStable,
  };
}

export function evaluateNewCandidateProposals(
  candidates: Array<{
    id: string;
    prefix: string;
    pricing?: Record<string, unknown> | undefined;
    label?: string | undefined;
    isZeroPriceHidden?: boolean | undefined;
    evidenceUrl?: string | null | undefined;
  }>,
  combos: Array<{ name: string; router: string; models: string[] }> = [],
  agents: Array<{ name: string; client: string; model?: string | undefined }> = [],
  blacklistPatterns: string[] = []
): NewCandidateProposal[] {
  const proposals: NewCandidateProposal[] = [];
  const nowIso = new Date().toISOString();

  for (const c of candidates) {
    const fullStep = `${c.prefix}/${c.id}`;

    if (c.label === 'SẮP-NGỪNG' || c.label === 'QUOTA' || c.label === 'ĐÃ-XÁC-NHẬN-NGỪNG') {
      continue;
    }

    if (
      blacklistPatterns.length > 0 &&
      (isBlacklisted(c.id, blacklistPatterns) || isBlacklisted(fullStep, blacklistPatterns))
    ) {
      continue;
    }

    const targetCombos: NewCandidateProposal['targetCombos'] = [];
    for (const combo of combos) {
      const usesPrefix = combo.models.some((m) => m.startsWith(`${c.prefix}/`));
      if (usesPrefix && !combo.models.includes(fullStep)) {
        targetCombos.push({
          comboName: combo.name,
          router: combo.router,
          proposedRankIndex: combo.models.length + 1,
        });
      }
    }

    const targetAgents: NewCandidateProposal['targetAgents'] = [];
    for (const ag of agents) {
      if (ag.model && ag.model.startsWith(`${c.prefix}/`)) {
        targetAgents.push({
          agentName: ag.name,
          client: ag.client,
          proposedAction: 'add',
        });
      }
    }

    const p = c.pricing as Record<string, unknown> | undefined;
    const promptCost = p ? Number(p['prompt'] ?? p['input_cost_per_token'] ?? 0) : undefined;
    const compCost = p ? Number(p['completion'] ?? p['cost_per_token'] ?? 0) : undefined;
    const zeroPriceHidden = Boolean(
      c.isZeroPriceHidden ||
        (promptCost === 0 &&
          compCost === 0 &&
          !c.id.toLowerCase().endsWith('-free') &&
          !c.id.toLowerCase().endsWith(':free'))
    );
    const isFree = zeroPriceHidden ? false : promptCost === 0 && compCost === 0;

    proposals.push({
      id: `prop-new-${c.prefix}-${c.id}`,
      prefix: c.prefix,
      fullStep,
      discoveredAt: nowIso,
      targetCombos,
      targetAgents,
      pricing: {
        prompt: promptCost,
        completion: compCost,
        free: isFree,
        isZeroPriceHidden: zeroPriceHidden,
      },
      evidenceUrl: c.evidenceUrl ?? null,
    });
  }

  return proposals;
}

function selectNewestEvidence(records: ResearchEvidenceRecord[]): ResearchEvidenceRecord | undefined {
  if (records.length === 0) return undefined;
  return [...records].sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))[0];
}

export async function runVerifyPhase(options: VerifyPhaseOptions = {}): Promise<VerifyPhaseSummary> {
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const sDir = options.stateDir ?? path.join(process.cwd(), '.routersync');
  if (!fs.existsSync(sDir)) fs.mkdirSync(sDir, { recursive: true });

  const evidenceRecords = options.evidenceRecords ?? loadResearchEvidence(sDir);

  // 1. Run L2 scan (cached 1h)
  const l2Res = await runL2Scan({
    stateDir: sDir,
    nowMs,
    fetchFn: options.fetchFn,
    ...options.l2Options,
  });

  // 2. Run L3 scan (cached 24h)
  const l3Res = await runL3Scan({
    stateDir: sDir,
    nowMs,
    fetchFn: options.fetchFn,
    ...options.l3Options,
  });

  const totalRequests = l2Res.requests + l3Res.requests;

  // 3. Classify models
  const models = options.models ?? [];
  const labelCounts: Record<VerificationLabel, number> = {
    'ĐÃ-XÁC-NHẬN-CÒN': 0,
    'ĐÃ-XÁC-NHẬN-NGỪNG': 0,
    'SẮP-NGỪNG': 0,
    'NGHI-NGỪNG': 0,
    'CHƯA-XÁC-MINH': 0,
    'QUOTA': 0,
    'CHƯA-QUÉT': 0,
    'QUOTA-NO-LIST': 0,
  };

  const records: ModelVerificationRecord[] = [];
  const absentStableCandidates: string[] = [];
  const newCandidateItems: Array<{
    id: string;
    prefix: string;
    pricing?: Record<string, unknown> | undefined;
    label?: string | undefined;
    isZeroPriceHidden?: boolean | undefined;
    evidenceUrl?: string | null | undefined;
  }> = [];

  const hasAddedFilter = Boolean(
    options.addedModelIds || models.some((x) => x.isAdded !== undefined)
  );

  for (const m of models) {
    const fullStep = `${m.prefix}/${m.id}`;
    const isUnscanned = m.isUnscanned ?? (m.l1Status === 0);
    const unscannedReason = m.unscannedReason;
    const l1Exists = Boolean(m.l1Exists ?? (m.l1Status === 200));
    const l1Status = m.l1Status ?? (isUnscanned ? 0 : l1Exists ? 200 : 404);
    const absenceCount = isUnscanned ? 0 : (m.absenceCount ?? (l1Exists ? 0 : 1));

    const aliasPrefix = PROVIDER_ALIASES[m.prefix.toLowerCase()];
    const aliasStep = aliasPrefix ? `${aliasPrefix}/${m.id}` : undefined;
    const l2Entry =
      l2Res.state.models[m.id] ??
      l2Res.state.models[fullStep] ??
      (aliasStep ? l2Res.state.models[aliasStep] : undefined);
    const l2Exists = Boolean(l2Entry);

    const mIdLower = m.id.toLowerCase();
    const fullStepLower = fullStep.toLowerCase();
    const l3Notice = l3Res.state.notices.find((n) => {
      const matchInTokens = n.modelMatches.some((token) => {
        const tLower = token.toLowerCase();
        return mIdLower === tLower || fullStepLower === tLower;
      });
      if (matchInTokens) return true;

      const escaped = mIdLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[^a-zA-Z0-9_.-])${escaped}([^a-zA-Z0-9_.-]|$)`, 'i');
      return regex.test(n.title);
    });

    const coveredSet = new Set([
      'google',
      'gemini',
      'openai',
      'anthropic',
      'meta',
      'deepseek',
      'openrouter',
    ]);
    const providerCovered =
      options.coveredProviders?.[m.prefix] ??
      (l2Exists ||
        coveredSet.has(m.prefix.toLowerCase()) ||
        (aliasPrefix ? coveredSet.has(aliasPrefix.toLowerCase()) : false));

    let label = classifyVerificationLabel(
      { exists: l1Exists, status: l1Status, absenceCount, isUnscanned, unscannedReason },
      { exists: l2Exists },
      { hasNotice: Boolean(l3Notice), noticeType: l3Notice?.noticeType },
      providerCovered
    );

    const flags: string[] = [];
    if (l2Entry?.isZeroPriceHidden) flags.push('ẨN-GIÁ-0');
    if (!isUnscanned && !l1Exists && l2Exists) flags.push('CÒN-Ở-NGUỒN-NGOÀI');

    // Join C45-WP3 research-evidence.json records
    const canonPrefix = canonicalizeResearchProvider(m.prefix);
    const matchingEvidence = evidenceRecords.filter(
      (ev) => ev.id === fullStep || (ev.provider === canonPrefix && ev.modelId === m.id)
    );
    const officialEv = selectNewestEvidence(
      matchingEvidence.filter((ev) => ev.sourceTier === 'official' && ev.domainVerified)
    );
    const secondaryEv = selectNewestEvidence(
      matchingEvidence.filter((ev) => ev.sourceTier === 'secondary')
    );

    if (officialEv) {
      flags.push('BẰNG-CHỨNG-OFFICIAL');
      const shutdownMs = officialEv.shutdownDate ? Date.parse(officialEv.shutdownDate) : null;
      if (
        officialEv.verdict === 'deprecated' &&
        (shutdownMs === null || (Number.isFinite(shutdownMs) && shutdownMs <= nowMs))
      ) {
        label = 'ĐÃ-XÁC-NHẬN-NGỪNG';
      } else if (
        officialEv.verdict === 'upcoming_deprecation' ||
        (officialEv.verdict === 'deprecated' &&
          shutdownMs !== null &&
          Number.isFinite(shutdownMs) &&
          shutdownMs > nowMs)
      ) {
        label = 'SẮP-NGỪNG';
      } else if (officialEv.verdict === 'active' && l1Exists) {
        label = 'ĐÃ-XÁC-NHẬN-CÒN';
      }
    }
    if (secondaryEv) {
      flags.push('BẰNG-CHỨNG-SECONDARY');
    }

    labelCounts[label]++;

    records.push({
      id: m.id,
      prefix: m.prefix,
      fullStep,
      label,
      unscannedReason:
        label === 'CHƯA-QUÉT' ? (unscannedReason ?? 'chưa-quét-nhà-cung-cấp') : undefined,
      l1: {
        exists: l1Exists,
        status: l1Status,
        absenceCount,
        lastSeenAt: m.lastSeenAt,
      },
      l2: {
        exists: l2Exists,
        price: l2Entry?.price ?? null,
        isZeroPriceHidden: l2Entry?.isZeroPriceHidden ?? false,
        source: l2Entry?.source,
        url: l2Entry ? 'https://models.dev' : undefined,
      },
      l3: {
        hasNotice: Boolean(l3Notice),
        noticeType: l3Notice?.noticeType,
        noticeDate: l3Notice?.date,
        noticeTitle: l3Notice?.title,
        url: l3Notice?.url,
      },
      flags,
      verifiedAt: nowIso,
    });

    const isNewlyAdded = options.addedModelIds
      ? options.addedModelIds.has(m.id) || options.addedModelIds.has(fullStep)
      : hasAddedFilter
        ? Boolean(m.isAdded)
        : l1Exists && absenceCount === 0;

    if (
      isNewlyAdded &&
      l1Exists &&
      absenceCount === 0 &&
      label !== 'SẮP-NGỪNG' &&
      label !== 'QUOTA' &&
      label !== 'ĐÃ-XÁC-NHẬN-NGỪNG'
    ) {
      newCandidateItems.push({
        id: m.id,
        prefix: m.prefix,
        pricing: l2Entry?.rawPricing,
        label,
        isZeroPriceHidden: Boolean(l2Entry?.isZeroPriceHidden),
        evidenceUrl: l2Entry ? 'https://models.dev' : (l3Notice?.url ?? null),
      });
    }

    if (!isUnscanned && !l1Exists && absenceCount >= 3) {
      const firstAbsentMs = m.firstAbsentAtMs ?? nowMs - 25 * 3600 * 1000;
      const asCheck = evaluateAbsentStable({
        id: m.id,
        prefix: m.prefix,
        absenceCount,
        firstAbsentAtMs: firstAbsentMs,
        nowMs,
        lastLabel: m.lastLabel ?? 'ABSENT',
        l2ExternalExists: l2Exists,
        providerCoveredByExternal: providerCovered,
        comboStepCount: m.comboStepCount ?? 5,
        dropCount: m.dropCount ?? 1,
      });
      if (asCheck.isAbsentStable) {
        absentStableCandidates.push(fullStep);
      }
    }
  }

  const rankCfg = loadRankingConfig(undefined, { quiet: true });
  const blacklistPatterns = rankCfg.config.blacklist ?? [];
  if (blacklistPatterns.length === 0 && !options.silent) {
    console.log('BLACKLIST=none');
  }

  const proposals = evaluateNewCandidateProposals(
    newCandidateItems,
    options.combos ?? [],
    options.agents ?? [],
    blacklistPatterns
  );

  const accounting: VerifyAccounting = {
    requests: totalRequests,
    paidRequests: 0,
    tokens: 0,
    llmCalls: 0,
  };

  const summary: VerifyPhaseSummary = {
    timestamp: nowIso,
    modelsVerified: models.length,
    labels: labelCounts,
    records,
    proposals,
    absentStableCandidates,
    accounting,
  };

  const verifyStatusPath = path.join(sDir, 'verify-status.json');
  atomicWriteFileSync(verifyStatusPath, JSON.stringify(summary, null, 2));

  if (!options.silent) {
    console.log(
      `VERIFY-SUMMARY models=${models.length} remaining=${summary.absentStableCandidates.length} proposals=${proposals.length}`
    );
    for (const [k, count] of Object.entries(labelCounts)) {
      console.log(`  LABEL ${k}: ${count}`);
    }
    if (proposals.length > 0) {
      console.log(`  PROPOSALS (F5): ${proposals.length} combo/agent updates staged`);
    }
    if (absentStableCandidates.length > 0) {
      console.log(`  ABSENT-STABLE (F4): ${absentStableCandidates.join(', ')}`);
    }
    console.log(
      `VERIFY requests=${accounting.requests} paid=0 tokens=${accounting.tokens} llm-calls=${accounting.llmCalls}`
    );
  }

  return summary;
}
