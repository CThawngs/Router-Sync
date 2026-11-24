/**
 * packages/cli/src/rank/combo-selector.ts
 *
 * C45 WP5 Reliability-Aware Combo Selector & Cross-Provider Interleaver (Phục vụ: S4).
 *
 * Enforces:
 *  - 100% exclusion of `DEAD` and `HANG` reliability labels (even in `favorites`,
 *    emitting an explicit warning).
 *  - 100% exclusion of all 5 non-chat specialist families (`embedding`, `audio`,
 *    `moderation`, `image-gen`, `rerank`) + `vision-only`.
 *  - Invariant I6 (`free-only` rejects paid and `pricingKnown === false`).
 *  - Step ceiling (`12` default for paid/general, `15` default for `free-only`,
 *    clamped to `<= 15` unless `allowAbove15: true`) and Invariant I3 (`>= 2` floor).
 *  - Max-remaining-bucket cross-provider alternation (`adjacentSameProviderCount === 0`
 *    whenever `maxProviderCount <= Math.ceil(N / 2)`).
 */

import type { StepReliability } from '../commands/combos-reliability.js';
import type { UserProfile } from '../profile/types.js';
import { classifyNonChatSpecialist, type NonChatSpecialistKind } from './filters.js';
import { interleaveAcrossProviders } from './interleave.js';

export type SelectorRouterKind = '9router' | 'omniroute' | 'litellm';

export interface ComboCandidateModel {
  step: string;                         // "<provider>/<modelId>"
  provider: string;
  modelId: string;
  free?: boolean | undefined;
  pricingKnown?: boolean | undefined;   // false => excluded when budget === 'free-only' (I6)
  contextLength?: number | undefined;
  qualityScore?: number | undefined;    // 0..100
  mode?: string | undefined;
  type?: string | undefined;
  capabilities?: readonly string[] | undefined;
  inputModalities?: readonly string[] | undefined;
  outputModalities?: readonly string[] | undefined;
  reliability?: StepReliability | undefined;
}

export interface ComboSelectorProfileShape extends Partial<UserProfile> {
  budget?: 'free-only' | 'paid' | undefined;
  freeOnly?: boolean | undefined;
  priority?: readonly string[] | undefined;
  favorites?: readonly string[] | undefined;
  allowList?: readonly string[] | undefined;
  denyList?: readonly string[] | undefined;
  blockList?: readonly string[] | undefined;
  preferredProviders?: readonly string[] | undefined;
  dislikedProviders?: readonly string[] | undefined;
  keyedProviders?: readonly string[] | undefined;
}

export interface ComboSelectionOptions {
  profile?: ComboSelectorProfileShape | undefined;
  routerKind?: SelectorRouterKind | undefined;
  minSteps?: number | undefined;        // default 2 (Invariant I3)
  maxSteps?: number | undefined;        // default 12 for paid/general, 15 for free-only; clamped to [2, 15]
  allowAbove15?: boolean | undefined;
  hasMultiKeyPool?: boolean | undefined;
}

export interface ComboSelectionInput {
  candidates: readonly ComboCandidateModel[];
  options?: ComboSelectionOptions | undefined;
}

export type CandidateExclusionReason =
  | 'block-list'
  | 'not-in-allow-list'
  | `non-chat-specialist:${NonChatSpecialistKind}`
  | 'unreliable-dead'
  | 'unreliable-hang'
  | 'budget-free-only';

export interface ExcludedCandidate {
  step: string;
  provider: string;
  modelId: string;
  reason: CandidateExclusionReason;
}

export interface ScoredComboCandidate {
  step: string;
  provider: string;
  modelId: string;
  score: number;
  candidate: ComboCandidateModel;
}

export interface ComboSelectionResult {
  selectedSteps: string[];
  selectedCandidates: ScoredComboCandidate[];
  excluded: ExcludedCandidate[];
  warnings: string[];
  insufficientCandidates: boolean;
  adjacentSameProviderCount: number;
  distinctProviders: number;
  effectiveMaxSteps: number;
  minSteps: number;
  recommendedStrategy: string;
  recommendedPoolStrategy?: string | undefined;
}

function matchesEntryList(
  candidate: ComboCandidateModel,
  entries: readonly string[]
): boolean {
  if (entries.length === 0) return false;
  const stepLower = candidate.step.toLowerCase();
  const idLower = candidate.modelId.toLowerCase();
  const provLower = candidate.provider.toLowerCase();
  for (const raw of entries) {
    const pat = raw.trim().toLowerCase();
    if (!pat) continue;
    if (pat === stepLower || pat === idLower || pat === provLower) {
      return true;
    }
    if (stepLower.endsWith(`/${pat}`)) {
      return true;
    }
  }
  return false;
}

