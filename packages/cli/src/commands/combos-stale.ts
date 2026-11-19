/**
 * packages/cli/src/commands/combos-stale.ts
 *
 * C15 Q4: read-only `routersync combos stale --json`.
 * Statuses are per router, from real router state:
 *   PRESENT | PRESENT-NORMALIZED | DISABLED | ABSENT
 * The default `direct` source uses model availability read from the router
 * database. `snapshot` explicitly uses the provider registry shipped with
 * RouterSync. ABSENT is never an upstream provider deprecation claim.
 */

import { readRouterModelState, type RouterModelState } from '@routersync/core';

export type StaleStatus = 'PRESENT' | 'PRESENT-NORMALIZED' | 'DISABLED' | 'ABSENT';
export type StaleSource = 'direct' | 'snapshot';

export interface StaleModelRow {
  router: string;
  step: string;
  status: StaleStatus;
}

export interface StaleReport {
  generatedAt: string;
  source: StaleSource;
  note: string;
  routers: string[];
  omittedRouters: string[];
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
export function buildStaleReport(
  routers: readonly string[],
  states: Map<string, RouterModelState>,
  source: StaleSource = 'direct',
  omittedRouters: readonly string[] = []
): StaleReport {
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

  const sourceNote =
    source === 'snapshot'
      ? 'ABSENT means unknown-to-snapshot relative to the shipped router catalog, not an upstream provider classification.'
      : 'ABSENT means not found in directly available router state, not an upstream provider classification.';
  const omittedNote =
    omittedRouters.length > 0
      ? ` Omitted routers without an availability reader: ${omittedRouters.join(', ')}.`
      : '';

  return {
    generatedAt: new Date().toISOString(),
    source,
    note: `${sourceNote}${omittedNote}`,
    routers: [...routers],
    omittedRouters: [...omittedRouters],
    rows,
    counts,
  };
}

export function parseStaleSource(value: string): StaleSource {
  if (value === 'direct' || value === 'snapshot') return value;
  throw new Error(`Invalid source "${value}"; expected direct or snapshot`);
}

/** Human-facing output keeps the evidence source as the first line. */
export function serializeStaleReport(report: StaleReport): string {
  return `source=${report.source}\n${JSON.stringify(report, null, 2)}`;
}

/** Strict JSON output for callers that parse stdout as one JSON document. */
export function serializeStaleReportJson(report: StaleReport): string {
  return JSON.stringify(report, null, 2);
}

export interface CombosStaleOptions {
  router?: string | undefined;
  source?: StaleSource | undefined;
  json?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export async function runCombosStaleCommand(options: CombosStaleOptions = {}): Promise<StaleReport> {
  const target = (options.router ?? 'all').toLowerCase();
  if (target !== 'all' && target !== '9router' && target !== 'omniroute') {
    throw new Error(`Invalid router "${target}"; expected all, 9router, or omniroute`);
  }

  const source = options.source ?? 'direct';
  const requestedRouters = target === 'all' ? ['9router', 'omniroute'] : [target];
  const routers = requestedRouters.filter((router) => router === '9router');
  const omittedRouters = requestedRouters.filter((router) => router !== '9router');
  const states = new Map<string, RouterModelState>();
  for (const router of routers) {
    states.set(
      router,
      await readRouterModelState(router, {
        env: options.env ?? process.env,
        availabilitySource: source,
        excludeComboModelsFromAvailability: true,
      })
    );
  }
  const report = buildStaleReport(routers, states, source, omittedRouters);
  if (options.json === true) {
    console.log(serializeStaleReportJson(report));
  } else if (options.json !== false) {
    console.log(serializeStaleReport(report));
  }
  return report;
}
