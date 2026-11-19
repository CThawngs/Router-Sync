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

export type StaleStatus = 'PRESENT' | 'PRESENT-NORMALIZED' | 'DISABLED' | 'ABSENT' | 'UNVERIFIABLE';
export type StaleSource = 'direct' | 'snapshot';

export interface StaleModelRow {
  router: string;
  step: string;
  status: StaleStatus;
}

export interface StaleReport {
  generatedAt: string;
  /** OK when every requested router was readable; UNKNOWN when at least one was not. */
  status: 'OK' | 'UNKNOWN';
  /** Routers whose evidence could not be read, with a short reason. */
  unavailable: Array<{ router: string; reason: string }>;
  source: StaleSource;
  note: string;
  routers: string[];
  omittedRouters: string[];
  rows: StaleModelRow[];
  counts: Record<StaleStatus, number>;
}

/** The one default for availability evidence; doctor/plan/combos all use `direct`. */
export const DEFAULT_STALE_SOURCE: StaleSource = 'direct';

function normalizeId(id: string): string {
  return id.startsWith('models/') ? id.slice('models/'.length) : id;
}

function providersWithEvidence(state: RouterModelState): Set<string> {
  if (state.availabilityProviders) return state.availabilityProviders;
  const prefixes = new Set<string>();
  for (const model of state.availableModels) {
    const slash = model.indexOf('/');
    if (slash > 0) prefixes.add(model.slice(0, slash));
  }
  return prefixes;
}

/** Why the router state cannot be classified, or null when it is readable. */
export function unreadableReason(state: RouterModelState): string | null {
  const d = state.diagnostics;
  if (!d) return null;
  if (!d.dbResolved) return 'database path not resolved';
  if (!d.dbOpened) return `database could not be opened (${d.dbName ?? 'unknown file'})`;
  if (d.missingTables.length > 0) {
    return `table(s) missing: ${d.missingTables.join(', ')} (${d.dbName ?? 'unknown file'})`;
  }
  return null;
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
  // A provider with no availability evidence at all is not "absent"; it is
  // unverifiable, and must never be used as a removal argument.
  if (!providersWithEvidence(state).has(prefix)) return 'UNVERIFIABLE';
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
    UNVERIFIABLE: 0,
  };
  const unavailable: Array<{ router: string; reason: string }> = [];

  for (const router of routers) {
    const state = states.get(router);
    if (!state) continue;
    const reason = unreadableReason(state);
    if (reason) {
      unavailable.push({ router, reason });
      continue;
    }
    for (const step of [...state.comboModels].sort()) {
      const status = classifyComboStep(step, state);
      rows.push({ router, step, status });
      counts[status] += 1;
    }
  }

  const sourceNote =
    source === 'snapshot'
      ? 'ABSENT means unknown-to-snapshot relative to the shipped router catalog, not an upstream provider classification. UNVERIFIABLE means the provider carried no availability evidence.'
      : 'ABSENT means not found in directly available router state, not an upstream provider classification. UNVERIFIABLE means the provider carried no availability evidence.';
  const omittedNote =
    omittedRouters.length > 0
      ? ` Omitted routers without an availability reader: ${omittedRouters.join(', ')}.`
      : '';
  const unavailableNote =
    unavailable.length > 0
      ? ` Router evidence unreadable: ${unavailable.map((u) => `${u.router} (${u.reason})`).join('; ')}. No status is claimed for those rows.`
      : '';

  return {
    generatedAt: new Date().toISOString(),
    status: unavailable.length > 0 ? 'UNKNOWN' : 'OK',
    unavailable,
    source,
    note: `${sourceNote}${omittedNote}${unavailableNote}`,
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
  // When evidence is unreadable, the reason is the first line so a human sees it
  // before any counts that would look like mass model loss.
  if (report.status === 'UNKNOWN') {
    const reasons = report.unavailable.map((u) => `${u.router}: ${u.reason}`).join('; ');
    return `UNKNOWN: ${reasons}\nsource=${report.source}\n${JSON.stringify(report, null, 2)}`;
  }
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

  const source = options.source ?? DEFAULT_STALE_SOURCE;
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
  if (report.status === 'UNKNOWN') {
    // Non-zero so a script cannot mistake unreadable evidence for "all absent".
    process.exitCode = 1;
  }
  if (options.json === true) {
    console.log(serializeStaleReportJson(report));
  } else if (options.json !== false) {
    console.log(serializeStaleReport(report));
  }
  return report;
}