function computeCandidateScore(
  candidate: ComboCandidateModel,
  profile: ComboSelectorProfileShape,
  favoriteMatched: boolean
): number {
  let score = 0;
  const priority = (profile.priority ?? ['quality', 'speed', 'cost', 'context']).map((p) =>
    p.toLowerCase()
  );
  const topPriority = priority[0] ?? 'quality';

  // 1. Reliability tier baseline
  const label = candidate.reliability?.label;
  if (label === 'RELIABLE') {
    score += 400;
  } else if (label === 'LOW-SAMPLE' || label === undefined) {
    score += 250;
  } else if (label === 'SLOW') {
    score += topPriority === 'speed' ? 120 : 200;
  } else if (label === 'RATE-LIMITED') {
    score += 40;
  }

  // 2. Favorite boost (healthy candidates only; DEAD/HANG already excluded)
  if (favoriteMatched) {
    score += 80;
  }

  // 3. Preferred provider boost
  const prefProvs = [
    ...(profile.preferredProviders ?? []),
    ...(profile.keyedProviders ?? []),
    ...(profile.general?.preferredProviders ?? []),
  ].map((p) => p.toLowerCase());
  if (prefProvs.includes(candidate.provider.toLowerCase())) {
    score += 20;
  }

  // 4. Priority-weighted attributes
  const getWeight = (keys: readonly string[]): number => {
    for (const k of keys) {
      const idx = priority.indexOf(k);
      if (idx !== -1) {
        return Math.max(0.4, 1.6 - idx * 0.3);
      }
    }
    return 0.6;
  };

  const qualityWeight = getWeight(['quality']);
  const speedWeight = getWeight(['speed']);
  const contextWeight = getWeight(['context', 'long-context']);
  const costWeight = getWeight(['cost', 'price']);

  const quality = Math.max(0, Math.min(100, candidate.qualityScore ?? 50));
  score += quality * 0.6 * qualityWeight;

  const latencyMs =
    candidate.reliability?.p50 ??
    candidate.reliability?.p90 ??
    (candidate.reliability?.headerMs.length ? candidate.reliability.headerMs[0]! : null);
  if (latencyMs !== null && latencyMs > 0) {
    const speedBonus = Math.max(0, 50 - Math.min(50, latencyMs / 200));
    score += speedBonus * speedWeight;
  }

  if (candidate.contextLength && candidate.contextLength > 0) {
    const ctxBonus = Math.min(40, Math.log2(Math.max(1, candidate.contextLength / 8192)) * 8);
    if (ctxBonus > 0) {
      score += ctxBonus * contextWeight;
    }
  }

  if (candidate.free === true) {
    score += 25 * costWeight;
  }

  return Math.round(score * 1000) / 1000;
}

function resolveRecommendedStrategy(
  routerKind: SelectorRouterKind | undefined,
  hasMultiKeyPool: boolean
): { recommendedStrategy: string; recommendedPoolStrategy?: string | undefined } {
  if (routerKind === 'omniroute') {
    return { recommendedStrategy: 'priority' };
  }
  if (routerKind === 'litellm') {
    return {
      recommendedStrategy: 'fallbacks',
      ...(hasMultiKeyPool ? { recommendedPoolStrategy: 'simple-shuffle' } : {}),
    };
  }
  return { recommendedStrategy: 'fallback' };
}

