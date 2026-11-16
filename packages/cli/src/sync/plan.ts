/**
 * packages/cli/src/sync/plan.ts
 *
 * Pure removal planner for `routersync sync` (ROUND 56 §3, rules R1-R5).
 *
 * STRICTLY PURE: no I/O, no network, no clock, deterministic plan hash.
 * Every safety rule lives here so it can be reasoned about without a router:
 *
 *  R1  remove only when the prefix maps to exactly one provider that was
 *      scanned successfully twice and the model is absent from both lists.
 *  R2  skip the whole provider on error/401/429/timeout, on a live list below
 *      70% of the catalog count, or below 50% step match (namespace drift).
 *  R3  unmapped prefix -> keep every step, report UNKNOWN-PREFIX.
 *  R4  keep >= 2 steps, never reorder, never delete a combo.
 *  R5  warn when a combo loses more than 25% of its steps or more than 60.
 *
 * Scope: a provider is identified by `router + prefix`. Two routers may both
 * configure `gemini`; the two live lists are separate evidence and must never
 * authorise a removal in the other router's combos.
 */

import { createHash } from 'node:crypto';
import { parseComboStep } from './normalize.js';
import type { SkipReason } from './providers.js';

export const MIN_STEPS = 2;
export const CATALOG_FLOOR = 0.7;
export const STEP_MATCH_FLOOR = 0.5;
export const BIG_REMOVAL_RATIO = 0.25;
export const BIG_REMOVAL_COUNT = 60;

/** Live lists of one provider in one router, from the two scans. */
export interface ProviderLive {
  router: string;
  id: string;
  prefix: string;
  label: string;
  skipReason?: SkipReason | undefined;
  /** Raw model ids from scan 1 / scan 2 (already provider-native form). */
  scan1: string[];
  scan2: string[];
  /** Model count for this provider in 9Router's model-catalog.json, if known. */
  catalogCount?: number | undefined;
}

export interface ComboInput {
  router: string;
  id: string;
  name: string;
  steps: string[];
  /** Owner excluded this combo in config. */
  excluded: boolean;
  /** Pre-existing guard reason (e.g. not adopted). */
  guardBlocked?: string | undefined;
}

export interface SyncPlanInput {
  providers: ProviderLive[];
  combos: ComboInput[];
  /**
   * R57 §C: canonical provider names exempt from the R2 step-match floor.
   * Populated from config `trust-low-match`.
   */
  trustLowMatch?: ReadonlySet<string> | undefined;
}

export interface ProviderReport {
  router: string;
  id: string;
  prefix: string;
  label: string;
  outcome: 'SCAN-OK' | 'SKIP';
  reason?: SkipReason | 'provider-skipped' | undefined;
  liveCount1: number;
  liveCount2: number;
  catalogCount?: number | undefined;
  /** Steps of this router that use this prefix. */
  comboSteps: number;
  matchedSteps: number;
  removals: number;
  /** Distinct model ids that will be removed, for the printed plan. */
  sampleRemovals: string[];
  /** Models live now but absent from every in-scope combo (report only). */
  newModels: { count: number; sample: string[] };
}

export interface ComboReport {
  router: string;
  id: string;
  name: string;
  before: number;
  after: number;
  removals: string[];
  blockedReason?: string | undefined;
}

export interface SyncPlan {
  planHash: string;
  providers: ProviderReport[];
  combos: ComboReport[];
  warnings: string[];
  totalRemovals: number;
  /** Combos that would change. */
  changedCombos: number;
}

interface UsableProvider {
  id: string;
  prefix: string;
  keys: Set<string>;
}

interface ProviderVerdict {
  reason?: SkipReason | 'provider-skipped' | undefined;
  matched: number;
  steps: number;
}

