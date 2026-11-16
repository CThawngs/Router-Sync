/**
 * packages/cli/src/rank/ranker.ts
 *
 * Core ranking engine pipeline:
 * Filter (blacklist, non-chat, price) -> Score & Lexicographic Sort (Policy §8.4) -> Interleave Tail (D1).
 * Enforces Invariant I3 (minimum 2 steps required for any proposed combo).
 */

import type {
  RankingConfig,
  ModelRankItem,
  ComboRankResult,
} from './types.js';
import {
  extractProvider,
  isBlacklisted,
  isNonChat,
  classifyPrice,
  loadModelCatalog,
} from './filters.js';
import {
  assignTier,
  computeModelScores,
  compareModelsLexicographic,
} from './comparator.js';
import { applyRankingInterleave } from './interleave.js';

export function extractModelId(rawItem: unknown): string {
  if (typeof rawItem === 'string') {
    return rawItem.trim();
  }
  if (rawItem && typeof rawItem === 'object') {
    const obj = rawItem as Record<string, unknown>;
    if (typeof obj['model'] === 'string' && obj['model'].trim().length > 0) {
      return obj['model'].trim();
    }
    if (typeof obj['id'] === 'string' && obj['id'].trim().length > 0) {
      return obj['id'].trim();
    }
  }
  return String(rawItem ?? '').trim();
}

export function isComboExcluded(comboName: string, excludeList: string[]): boolean {
  const lower = comboName.toLowerCase().trim();
  for (const ex of excludeList) {
    if (lower === ex.toLowerCase().trim() || lower.includes(ex.toLowerCase().trim())) {
      return true;
    }
  }
  return false;
}

export interface RankComboOptions {
  allowOperatorDisabled?: boolean | undefined;
  allowProviderInactive?: boolean | undefined;
  maxShrinkRatio?: number | undefined;
}

