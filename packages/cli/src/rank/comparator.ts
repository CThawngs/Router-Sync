/**
 * packages/cli/src/rank/comparator.ts
 *
 * Implements Policy §8.4: Strict Priority-Order Lexicographic Comparison.
 * Criterion 1 has absolute priority over Criterion 2.
 * Lower priority criterion is checked ONLY when all higher-priority criteria tie.
 * Weights are completely removed.
 * Tiers are dynamically resolved from configuration keys (e.g. tier1, tier2...).
 */

import type { RankingConfig, RankingCriterion, ModelRankItem } from './types.js';
import type { CatalogMetadata } from './filters.js';

/**
 * Dynamically resolves tier number from tierRules dictionary.
 * Parses tier number from key (e.g. "tier1", "tier1_claude", "tier6_fallback").
 * Returns 99 for unrated models.
 */
export function assignTier(modelId: string, tierRules: Record<string, string[]>): number {
  const lower = modelId.toLowerCase();

  // Extract keys and sort by numeric tier
  const entries: Array<{ tier: number; patterns: string[] }> = [];
  for (const [key, patterns] of Object.entries(tierRules)) {
    const match = key.match(/tier(\d+)/i);
    const tierNum = match ? parseInt(match[1]!, 10) : 99;
    entries.push({ tier: tierNum, patterns });
  }

  entries.sort((a, b) => a.tier - b.tier);

  for (const { tier, patterns } of entries) {
    for (const p of patterns) {
      const patternLower = p.trim().toLowerCase();
      if (patternLower.length > 0 && lower.includes(patternLower)) {
        return tier;
      }
    }
  }

  return 99;
}

export function computeModelScores(
  modelId: string,
  tier: number,
  config: RankingConfig,
  catalogMeta?: CatalogMetadata
): {
  scores: Record<string, number>;
  stability: number | 'UNKNOWN';
  contextWindow: number | 'UNKNOWN';
} {
  const scores: Record<string, number> = {};

  // Criterion 1: Tier hierarchy (Tier 1 gets 100, Tier 2 gets 90, ..., Unrated gets 0)
  const tierScore = tier === 99 ? 0 : Math.max(0, 100 - (tier - 1) * 10);
  scores['tierHierarchy'] = tierScore;

  // Lookup grounded scores in config (only entries with verified sources)
  const lower = modelId.toLowerCase();
  let matchedStability: number | 'UNKNOWN' = 'UNKNOWN';
  let matchedContext: number | 'UNKNOWN' =
    typeof catalogMeta?.context_length === 'number' ? catalogMeta.context_length : 'UNKNOWN';

  for (const entry of config.modelScores) {
    if (lower.includes(entry.idPattern.toLowerCase())) {
      // Assign verified scores
      for (const [k, v] of Object.entries(entry.scores)) {
        scores[k] = v;
      }
      if (entry.stability !== undefined) {
        matchedStability = entry.stability;
      }
      if (entry.contextWindow !== undefined) {
        matchedContext = entry.contextWindow;
      }
      break;
    }
  }

  return {
    scores,
    stability: matchedStability,
    contextWindow: matchedContext,
  };
}

/**
 * Policy §8.4 Strict Lexicographic Comparator.
 * Priority 1 decides first; Priority 2 is evaluated only if Priority 1 ties.
 * Absolutely no weights or arbitrary sum formulas.
 */
export function compareModelsLexicographic(
  a: ModelRankItem,
  b: ModelRankItem,
  criteria: RankingCriterion[],
  demoteProviders: string[] = []
): number {
  if (demoteProviders.length > 0) {
    const aDemoted = demoteProviders.includes(a.provider);
    const bDemoted = demoteProviders.includes(b.provider);
    if (aDemoted !== bDemoted) {
      return aDemoted ? 1 : -1;
    }
  }

  const sortedCriteria = [...criteria].sort((x, y) => x.priority - y.priority);

  for (const crit of sortedCriteria) {
    const valA = a.scores[crit.id];
    const valB = b.scores[crit.id];

    if (valA !== undefined && valB !== undefined) {
      if (valA !== valB) {
        return valB - valA; // Higher score ranks first
      }
    } else if (valA !== undefined && valB === undefined) {
      return -1; // Grounded scored model ranks ahead of unscored
    } else if (valA === undefined && valB !== undefined) {
      return 1;
    }
  }

  // Tier tie-breaker (lower tier number is better)
  if (a.tier !== b.tier) {
    return a.tier - b.tier;
  }

  // Stable original order tie-breaker
  return a.originalIndex - b.originalIndex;
}
