/**
 * packages/cli/src/commands/combos-stale.ts
 *
 * C15 Q4: read-only `routersync combos stale --json`.
 * Statuses are per router, from real router state:
 *   PRESENT | PRESENT-NORMALIZED | DISABLED | ABSENT
 * `ABSENT` here means "unknown-to-snapshot" relative to the shipped router
 * catalog — it is NOT an upstream provider deprecation claim.
 */

import { readRouterModelState, type RouterModelState } from '@routersync/core';

export type StaleStatus = 'PRESENT' | 'PRESENT-NORMALIZED' | 'DISABLED' | 'ABSENT';

export interface StaleModelRow {
  router: string;
  step: string;
  status: StaleStatus;
}

export interface StaleReport {
  generatedAt: string;
  note: string;
  routers: string[];
  rows: StaleModelRow[];
  counts: Record<StaleStatus, number>;
}

function normalizeId(id: string): string {
  return id.startsWith('models/') ? id.slice('models/'.length) : id;
}

/** Classify one combo step against a router state (pure, testable). */
export function classifyComboStep(step: string, state: RouterModelState): StaleStatus {
  const slash = step.indexOf('/');
  if (slash === -1) return 'ABSENT';
  const prefix = step.slice(0, slash);
  const id = step.slice(slash + 1);
  const norm = normalizeId(id);

  const direct = `${prefix}/${id}`;
  const normalized = `${prefix}/${norm}`;
  if (state.availableModels.has(direct)) return 'PRESENT';
  if (state.availableModels.has(normalized)) return 'PRESENT-NORMALIZED';
  if (state.disabledModels.has(direct) || state.disabledModels.has(normalized)) return 'DISABLED';
  return 'ABSENT';
}

/** Build the report for a list of router names. */
export function buildStaleReport(routers: readonly string[], states: Map<string, RouterModelState>): StaleReport {
  const rows: StaleModelRow[] = [];
  const counts: Record<StaleStatus, number> = {
    PRESENT: 0,
    'PRESENT-NORMALIZED': 0,
    DISABLED: 0,
    ABSENT: 0,
  };

  for (const router of routers) {
    const state = states.get(router);
    if (!state) continue;
    for (const step of [...state.comboModels].sort()) {
      const status = classifyComboStep(step, state);
      rows.push({ router, step, status });
      counts[status] += 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    note: 'ABSENT means unknown-to-snapshot relative to the shipped router catalog, not an upstream provider classification.',
    routers: [...routers],
    rows,
    counts,
  };
}

export interface CombosStaleOptions {
  router?: string | undefined;
  json?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export async function runCombosStaleCommand(options: CombosStaleOptions = {}): Promise<StaleReport> {
  const target = (options.router ?? 'all').toLowerCase();
  const routers = target === 'all' ? ['9router', 'omniroute'] : [target];
  const states = new Map<string, RouterModelState>();
  for (const router of routers) {
    states.set(router, await readRouterModelState(router, { env: options.env ?? process.env }));
  }
  const report = buildStaleReport(routers, states);
  if (options.json !== false) console.log(JSON.stringify(report, null, 2));
  return report;
}