export function rankComboModels(
  comboName: string,
  routerId: string,
  rawModels: unknown[],
  config: RankingConfig,
  options: RankComboOptions = {}
): ComboRankResult {
  const originalCount = rawModels.length;
  const retained: ModelRankItem[] = [];
  const dropped: ModelRankItem[] = [];
  const pendingOperatorDisabled: string[] = [];
  const pendingProviderInactive: string[] = [];

  const catalog = loadModelCatalog();
  const top15Before: string[] = rawModels.slice(0, 15).map(extractModelId);

  // Measure initial coverage
  const coverageBefore: Record<string, number> = {};
  for (const raw of rawModels) {
    const id = extractModelId(raw);
    const { provider } = extractProvider(id);
    coverageBefore[provider] = (coverageBefore[provider] ?? 0) + 1;
  }

  // 1. Filtering & Classification
  for (let idx = 0; idx < rawModels.length; idx++) {
    const raw = rawModels[idx];
    const id = extractModelId(raw);
    const { provider } = extractProvider(id);
    const catalogMeta = catalog[id];

    const priceStatus = classifyPrice(id, provider, config.zeroPaymentProviders, catalogMeta);

    const item: ModelRankItem = {
      id,
      raw,
      provider,
      tier: 99,
      scores: {},
      totalScore: 0,
      originalIndex: idx,
      priceStatus,
      isDropped: false,
    };

    if (config.operatorDisabled && isBlacklisted(id, config.operatorDisabled)) {
      item.evidenceLabel = 'OPERATOR-DISABLED';
      if (options.allowOperatorDisabled) {
        item.isDropped = true;
        item.dropReason = 'operator-disabled';
        dropped.push(item);
        continue;
      }
      pendingOperatorDisabled.push(id);
    }

    if (config.providerInactive && isBlacklisted(id, config.providerInactive)) {
      item.evidenceLabel = 'PROVIDER-INACTIVE';
      if (options.allowProviderInactive) {
        item.isDropped = true;
        item.dropReason = 'provider-inactive';
        dropped.push(item);
        continue;
      }
      pendingProviderInactive.push(id);
    }

    if (isBlacklisted(id, config.blacklist)) {
      item.isDropped = true;
      item.dropReason = 'blacklist';
      item.evidenceLabel = 'DEAD';
      dropped.push(item);
      continue;
    }

    if (isNonChat(id, config.nonChatPatterns)) {
      item.isDropped = true;
      item.dropReason = 'non-chat';
      item.evidenceLabel = 'NON-CHAT';
      dropped.push(item);
      continue;
    }

    // Only drop if confirmed paid (> 0) on non-zero-payment provider
    if (priceStatus === 'PAID') {
      item.isDropped = true;
      item.dropReason = 'paid';
      item.evidenceLabel = 'PAID';
      dropped.push(item);
      continue;
    }

    // 2. Dynamic Tier Assignment & Grounded Scoring
    item.tier = assignTier(id, config.tierRules);
    const { scores, stability, contextWindow } = computeModelScores(
      id,
      item.tier,
      config,
      catalogMeta
    );
    item.scores = scores;
    item.stability = stability;
    item.contextWindow = contextWindow;

    retained.push(item);
  }

  let shrinkCappedCount = 0;
  if (options.maxShrinkRatio !== undefined && options.maxShrinkRatio >= 0 && originalCount > 0) {
    const maxDropped = Math.min(
      Math.max(0, Math.floor(originalCount * options.maxShrinkRatio)),
      Math.max(0, originalCount - 2)
    );
    if (dropped.length > maxDropped) {
      const overflow = dropped.splice(maxDropped);
      shrinkCappedCount = overflow.length;
      for (const item of overflow) {
        item.isDropped = false;
        item.tier = assignTier(item.id, config.tierRules);
        const catalogMeta = catalog[item.id];
        const { scores, stability, contextWindow } = computeModelScores(
          item.id,
          item.tier,
          config,
          catalogMeta
        );
        item.scores = scores;
        item.stability = stability;
        item.contextWindow = contextWindow;
        retained.push(item);
      }
    }
  }

  // Invariant I3 verification: minimum 2 steps required
  if (retained.length < 2) {
    throw new Error(
      `[INVARIANT VIOLATION I3] Combo '${comboName}' (${routerId}) chỉ còn ${retained.length} bước sau khi lọc (< 2 bước tối thiểu). Dừng xử lý để bảo vệ tính sẵn sàng của combo.`
    );
  }

  // 3. Strict Lexicographic Priority-Order Sort (Policy §8.4)
  retained.sort((a, b) => compareModelsLexicographic(a, b, config.criteria, config.demoteProviders));

  // 4. Provider Interleaving (D1) on Tail (Tier 6 and UNRATED)
  let finalRanked = retained;
  if (config.interleaving.enabled) {
    finalRanked = applyRankingInterleave(
      retained,
      config.interleaving.applyToTiers,
      config.interleaving.preserveUnratedOrder
    );
  }

  const top15After: string[] = finalRanked.slice(0, 15).map((m) => m.id);

  // Measure after coverage
  const coverageAfter: Record<string, number> = {};
  for (const m of finalRanked) {
    const p = m.provider || 'unknown';
    coverageAfter[p] = (coverageAfter[p] ?? 0) + 1;
  }

  // Position changes in retained set
  let positionChangesCount = 0;
  for (let i = 0; i < finalRanked.length; i++) {
    if (finalRanked[i]!.originalIndex !== i) {
      positionChangesCount++;
    }
  }

  // Lost providers check (any provider present before that has 0 after)
  const lostProviders: string[] = [];
  for (const prov of Object.keys(coverageBefore)) {
    if ((coverageAfter[prov] ?? 0) === 0) {
      lostProviders.push(prov);
    }
  }

  // Provider additions and removals
  const providerAdditions: Record<string, number> = {};
  const providerRemovals: Record<string, number> = {};
  for (const item of dropped) {
    providerRemovals[item.provider] = (providerRemovals[item.provider] ?? 0) + 1;
  }

  return {
    comboName,
    routerId,
    originalCount,
    retainedCount: finalRanked.length,
    droppedCount: dropped.length,
    rankedModels: finalRanked,
    droppedModels: dropped,
    top15Before,
    top15After,
    positionChangesCount,
    providerAdditions,
    providerRemovals,
    coverageBefore,
    coverageAfter,
    lostProviders,
    pendingOperatorDisabled,
    pendingProviderInactive,
    shrinkCappedCount,
  };
}
