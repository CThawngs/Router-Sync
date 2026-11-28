/**
 * packages/cli/src/commands/field-report-anomalies.ts
 *
 * Ticket C49-T2 (`Phục vụ: S9, S10`): Purely Data-Measured Anomaly Detector
 * (`anomalies.json`).
 *
 * Implements all 8 required canonical anomaly codes:
 *  1. `MODEL_FLAPPING`
 *  2. `PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH`
 *  3. `SCAN_COUNT_INTERVAL_DRIFT`
 *  4. `TICK_DURATION_SLOW`
 *  5. `COMBO_SHRINK_CAP_BLOCKED`
 *  6. `VACUOUS_DETECTION`
 *  7. `PROVIDER_ROUTER_LIST_MISMATCH`
 *  8. `COMBO_MODEL_MISSING_FROM_CATALOGS`
 */

export type FieldAnomalyCode =
  | 'MODEL_FLAPPING'
  | 'PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH'
  | 'SCAN_COUNT_INTERVAL_DRIFT'
  | 'TICK_DURATION_SLOW'
  | 'COMBO_SHRINK_CAP_BLOCKED'
  | 'VACUOUS_DETECTION'
  | 'PROVIDER_ROUTER_LIST_MISMATCH'
  | 'COMBO_MODEL_MISSING_FROM_CATALOGS'
  /** C52-R1: public registry unavailable; distinct from provider scan errors. */
  | 'REGISTRY_MISSING';

export type FieldAnomalySeverity = 'info' | 'warn' | 'high' | 'critical';

export interface FieldTimelineRecord {
  id: string;
  line: number;
  kind: 'tick' | 'apply' | 'rollback' | 'freeze' | 'unfreeze';
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  mode: string;
  outcome: string;
  sourceFile: string;
  metadata: Record<string, unknown>;
}

