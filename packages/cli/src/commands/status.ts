/**
 * packages/cli/src/commands/status.ts
 *
 * Implements `routersync status` command.
 * Reports health, read-back tier (Condition A5), and schema status for all routers.
 */

import { loadConfigFile } from '../config/loader.js';
import { createAdapterForRouter, getRouterReadBackInfo } from '../adapters.js';
import { hasWrittenEvidence } from '@routersync/core';

export interface StatusCommandOptions {
  configPath?: string;
  json?: boolean;
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

export async function runStatusCommand(options: StatusCommandOptions): Promise<void> {
  const { config, filePath } = loadConfigFile(options.configPath);

  const routersStatus: RouterStatusItem[] = [];

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

    const isLiveHealthy = health.ok && health.status !== 'down';
    const readBackLevel: 'full' | 'existence-only' | 'db-only (degraded)' = isLiveHealthy
      ? readBackInfo.level
      : 'db-only (degraded)';

    const degradedReason = isLiveHealthy
      ? readBackInfo.reason
      : `Router API unreachable (${health.message || health.status}) - serving path unconfirmed, degraded to db-only`;

    // Spec §33.3 / AT-109 / D7 / R8-5:
    // Only 'verified' when serving path API check actually succeeded.
    // When down: do NOT assign applyState (omitted).
    // When healthy but db-only (serving reflection unconfirmed): 'written-pending-reload'.
    //
    // R19-2 (DECISIONS 2026-10-18-01): 'written-pending-reload' describes a
    // WRITE, so it may only be printed when there is EVIDENCE of that write
    // (a snapshot of this target, or a managed-id entry of this target — see
    // `hasWrittenEvidence`). Without evidence the state is 'unwritten'.
    // The evidence check is READ-ONLY: `status` never creates a file.
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
      degradedReason,
      keyName: readBackInfo.keyName,
      keyScope: readBackInfo.keyScope,
      ...(applyState ? { applyState } : {}),
      combos: comboList,
    });
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          configFile: filePath,
          timestamp: new Date().toISOString(),
          routers: routersStatus,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`[routersync] System Status (Config: ${filePath})`);
  for (const r of routersStatus) {
    console.log(`\nRouter [${r.id}] (${r.adapter}):`);
    console.log(`  Validation:      ${r.validated ? 'verified (REAL)' : 'unvalidated (Live test pending — G0-7: manual/shadow only)'}`);
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
}
