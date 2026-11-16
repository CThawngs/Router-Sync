/**
 * packages/sources/src/discovery/shrink-guard.ts
 *
 * Safety Invariants for Model Catalog Discovery (P1-DEBT-04, P1-DEBT-05 / SPEC §23.2).
 *
 * Prevents catastrophic model deletion when providers experience transient network drops,
 * rate limits, or empty response anomalies.
 */

export interface ShrinkGuardOptions {
  /** Maximum allowed reduction ratio before freeze triggers (default 0.30 = 30%) */
  maxShrinkRatio?: number | undefined;
  /** Minimum previous count required before shrink ratio is enforced (default 5) */
  minCountThreshold?: number | undefined;
}

export interface ShrinkEvaluationResult {
  /** Whether the update must be frozen to protect existing catalog */
  frozen: boolean;
  /** Reduction ratio (0.00 to 1.00) */
  shrinkRatio: number;
  /** Human-readable explanation if frozen */
  reason?: string;
}

/**
 * P1-DEBT-05: Checks if the new model list shrunk too drastically compared to previous.
 */
export function evaluateModelListShrink(
  previousCount: number,
  currentCount: number,
  options?: ShrinkGuardOptions
): ShrinkEvaluationResult {
  const maxShrinkRatio = options?.maxShrinkRatio ?? 0.30;
  const minCountThreshold = options?.minCountThreshold ?? 5;

  if (previousCount < minCountThreshold) {
    return { frozen: false, shrinkRatio: 0 };
  }

  if (currentCount >= previousCount) {
    return { frozen: false, shrinkRatio: 0 };
  }

  const drop = previousCount - currentCount;
  const shrinkRatio = drop / previousCount;

  if (shrinkRatio > maxShrinkRatio) {
    return {
      frozen: true,
      shrinkRatio,
      reason: `Provider model list shrunk by ${(shrinkRatio * 100).toFixed(1)}% (from ${previousCount} down to ${currentCount}), exceeding safety cap of ${(maxShrinkRatio * 100).toFixed(0)}%. Updates frozen to prevent accidental deletion.`,
    };
  }

  return {
    frozen: false,
    shrinkRatio,
  };
}

export interface TrackedCatalogItem {
  id: string;
  status: 'active' | 'grace_period' | 'absent';
  consecutiveMissing: number;
  lastSeenAt: string;
}

export interface GraceCycleOptions {
  /** Minimum consecutive missing cycles before marking as absent (default 2) */
  graceCycles?: number | undefined;
}

/**
 * P1-DEBT-04: Enforces grace_cycles: models missing for < graceCycles are preserved
 * in 'grace_period', and only transition to 'absent' after >= graceCycles consecutive absences.
 */
export function applyGraceCycles(
  existingCatalog: TrackedCatalogItem[],
  incomingModelIds: string[],
  nowIso = new Date().toISOString(),
  options?: GraceCycleOptions
): TrackedCatalogItem[] {
  const graceCycles = options?.graceCycles ?? 2;
  const incomingSet = new Set(incomingModelIds);
  const updatedMap = new Map<string, TrackedCatalogItem>();

  // 1. Process existing catalog
  for (const item of existingCatalog) {
    if (incomingSet.has(item.id)) {
      updatedMap.set(item.id, {
        id: item.id,
        status: 'active',
        consecutiveMissing: 0,
        lastSeenAt: nowIso,
      });
    } else {
      const nextMissing = (item.consecutiveMissing || 0) + 1;
      const status = nextMissing >= graceCycles ? 'absent' : 'grace_period';
      updatedMap.set(item.id, {
        id: item.id,
        status,
        consecutiveMissing: nextMissing,
        lastSeenAt: item.lastSeenAt,
      });
    }
  }

  // 2. Add brand-new models
  for (const newId of incomingModelIds) {
    if (!updatedMap.has(newId)) {
      updatedMap.set(newId, {
        id: newId,
        status: 'active',
        consecutiveMissing: 0,
        lastSeenAt: nowIso,
      });
    }
  }

  return Array.from(updatedMap.values());
}