export function selectComboSteps(input: ComboSelectionInput): ComboSelectionResult {
  const options = input.options ?? {};
  const profile: ComboSelectorProfileShape = options.profile ?? {};
  const warnings: string[] = [];
  const excluded: ExcludedCandidate[] = [];

  const freeOnlyMode =
    profile.budget === 'free-only' ||
    (profile.budget === undefined &&
      (profile.freeOnly === true || profile.general?.costPreference === 'free-only'));

  const minSteps = Math.max(2, options.minSteps ?? 2);
  const defaultMax = freeOnlyMode ? 15 : 12;
  const rawMax = options.maxSteps ?? defaultMax;
  const upperClamp = options.allowAbove15 === true ? Math.max(15, rawMax) : 15;
  const effectiveMaxSteps = Math.max(minSteps, Math.min(upperClamp, rawMax));

  const blockEntries = [
    ...(profile.blockList ?? []),
    ...(profile.denyList ?? []),
    ...(profile.dislikedProviders ?? []),
    ...(profile.general?.excludedProviders ?? []),
  ];
  const allowEntries = [...(profile.allowList ?? [])];
  const favorites = [...(profile.favorites ?? [])];

  const scoredPool: ScoredComboCandidate[] = [];
  const seenSteps = new Set<string>();

  for (const candidate of input.candidates) {
    if (seenSteps.has(candidate.step)) {
      continue;
    }
    seenSteps.add(candidate.step);

    const isFavorite = matchesEntryList(candidate, favorites);

    // 1. Block-list / allow-list
    if (matchesEntryList(candidate, blockEntries)) {
      excluded.push({
        step: candidate.step,
        provider: candidate.provider,
        modelId: candidate.modelId,
        reason: 'block-list',
      });
      continue;
    }

    if (allowEntries.length > 0 && !matchesEntryList(candidate, allowEntries)) {
      excluded.push({
        step: candidate.step,
        provider: candidate.provider,
        modelId: candidate.modelId,
        reason: 'not-in-allow-list',
      });
      continue;
    }

    // 2. Non-chat specialist check across all 5 families + vision-only
    const specialist = classifyNonChatSpecialist({
      modelId: candidate.step || candidate.modelId,
      mode: candidate.mode,
      type: candidate.type,
      capabilities: candidate.capabilities,
      inputModalities: candidate.inputModalities,
      outputModalities: candidate.outputModalities,
    });
    if (specialist !== null) {
      excluded.push({
        step: candidate.step,
        provider: candidate.provider,
        modelId: candidate.modelId,
        reason: `non-chat-specialist:${specialist}`,
      });
      continue;
    }

    // 3. Hard DEAD / HANG reliability exclusion (zero exceptions, even in favorites!)
    const relLabel = candidate.reliability?.label;
    if (relLabel === 'DEAD') {
      excluded.push({
        step: candidate.step,
        provider: candidate.provider,
        modelId: candidate.modelId,
        reason: 'unreliable-dead',
      });
      if (isFavorite) {
        warnings.push(
          `Excluded favorite "${candidate.step}" because measured reliability label is DEAD.`
        );
      }
      continue;
    }
    if (relLabel === 'HANG') {
      excluded.push({
        step: candidate.step,
        provider: candidate.provider,
        modelId: candidate.modelId,
        reason: 'unreliable-hang',
      });
      if (isFavorite) {
        warnings.push(
          `Excluded favorite "${candidate.step}" because measured reliability label is HANG.`
        );
      }
      continue;
    }

    // 4. Budget free-only check (Invariant I6)
    if (freeOnlyMode && (candidate.free !== true || candidate.pricingKnown === false)) {
      excluded.push({
        step: candidate.step,
        provider: candidate.provider,
        modelId: candidate.modelId,
        reason: 'budget-free-only',
      });
      continue;
    }

    const score = computeCandidateScore(candidate, profile, isFavorite);
    scoredPool.push({
      step: candidate.step,
      provider: candidate.provider,
      modelId: candidate.modelId,
      score,
      candidate,
    });
  }

  // Sort deterministically by descending score, then lexicographical step
  scoredPool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.step.localeCompare(b.step);
  });

  const strategyInfo = resolveRecommendedStrategy(
    options.routerKind,
    options.hasMultiKeyPool === true
  );

  // Invariant I3 floor check
  if (scoredPool.length < minSteps) {
    warnings.push(
      `Invariant I3: at least ${minSteps} healthy chat steps are required, but only ${scoredPool.length} candidate(s) survived filtering.`
    );
    return {
      selectedSteps: [],
      selectedCandidates: [],
      excluded,
      warnings,
      insufficientCandidates: true,
      adjacentSameProviderCount: 0,
      distinctProviders: 0,
      effectiveMaxSteps,
      minSteps,
      ...strategyInfo,
    };
  }

  // Select top N <= effectiveMaxSteps while preserving provider diversity (I7)
  // so no single provider exceeds Math.ceil(targetCount / 2) when alternatives exist.
  const targetCount = Math.min(scoredPool.length, effectiveMaxSteps);
  const maxSharePerProvider = Math.ceil(targetCount / 2);
  const perProviderCounts = new Map<string, number>();
  const primarySlice: ScoredComboCandidate[] = [];
  const deferredSlice: ScoredComboCandidate[] = [];

  for (const item of scoredPool) {
    if (primarySlice.length >= targetCount) break;
    const provKey = item.provider.toLowerCase();
    const count = perProviderCounts.get(provKey) ?? 0;
    if (count < maxSharePerProvider) {
      primarySlice.push(item);
      perProviderCounts.set(provKey, count + 1);
    } else {
      deferredSlice.push(item);
    }
  }

  for (const item of deferredSlice) {
    if (primarySlice.length >= targetCount) break;
    primarySlice.push(item);
  }

  const interleaved = interleaveAcrossProviders(primarySlice);
  if (interleaved.distinctProviders < 2) {
    warnings.push(
      'Invariant I7 warning: selected combo steps belong to a single provider; add a second keyed provider to avoid provider-wide rate-limit stalls.'
    );
  }

  return {
    selectedSteps: interleaved.ordered.map((x) => x.step),
    selectedCandidates: interleaved.ordered,
    excluded,
    warnings,
    insufficientCandidates: false,
    adjacentSameProviderCount: interleaved.adjacentSameProviderCount,
    distinctProviders: interleaved.distinctProviders,
    effectiveMaxSteps,
    minSteps,
    ...strategyInfo,
  };
}
