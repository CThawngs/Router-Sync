/**
 * packages/core/src/applier/index.ts
 * 
 * Safe Write Protocol implementation for applying combo plans to routers.
 * Protocol: Dry-run -> Snapshot -> Write -> Read-back Verification -> Automatic Rollback.
 */

import type { RouterAdapter, ApplyResult, Plan } from '@routersync/adapter-sdk';

export interface ApplySafeOptions {
  dryRun?: boolean;
  approvalToken?: string;
  expectedToken?: string;
}

export interface MultiRouterTarget {
  adapter: RouterAdapter;
  plan: Plan;
}

export interface MultiRouterApplyResult {
  mode: 'dry-run' | 'live-write';
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  results: ApplyResult[];
  timestamp: string;
}

/**
 * Applies plans to multiple independent routers in parallel with Promise.allSettled (AT-4).
 * A failure on one router never cancels or rolls back the other router.
 */
export async function applyMultiRouterSafe(
  targets: MultiRouterTarget[],
  options: ApplySafeOptions = { dryRun: true }
): Promise<MultiRouterApplyResult> {
  const timestamp = new Date().toISOString();
  const dryRun = options.dryRun ?? true;

  const settled = await Promise.allSettled(
    targets.map((t) => executeSingleApply(t.adapter, t.plan, options))
  );

  const results: ApplyResult[] = settled.map((s, idx) => {
    if (s.status === 'fulfilled') {
      return s.value;
    }
    const target = targets[idx]?.adapter.name ?? 'unknown';
    const planId = targets[idx]?.plan.id ?? '';
    return {
      success: false,
      target,
      appliedAt: timestamp,
      planId,
      readBackVerified: false,
      staleDetected: false,
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  });

  const successCount = results.filter((r) => r.success).length;
  let status: MultiRouterApplyResult['status'] = 'SUCCESS';
  if (results.length > 0) {
    if (successCount === 0) {
      status = 'FAILED';
    } else if (successCount < results.length) {
      status = 'PARTIAL';
    }
  }

  return {
    mode: dryRun ? 'dry-run' : 'live-write',
    status,
    results,
    timestamp,
  };
}

/**
 * Executes a Plan against a router adapter (or array of targets) following the Safe Write Protocol.
 */
export async function applyPlanSafe(
  adapter: RouterAdapter,
  plan: Plan,
  options?: ApplySafeOptions
): Promise<ApplyResult>;
export async function applyPlanSafe(
  targets: MultiRouterTarget[],
  options?: ApplySafeOptions
): Promise<MultiRouterApplyResult>;
export async function applyPlanSafe(
  adapterOrTargets: RouterAdapter | MultiRouterTarget[],
  planOrOptions?: Plan | ApplySafeOptions,
  options?: ApplySafeOptions
): Promise<ApplyResult | MultiRouterApplyResult> {
  if (Array.isArray(adapterOrTargets)) {
    return applyMultiRouterSafe(adapterOrTargets, planOrOptions as ApplySafeOptions);
  }
  return executeSingleApply(adapterOrTargets, planOrOptions as Plan, options);
}

async function executeSingleApply(
  adapter: RouterAdapter,
  plan: Plan,
  options: ApplySafeOptions = { dryRun: true }
): Promise<ApplyResult> {
  const appliedAt = new Date().toISOString();
  const dryRun = options.dryRun ?? true;

  // 1. Dry-run by default
  if (dryRun) {
    return {
      success: true,
      target: adapter.name,
      appliedAt,
      planId: plan.id,
      readBackVerified: true,
      staleDetected: false,
    };
  }

  // Enforce human approval token check if expected
  if (options.expectedToken) {
    if (!options.approvalToken || options.approvalToken !== options.expectedToken) {
      return {
        success: false,
        target: adapter.name,
        appliedAt,
        planId: plan.id,
        readBackVerified: false,
        staleDetected: false,
        error: 'Missing or invalid human approval token (Rule §28.1 / R11)',
      };
    }
  }

  // 2. Check for empty plan (No-op)
  if (plan.additions.length === 0 && plan.modifications.length === 0 && plan.deletions.length === 0) {
    return {
      success: true,
      target: adapter.name,
      appliedAt,
      planId: plan.id,
      readBackVerified: true,
      staleDetected: false,
    };
  }

  // 3. Pre-apply Snapshot
  const snapshot = await adapter.createSnapshot();
  const touchedComboIds = [
    ...plan.additions.map((a) => a.id),
    ...plan.modifications.map((m) => m.id),
    ...plan.deletions,
  ];
  snapshot.metadata = {
    ...snapshot.metadata,
    touchedComboIds,
  };

  // 4. Execute Write
  const writeResult = await adapter.applyPlan(plan);
  if (!writeResult.success) {
    return {
      success: false,
      target: adapter.name,
      appliedAt,
      planId: plan.id,
      readBackVerified: writeResult.readBackVerified ?? false,
      staleDetected: writeResult.staleDetected ?? false,
      readBackLevel: writeResult.readBackLevel,
      degradedReason: writeResult.degradedReason,
      error: writeResult.error ?? 'Adapter write failed',
    };
  }

  // 5. Read-back verification
  const readBackCombos = await adapter.readCombos();
  const readBackMap = new Map(readBackCombos.map((c) => [c.id, c]));

  let verified = true;
  let mismatchReason = '';

  // Verify additions
  for (const added of plan.additions) {
    const found = readBackMap.get(added.id);
    if (!found) {
      verified = false;
      mismatchReason = `Added combo '${added.id}' not found in read-back`;
      break;
    }
    const modelsMatch =
      found.models.length === added.models.length &&
      found.models.every((m, idx) => m === added.models[idx]);
    if (!modelsMatch) {
      verified = false;
      mismatchReason = `Added combo '${added.id}' models mismatch in read-back`;
      break;
    }
  }

  // Verify modifications
  if (verified) {
    for (const mod of plan.modifications) {
      const found = readBackMap.get(mod.id);
      if (!found) {
        verified = false;
        mismatchReason = `Modified combo '${mod.id}' not found in read-back`;
        break;
      }
      const modelsMatch =
        found.models.length === mod.models.length &&
        found.models.every((m, idx) => m === mod.models[idx]);
      if (!modelsMatch) {
        verified = false;
        mismatchReason = `Modified combo '${mod.id}' models mismatch in read-back`;
        break;
      }
    }
  }

  // Verify deletions
  if (verified) {
    for (const delId of plan.deletions) {
      if (readBackMap.has(delId)) {
        verified = false;
        mismatchReason = `Deleted combo '${delId}' still exists in read-back`;
        break;
      }
    }
  }

  // 6. Handle verification failure (STALE detection & automatic rollback)
  if (!verified) {
    const rollbackSuccess = await adapter.rollback(snapshot);
    return {
      success: false,
      target: adapter.name,
      appliedAt,
      planId: plan.id,
      readBackVerified: false,
      staleDetected: true,
      rollbackExecuted: rollbackSuccess,
      error: `Read-back verification failed (STALE cache detected): ${mismatchReason}`,
    };
  }

  return {
    success: true,
    target: adapter.name,
    appliedAt,
    planId: plan.id,
    readBackVerified: true,
    staleDetected: false,
    readBackLevel: writeResult.readBackLevel,
    degradedReason: writeResult.degradedReason,
  };
}
