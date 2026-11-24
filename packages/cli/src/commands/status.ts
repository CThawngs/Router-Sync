/**
 * packages/cli/src/commands/status.ts
 *
 * Implements `routersync status` command.
 * Reports health, read-back tier (Condition A5), schema status, emergency freeze state,
 * and per-target consent/read-back status (C45-WP4 §3.3.3).
 *
 * STRICTLY READ-ONLY (AT-157 lock): zero files or directories created in stateDir!
 */

import { loadConfigFile } from '../config/loader.js';
import { createAdapterForRouter, getRouterReadBackInfo } from '../adapters.js';
import {
  hasWrittenEvidence,
  readApplyHistory,
  readFreezeState,
  readStandingConsent,
  resolveControlStateDir,
  type ApplyHistoryReceipt,
} from '@routersync/core';
import {
  normalizeReadBackLevel,
  type CanonicalReadBackLevel,
} from '@routersync/adapter-sdk';

export interface StatusCommandOptions {
  configPath?: string | undefined;
  stateDir?: string | undefined;
  json?: boolean | undefined;
}

export interface StatusTargetItem {
  target: string;
  targetKind: 'router' | 'harness';
  effectiveLevel: 'propose' | 'auto-safe' | 'off' | 'FROZEN';
  configuredLevel: 'propose' | 'auto-safe' | 'off';
  consentGranted: boolean;
  consentExpiresAt: string | null;
  autoSafeEligible: boolean;
  lastReadBack: {
    verified: boolean;
    readBackLevel: string;
    appliedAt: string;
    appliedAtLevel: 'propose' | 'auto-safe';
    planHash: string;
    rolledBack: boolean;
  } | null;
}

export interface RouterStatusItem {
  id: string;
  adapter: string;
  validated: boolean;
  health: {
    status: string;
    ok: boolean;
    latencyMs?: number | undefined;
    message?: string | undefined;
  };
  readBackLevel: 'full' | 'existence-only' | 'db-only (degraded)';
  canonicalReadBackLevel?: CanonicalReadBackLevel | undefined;
  degradedReason?: string | undefined;
  keyName?: string | undefined;
  keyScope?: 'client' | 'elevated' | undefined;
  /**
   * Spec §33.3 / AT-109: 'verified' when the serving path is confirmed,
   * 'written-pending-reload' when db-only (serving reflection unconfirmed —
   * combo becomes visible on the router only after reload/refresh).
   * R19-2 (DECISIONS 2026-10-18-01): 'unwritten' when there is NO evidence
   * that this target was ever written. The value is ADDED; the two values
   * above keep their meaning.
   */
  applyState?: 'verified' | 'written-pending-reload' | 'unwritten' | undefined;
  combos: Array<{ name: string; strategy?: string | undefined; modelCount: number }>;
}

function findLatestReceipt(
  receipts: ApplyHistoryReceipt[],
  target: string
): ApplyHistoryReceipt | undefined {
  for (let i = receipts.length - 1; i >= 0; i--) {
    const r = receipts[i];
    if (r && r.target === target) return r;
  }
  return undefined;
}

function hasQualifyingProposeReceipt(
  receipts: ApplyHistoryReceipt[],
  target: string
): boolean {
  return receipts.some(
    (r) =>
      r.target === target &&
      r.appliedAtLevel === 'propose' &&
      r.success === true &&
      r.readBackVerified === true &&
      r.rolledBack === false
  );
}