/** `router|prefix` — the unit of evidence. */
function scopeOf(router: string, prefix: string): string {
  return `${router}|${prefix.toLowerCase()}`;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * Decides which providers may authorise a removal (R2). A provider needs both
 * scans healthy, a list that is not suspiciously small versus the catalog, and
 * a step-match rate that rules out a namespace mix-up.
 *
 * `trustLowMatch`: canonical provider names exempt from the step-match floor
 * (R57 §C). These providers strip variant suffixes that differ between the
 * combo and the live list (e.g. node-a strips `-free`), so a low match rate is
 * expected and does not indicate namespace drift. All other R2 checks still apply.
 */
export function selectUsableProviders(
  providers: ProviderLive[],
  combos: ComboInput[],
  trustLowMatch: ReadonlySet<string> = new Set()
): { usable: Map<string, UsableProvider>; verdicts: Map<string, ProviderVerdict> } {
  const stats = new Map<string, { steps: number; matched: number }>();
  const bump = (key: string, field: 'steps' | 'matched'): void => {
    const entry = stats.get(key) ?? { steps: 0, matched: 0 };
    entry[field] += 1;
    stats.set(key, entry);
  };

  for (const combo of combos) {
    if (combo.excluded) continue;
    for (const raw of combo.steps) {
      const step = parseComboStep(raw);
      if (step.prefix === '') continue;
      bump(scopeOf(combo.router, step.prefix), 'steps');
    }
  }

  const usable = new Map<string, UsableProvider>();
  const verdicts = new Map<string, ProviderVerdict>();

  for (const provider of providers) {
    const scope = scopeOf(provider.router, provider.prefix);

    // One provider may appear once per router; skip a duplicate scope rather
    // than double-counting its steps.
    if (verdicts.has(scope) && provider.scan1.length === 0) continue;

    if (provider.scan1.length > 0) {
      const liveKeys = new Set(
        provider.scan1.map((m) => parseComboStep(`${provider.prefix}/${m}`).key)
      );
      for (const combo of combos) {
        if (combo.excluded || combo.router !== provider.router) continue;
        for (const raw of combo.steps) {
          const step = parseComboStep(raw);
          if (step.prefix === provider.prefix && liveKeys.has(step.key)) bump(scope, 'matched');
        }
      }
    }

    const stat = stats.get(scope) ?? { steps: 0, matched: 0 };
    const verdict: ProviderVerdict = { matched: stat.matched, steps: stat.steps };

    if (provider.skipReason) {
      verdict.reason = provider.skipReason;
    } else if (provider.scan1.length === 0 || provider.scan2.length === 0) {
      verdict.reason = 'provider-skipped';
    } else if (
      provider.catalogCount !== undefined &&
      provider.catalogCount > 0 &&
      provider.scan1.length < provider.catalogCount * CATALOG_FLOOR
    ) {
      verdict.reason = 'provider-skipped';
    } else if (stat.steps > 0 && stat.matched / stat.steps < STEP_MATCH_FLOOR) {
      // R57: providers in trustLowMatch are exempt from the step-match floor.
      // Their live list intentionally omits variant suffixes (e.g. node-a strips
      // -free) so a low match rate is structural, not a namespace mix-up.
      if (!trustLowMatch.has(provider.id) && !trustLowMatch.has(provider.prefix)) {
        verdict.reason = 'provider-skipped';
      }
    }

    verdicts.set(scope, verdict);
    if (verdict.reason) continue;

    const keys = new Set<string>();
    for (const model of [...provider.scan1, ...provider.scan2]) {
      keys.add(parseComboStep(`${provider.prefix}/${model}`).key);
    }
    usable.set(scope, { id: provider.id, prefix: provider.prefix, keys });
  }

  return { usable, verdicts };
}

/** Computes the full plan. Pure: same input -> same hash. */
export function computeSyncPlan(input: SyncPlanInput): SyncPlan {
  const { usable, verdicts } = selectUsableProviders(
    input.providers,
    input.combos,
    input.trustLowMatch
  );

  // Every model currently referenced, per router+prefix — used for "MỚI".
  const referenced = new Map<string, Set<string>>();
  for (const combo of input.combos) {
    if (combo.excluded) continue;
    for (const raw of combo.steps) {
      const step = parseComboStep(raw);
      if (step.prefix === '') continue;
      const scope = scopeOf(combo.router, step.prefix);
      const set = referenced.get(scope) ?? new Set<string>();
      set.add(step.key);
      referenced.set(scope, set);
    }
  }

  const comboReports: ComboReport[] = [];
  const warnings: string[] = [];
  const removalByScope = new Map<string, number>();
  const sampleByScope = new Map<string, Set<string>>();

  for (const combo of input.combos) {
    if (combo.excluded) {
      comboReports.push({
        router: combo.router,
        id: combo.id,
        name: combo.name,
        before: combo.steps.length,
        after: combo.steps.length,
        removals: [],
        blockedReason: 'excluded',
      });
      continue;
    }
    if (combo.guardBlocked) {
      comboReports.push({
        router: combo.router,
        id: combo.id,
        name: combo.name,
        before: combo.steps.length,
        after: combo.steps.length,
        removals: [],
        blockedReason: combo.guardBlocked,
      });
      continue;
    }

    const removals: string[] = [];
    for (const raw of combo.steps) {
      const step = parseComboStep(raw);
      const provider = usable.get(scopeOf(combo.router, step.prefix));
      if (!provider) continue;
      if (provider.keys.has(step.key)) continue;
      removals.push(raw);
    }

    const after = combo.steps.length - removals.length;
    // R4: never leave a combo below the minimum. Nothing is written for it.
    if (removals.length > 0 && after < MIN_STEPS) {
      comboReports.push({
        router: combo.router,
        id: combo.id,
        name: combo.name,
        before: combo.steps.length,
        after: combo.steps.length,
        removals: [],
        blockedReason: 'min-steps',
      });
      continue;
    }

    for (const raw of removals) {
      const scope = scopeOf(combo.router, parseComboStep(raw).prefix);
      removalByScope.set(scope, (removalByScope.get(scope) ?? 0) + 1);
      const sample = sampleByScope.get(scope) ?? new Set<string>();
      if (sample.size < 12) sample.add(raw);
      sampleByScope.set(scope, sample);
    }

    // R5: warn, then require the exact count retyped.
    if (removals.length > BIG_REMOVAL_COUNT) {
      warnings.push(
        `BIG-REMOVAL router=${combo.router} combo=${combo.name} remove=${removals.length} (over ${BIG_REMOVAL_COUNT})`
      );
    } else if (
      removals.length > 0 &&
      removals.length / Math.max(combo.steps.length, 1) > BIG_REMOVAL_RATIO
    ) {
      warnings.push(
        `BIG-REMOVAL router=${combo.router} combo=${combo.name} remove=${removals.length}/${combo.steps.length}`
      );
    }

    comboReports.push({
      router: combo.router,
      id: combo.id,
      name: combo.name,
      before: combo.steps.length,
      after,
      removals,
    });
  }

  const providerReports: ProviderReport[] = input.providers.map((provider) => {
    const scope = scopeOf(provider.router, provider.prefix);
    const verdict = verdicts.get(scope);
    const scanned = usable.has(scope);
    const live = new Set(
      [...provider.scan1, ...provider.scan2].map(
        (m) => parseComboStep(`${provider.prefix}/${m}`).key
      )
    );
    const used = referenced.get(scope) ?? new Set<string>();
    const fresh = [...live].filter((k) => !used.has(k));
    const label = (key: string): string => key.slice(provider.prefix.length + 1);

    return {
      router: provider.router,
      id: provider.id,
      prefix: provider.prefix,
      label: provider.label,
      outcome: scanned ? 'SCAN-OK' : 'SKIP',
      reason: scanned ? undefined : verdict?.reason,
      liveCount1: provider.scan1.length,
      liveCount2: provider.scan2.length,
      catalogCount: provider.catalogCount,
      comboSteps: verdict?.steps ?? 0,
      matchedSteps: verdict?.matched ?? 0,
      removals: removalByScope.get(scope) ?? 0,
      sampleRemovals: [...(sampleByScope.get(scope) ?? [])],
      newModels: { count: fresh.length, sample: fresh.slice(0, 10).map(label) },
    };
  });

  // Prefixes present in combos but not resolvable to any provider -> R3.
  const known = new Set(input.providers.map((p) => scopeOf(p.router, p.prefix)));
  for (const [scope, keys] of referenced) {
    if (known.has(scope)) continue;
    const [router = '?', prefix = '?'] = scope.split('|');
    providerReports.push({
      router,
      id: prefix,
      prefix,
      label: prefix,
      outcome: 'SKIP',
      reason: 'unknown-prefix',
      liveCount1: 0,
      liveCount2: 0,
      comboSteps: keys.size,
      matchedSteps: 0,
      removals: 0,
      sampleRemovals: [],
      newModels: { count: 0, sample: [] },
    });
  }

  const totalRemovals = comboReports.reduce((sum, c) => sum + c.removals.length, 0);
  const planHash = stableHash({
    git: 'round56',
    providers: input.providers.map((p) => ({
      r: p.router,
      id: p.id,
      prefix: p.prefix,
      s1: p.scan1.length,
      s2: p.scan2.length,
    })),
    combos: comboReports.map((c) => ({ router: c.router, name: c.name, r: c.removals })),
  });

  return {
    planHash,
    providers: providerReports,
    combos: comboReports,
    warnings,
    totalRemovals,
    changedCombos: comboReports.filter((c) => c.removals.length > 0).length,
  };
}