export interface LatencyDistribution {
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface FieldProviderSummary {
  providerId: string;
  scanCount: number;
  okCount: number;
  errorCount: number;
  errorCodes: Record<string, number>;
  latencyMs: LatencyDistribution;
  unverifiableCount: number;
  unverifiableRate: number;
  errorRate: number;
  errorEvidenceIds?: string[] | undefined;
  sourceFile?: string | undefined;
}

export interface FieldModelObservation {
  timestamp: string;
  status: 'present' | 'absent' | 'unverifiable';
  timelineId: string;
}

export interface FieldModelSummary {
  modelId: string;
  providerId: string;
  fullStep: string;
  observations: FieldModelObservation[];
  presentCount: number;
  absentCount: number;
  unverifiableCount: number;
  transitions: number;
  inCombos: string[];
}

export interface FieldComboSnapshot {
  router: string;
  name: string;
  models: string[];
  sourceFile: string;
}

export interface FieldCatalogSnapshot {
  ids: string[];
  verified?: boolean | undefined;
  sourceFile: string;
}

export interface FieldShrinkBlockObservation {
  targetId: string;
  blockedModels: string[];
  timelineId: string;
  sourceFile: string;
}

export interface FieldAnomalyThresholds {
  errorRateThreshold: number;
  expectedIntervalMs: number | null;
  intervalDriftToleranceRatio: number;
  slowTickMs: number;
  shrinkCapRatio: number;
}

export interface DetectFieldAnomaliesInput {
  timeline: readonly FieldTimelineRecord[];
  providers: readonly FieldProviderSummary[];
  models: readonly FieldModelSummary[];
  combos: readonly FieldComboSnapshot[];
  providerCatalogIds: Readonly<Record<string, FieldCatalogSnapshot>>;
  routerModelIds: Readonly<Record<string, FieldCatalogSnapshot>>;
  shrinkBlocks: readonly FieldShrinkBlockObservation[];
  thresholds: FieldAnomalyThresholds;
  windowBounds: {
    startMs: number | null;
    endMs: number | null;
  };
}

export interface FieldAnomalyEntry {
  code: FieldAnomalyCode;
  severity: FieldAnomalySeverity;
  subject: string;
  metrics: Record<string, unknown>;
  evidence: string[];
  sourceFile: string;
  message: string;
}

function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function fallbackEvidence(timeline: readonly FieldTimelineRecord[]): string[] {
  if (timeline.length > 0) {
    return [timeline[timeline.length - 1]!.id];
  }
  return ['line:0:empty-window'];
}

export function detectFieldAnomalies(input: DetectFieldAnomaliesInput): FieldAnomalyEntry[] {
  const anomalies: FieldAnomalyEntry[] = [];
  const tickEvents = input.timeline.filter((e) => e.kind === 'tick');

  // C52-R1: a missing public registry is its own root cause. Keep it out of
  // PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH so the two buckets stay comparable.
  const registryMissingTicks = tickEvents.filter(
    (e) => e.metadata?.['registryMissing'] === true
  );
  const registryMissingIds = new Set(registryMissingTicks.map((e) => e.id));
  if (registryMissingTicks.length > 0) {
    anomalies.push({
      code: 'REGISTRY_MISSING',
      severity: 'critical',
      subject: 'registry:providers',
      metrics: { affectedTicks: registryMissingTicks.length },
      evidence: [...registryMissingIds],
      sourceFile: 'tick.log',
      message:
        'Public registry unavailable in this install; provider counts are not trustworthy.',
    });
  }

  const totalProviderScans = input.providers.reduce(
    (acc, p) => acc + p.scanCount + p.unverifiableCount,
    0
  );

  // 6. VACUOUS_DETECTION: zero observed ticks or zero provider observations in window
  if (tickEvents.length === 0 || (input.providers.length === 0 && totalProviderScans === 0)) {
    anomalies.push({
      code: 'VACUOUS_DETECTION',
      severity: 'warn',
      subject: 'window:observation',
      metrics: {
        tickCount: tickEvents.length,
        providerCount: input.providers.length,
        totalProviderScans,
      },
      evidence:
        input.timeline.length > 0 ? [input.timeline[0]!.id] : ['line:0:empty-window'],
      sourceFile: 'status.json',
      message:
        'No measured tick/provider scan samples found in the selected observation window.',
    });
    return anomalies;
  }

  // 1. MODEL_FLAPPING: definite observation sequence transitions `absent -> present`
  for (const model of input.models) {
    const definite = model.observations.filter(
      (o) => o.status === 'present' || o.status === 'absent'
    );
    if (definite.length < 2) continue;

    let flapRecoveries = 0;
    let transitions = 0;
    const flapTimelineIds = new Set<string>();

    for (let i = 1; i < definite.length; i += 1) {
      const prev = definite[i - 1]!;
      const curr = definite[i]!;
      if (prev.status !== curr.status) {
        transitions += 1;
        flapTimelineIds.add(prev.timelineId);
        flapTimelineIds.add(curr.timelineId);
        if (prev.status === 'absent' && curr.status === 'present') {
          flapRecoveries += 1;
        }
      }
    }

    if (flapRecoveries > 0) {
      anomalies.push({
        code: 'MODEL_FLAPPING',
        severity: model.inCombos.length > 0 ? 'high' : 'warn',
        subject: `model:${model.fullStep}`,
        metrics: {
          presentCount: model.presentCount,
          absentCount: model.absentCount,
          transitions,
          flapRecoveries,
          inComboCount: model.inCombos.length,
        },
        evidence:
          flapTimelineIds.size > 0
            ? [...flapTimelineIds]
            : fallbackEvidence(tickEvents),
        sourceFile: 'tick.log',
        message: `Model ${model.fullStep} flapped absent -> present (${flapRecoveries} recovery transition(s) across ${definite.length} definite scans).`,
      });
    }
  }

  // 2. PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH: errorRate or unverifiableRate > threshold
  for (const prov of input.providers) {
    const totalAttempts = Math.max(prov.scanCount, prov.okCount + prov.errorCount);
    if (totalAttempts === 0 && prov.unverifiableCount === 0) continue;

    const exceedsError = prov.errorRate > input.thresholds.errorRateThreshold;
    const exceedsUnverifiable =
      prov.unverifiableRate > input.thresholds.errorRateThreshold;
    if (!exceedsError && !exceedsUnverifiable) continue;

    const evIds =
      prov.errorEvidenceIds && prov.errorEvidenceIds.length > 0
        ? [...new Set(prov.errorEvidenceIds)]
        : fallbackEvidence(tickEvents);
    if (registryMissingIds.size > 0 && evIds.every((id) => registryMissingIds.has(id))) continue;

    anomalies.push({
      code: 'PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH',
      severity:
        prov.errorRate >= 0.5 || prov.unverifiableRate >= 0.5 ? 'high' : 'warn',
      subject: `provider:${prov.providerId}`,
      metrics: {
        scanCount: prov.scanCount,
        okCount: prov.okCount,
        errorCount: prov.errorCount,
        unverifiableCount: prov.unverifiableCount,
        errorRate: roundMetric(prov.errorRate),
        unverifiableRate: roundMetric(prov.unverifiableRate),
        threshold: input.thresholds.errorRateThreshold,
        errorCodes: { ...prov.errorCodes },
      },
      evidence: evIds,
      sourceFile: prov.sourceFile ?? 'tick.log',
      message: `Provider ${prov.providerId} errorRate=${roundMetric(prov.errorRate)} / unverifiableRate=${roundMetric(prov.unverifiableRate)} exceeded threshold ${input.thresholds.errorRateThreshold}.`,
    });
  }

  // 3. SCAN_COUNT_INTERVAL_DRIFT: actual tick count deviates from expected schedule count
  if (
    input.thresholds.expectedIntervalMs !== null &&
    input.thresholds.expectedIntervalMs > 0 &&
    input.windowBounds.startMs !== null &&
    input.windowBounds.endMs !== null &&
    input.windowBounds.endMs > input.windowBounds.startMs
  ) {
    const spanMs = input.windowBounds.endMs - input.windowBounds.startMs;
    const intervalMs = input.thresholds.expectedIntervalMs;
    if (spanMs >= intervalMs) {
      const lastTickMs = Date.parse(tickEvents[tickEvents.length - 1]!.startedAt);
      const rawIntervals = spanMs / intervalMs;
      const endsAtTickBoundary =
        Number.isFinite(lastTickMs) &&
        Math.abs(input.windowBounds.endMs - lastTickMs) <= intervalMs * 0.25;
      const expectedCount = endsAtTickBoundary
        ? Math.max(1, Math.round(rawIntervals) + 1)
        : Math.max(1, Math.round(rawIntervals));
      const actualCount = tickEvents.length;
      const driftRatio = Math.abs(actualCount - expectedCount) / expectedCount;

      if (driftRatio > input.thresholds.intervalDriftToleranceRatio) {
        const firstEv = tickEvents[0]!.id;
        const lastEv = tickEvents[tickEvents.length - 1]!.id;
        anomalies.push({
          code: 'SCAN_COUNT_INTERVAL_DRIFT',
          severity: driftRatio >= 0.75 ? 'high' : 'warn',
          subject: 'scheduler:tick-interval',
          metrics: {
            actualTickCount: actualCount,
            expectedTickCount: expectedCount,
            expectedIntervalMs: intervalMs,
            windowSpanMs: spanMs,
            driftRatio: roundMetric(driftRatio),
            toleranceRatio: input.thresholds.intervalDriftToleranceRatio,
          },
          evidence: firstEv === lastEv ? [firstEv] : [firstEv, lastEv],
          sourceFile: 'tick.log',
          message: `Observed ${actualCount} tick(s) over ${Math.round(spanMs / 60_000)}m window vs expected ${expectedCount} (driftRatio=${roundMetric(driftRatio)}).`,
        });
      }
    }
  }

  // 4. TICK_DURATION_SLOW: tick durationMs exceeds slowTickMs threshold
  const slowTicks = tickEvents.filter(
    (t) => typeof t.durationMs === 'number' && t.durationMs > input.thresholds.slowTickMs
  );
  if (slowTicks.length > 0) {
    const durations = slowTicks.map((t) => t.durationMs as number);
    const maxDurationMs = Math.max(...durations);
    anomalies.push({
      code: 'TICK_DURATION_SLOW',
      severity: maxDurationMs >= input.thresholds.slowTickMs * 2 ? 'high' : 'warn',
      subject: 'runtime:tick-duration',
      metrics: {
        slowTickCount: slowTicks.length,
        totalTickCount: tickEvents.length,
        maxDurationMs,
        slowTickThresholdMs: input.thresholds.slowTickMs,
      },
      evidence: slowTicks.map((t) => t.id),
      sourceFile: slowTicks[0]!.sourceFile || 'tick.log',
      message: `${slowTicks.length} tick(s) exceeded slowTickMs=${input.thresholds.slowTickMs}ms (max=${maxDurationMs}ms).`,
    });
  }

  // 5. COMBO_SHRINK_CAP_BLOCKED: removal blocked by 10% shrink cap ceiling
  if (input.shrinkBlocks.length > 0) {
    const byTarget = new Map<
      string,
      { models: Set<string>; evidence: Set<string>; sourceFile: string }
    >();
    for (const blk of input.shrinkBlocks) {
      const existing = byTarget.get(blk.targetId) ?? {
        models: new Set<string>(),
        evidence: new Set<string>(),
        sourceFile: blk.sourceFile,
      };
      for (const m of blk.blockedModels) existing.models.add(m);
      if (blk.timelineId) existing.evidence.add(blk.timelineId);
      byTarget.set(blk.targetId, existing);
    }

    for (const [targetId, info] of byTarget.entries()) {
      const blockedModels = [...info.models].sort();
      anomalies.push({
        code: 'COMBO_SHRINK_CAP_BLOCKED',
        severity: 'high',
        subject: `combo:${targetId}`,
        metrics: {
          blockedModelCount: blockedModels.length,
          blockedModels,
          shrinkCapRatio: input.thresholds.shrinkCapRatio,
        },
        evidence:
          info.evidence.size > 0 ? [...info.evidence] : fallbackEvidence(tickEvents),
        sourceFile: info.sourceFile,
        message: `Target ${targetId} had ${blockedModels.length} removal candidate(s) blocked by the ${(input.thresholds.shrinkCapRatio * 100).toFixed(0)}% shrink ceiling.`,
      });
    }
  }

  // 7. PROVIDER_ROUTER_LIST_MISMATCH: upstream provider catalog != router-registered list
  for (const [providerId, provSnap] of Object.entries(input.providerCatalogIds)) {
    if (provSnap.verified === false) continue;
    const routerSnap = input.routerModelIds[providerId];
    if (!routerSnap) continue;

    const provSet = new Set(provSnap.ids);
    const routerSet = new Set(routerSnap.ids);
    const onlyInProvider = provSnap.ids.filter((id) => !routerSet.has(id)).sort();
    const onlyInRouter = routerSnap.ids.filter((id) => !provSet.has(id)).sort();

    if (onlyInProvider.length > 0 || onlyInRouter.length > 0) {
      anomalies.push({
        code: 'PROVIDER_ROUTER_LIST_MISMATCH',
        severity: onlyInRouter.length > 0 ? 'warn' : 'info',
        subject: `provider:${providerId}`,
        metrics: {
          providerModelCount: provSnap.ids.length,
          routerModelCount: routerSnap.ids.length,
          onlyInProviderCount: onlyInProvider.length,
          onlyInRouterCount: onlyInRouter.length,
          sampleOnlyInProvider: onlyInProvider.slice(0, 10),
          sampleOnlyInRouter: onlyInRouter.slice(0, 10),
        },
        evidence: fallbackEvidence(tickEvents),
        sourceFile: routerSnap.sourceFile || provSnap.sourceFile,
        message: `Provider ${providerId} catalog (${provSnap.ids.length}) differs from router model list (${routerSnap.ids.length}): +${onlyInProvider.length} upstream-only, +${onlyInRouter.length} router-only.`,
      });
    }
  }

  // 8. COMBO_MODEL_MISSING_FROM_CATALOGS: active combo references model absent from all catalogs
  for (const combo of input.combos) {
    const missingSteps: string[] = [];
    for (const fullStep of combo.models) {
      const slashIdx = fullStep.indexOf('/');
      if (slashIdx <= 0 || slashIdx >= fullStep.length - 1) continue;
      const prefix = fullStep.slice(0, slashIdx);
      const modelId = fullStep.slice(slashIdx + 1);

      const provSnap = input.providerCatalogIds[prefix];
      if (!provSnap || provSnap.verified === false) {
        // Never flag unscanned or unverifiable providers as missing catalog models
        continue;
      }
      const inProv = provSnap.ids.includes(modelId);
      const routerSnap = input.routerModelIds[prefix];
      const inRouter = routerSnap ? routerSnap.ids.includes(modelId) : false;

      if (!inProv && !inRouter) {
        missingSteps.push(fullStep);
      }
    }

    if (missingSteps.length > 0) {
      const uniqueMissing = [...new Set(missingSteps)].sort();
      anomalies.push({
        code: 'COMBO_MODEL_MISSING_FROM_CATALOGS',
        severity: 'high',
        subject: `combo:${combo.router}/${combo.name}`,
        metrics: {
          comboModelCount: combo.models.length,
          missingModelCount: uniqueMissing.length,
          missingModels: uniqueMissing,
        },
        evidence: fallbackEvidence(tickEvents),
        sourceFile: combo.sourceFile || 'tick-catalog.json',
        message: `Combo ${combo.router}/${combo.name} references ${uniqueMissing.length} model(s) absent from verified catalogs: ${uniqueMissing.join(', ')}.`,
      });
    }
  }

  return anomalies;
}