export async function runStatusCommand(options: StatusCommandOptions): Promise<void> {
  const { config, filePath } = loadConfigFile(options.configPath);

  // Strictly read-only control plane inspection (AT-157: 0 mkdir, 0 writes)
  const sDir = resolveControlStateDir(options.stateDir);
  const freeze = readFreezeState(sDir);
  const consent = readStandingConsent(sDir);
  const history = readApplyHistory(sDir);
  const validReceipts = history.valid ? history.receipts : [];

  const routersStatus: RouterStatusItem[] = [];
  const discoveredTargets = new Set<string>();

  for (const router of config.routers) {
    const adapter = createAdapterForRouter(router);
    const health = await adapter.checkHealth();
    const readBackInfo = getRouterReadBackInfo(router);

    let comboList: Array<{ name: string; strategy?: string | undefined; modelCount: number }> = [];
    try {
      const combos = await adapter.readCombos();
      comboList = combos.map((c) => ({
        name: c.name,
        strategy: c.strategy,
        modelCount: c.models.length,
      }));
    } catch {
      // Ignore if DB not readable yet
    }

    for (const c of comboList) {
      discoveredTargets.add(`router:${router.id}/${c.name}`);
    }

    const isLiveHealthy = health.ok && health.status !== 'down';
    const readBackLevel: 'full' | 'existence-only' | 'db-only (degraded)' = isLiveHealthy
      ? readBackInfo.level
      : 'db-only (degraded)';
    const canonicalReadBackLevel = normalizeReadBackLevel(readBackLevel);

    const degradedReason = isLiveHealthy
      ? readBackInfo.reason
      : `Router API unreachable (${health.message || health.status}) - serving path unconfirmed, degraded to db-only`;

    const hasEvidence = hasWrittenEvidence(router.adapter);
    const applyState: 'verified' | 'written-pending-reload' | 'unwritten' | undefined =
      !isLiveHealthy
        ? undefined
        : !hasEvidence
          ? 'unwritten'
          : readBackInfo.level !== 'db-only (degraded)'
            ? 'verified'
            : 'written-pending-reload';

    routersStatus.push({
      id: router.id,
      adapter: router.adapter,
      validated: Boolean(router.validated),
      health: {
        status: health.status,
        ok: health.ok,
        latencyMs: health.latencyMs,
        message: health.message,
      },
      readBackLevel,
      canonicalReadBackLevel,
      degradedReason,
      keyName: readBackInfo.keyName,
      keyScope: readBackInfo.keyScope,
      ...(applyState ? { applyState } : {}),
      combos: comboList,
    });
  }

  for (const c of config.combos ?? []) {
    for (const rId of c.routers) {
      discoveredTargets.add(`router:${rId}/${c.name}`);
    }
  }
  for (const a of config.adopt ?? []) {
    discoveredTargets.add(`router:${a.router}/${a.name}`);
  }
  if (consent.valid) {
    for (const t of consent.targets) {
      discoveredTargets.add(t.target);
    }
  }
  for (const r of validReceipts) {
    discoveredTargets.add(r.target);
  }

  const consentByTarget = new Map(
    (consent.valid ? consent.targets : []).map((entry) => [entry.target, entry])
  );

  const targetsStatus: StatusTargetItem[] = [...discoveredTargets].sort().map((target) => {
    const targetKind: 'router' | 'harness' = target.startsWith('harness:') ? 'harness' : 'router';
    const entry = consentByTarget.get(target);
    const isActiveEntry = Boolean(entry && !entry.expired && entry.level !== 'off');
    const configuredLevel: 'propose' | 'auto-safe' | 'off' =
      entry && !entry.expired ? entry.level : 'off';
    const autoSafeEligible = hasQualifyingProposeReceipt(validReceipts, target);

    let effectiveLevel: 'propose' | 'auto-safe' | 'off' | 'FROZEN';
    if (freeze.frozen) {
      effectiveLevel = 'FROZEN';
    } else if (configuredLevel === 'auto-safe') {
      effectiveLevel = autoSafeEligible ? 'auto-safe' : 'off';
    } else {
      effectiveLevel = configuredLevel;
    }

    const latest = findLatestReceipt(validReceipts, target);
    return {
      target,
      targetKind,
      effectiveLevel,
      configuredLevel,
      consentGranted: isActiveEntry,
      consentExpiresAt: isActiveEntry && entry ? entry.expiresAt : null,
      autoSafeEligible,
      lastReadBack: latest
        ? {
            verified: latest.readBackVerified,
            readBackLevel: latest.readBackLevel,
            appliedAt: latest.appliedAt,
            appliedAtLevel: latest.appliedAtLevel,
            planHash: latest.planHash,
            rolledBack: latest.rolledBack,
          }
        : null,
    };
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          configFile: filePath,
          timestamp: new Date().toISOString(),
          frozen: freeze.frozen,
          freezeReason: freeze.reason,
          routers: routersStatus,
          targets: targetsStatus,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`[routersync] System Status (Config: ${filePath})`);
  if (freeze.frozen) {
    console.log(`  Emergency Freeze: FROZEN (${freeze.reason ?? 'manual-emergency-freeze'})`);
  } else {
    console.log(`  Emergency Freeze: off`);
  }
  for (const r of routersStatus) {
    console.log(`\nRouter [${r.id}] (${r.adapter}):`);
    console.log(
      `  Validation:      ${r.validated ? 'verified (REAL)' : 'unvalidated (Live test pending — G0-7: manual/shadow only)'}`
    );
    console.log(`  Health:          ${r.health.status} (${r.health.latencyMs ?? 0}ms)`);
    console.log(`  Read-Back Level: ${r.readBackLevel} [${r.degradedReason}]`);
    if (r.keyName) {
      console.log(`  Auth Key:        ${r.keyName} (scope: ${r.keyScope})`);
    } else {
      console.log(`  Auth Key:        none (db-only degraded)`);
    }
    console.log(
      `  Apply State:     ${r.applyState}` +
        (r.applyState === 'written-pending-reload'
          ? ' (serving-path reflection unconfirmed — combo visible on router after reload/refresh; daemon will NOT count as success)'
          : r.applyState === 'unwritten'
            ? ' (no evidence of a write for this target: no snapshot and no managed-id entry)'
            : '')
    );
    console.log(`  Combos (${r.combos.length}):`);
    for (const c of r.combos) {
      console.log(`    - ${c.name}${c.strategy ? ` [${c.strategy}]` : ''} (${c.modelCount} models)`);
    }
  }
  if (targetsStatus.length > 0) {
    console.log(`\nControlled Targets (${targetsStatus.length}):`);
    for (const t of targetsStatus) {
      const rb = t.lastReadBack
        ? `lastReadBack=${t.lastReadBack.verified ? 'verified' : 'failed'}(${t.lastReadBack.readBackLevel})`
        : 'lastReadBack=none';
      console.log(
        `  - ${t.target}: effective=${t.effectiveLevel} configured=${t.configuredLevel} autoSafeEligible=${t.autoSafeEligible ? 'yes' : 'no'} ${rb}`
      );
    }
  }
}
