/**
 * packages/cli/src/rank/types.ts
 *
 * Types and interfaces for model classification, scoring, priority-order
 * lexicographic comparison (Policy §8.4), and provider interleaving (D1).
 */

export interface RankingCriterion {
  id: string;
  name: string;
  priority: number; // 1 = highest priority
}

export interface ModelScoreEntry {
  idPattern: string;
  scores: Record<string, number>;
  sources: string[];
  checked_at: string;
  stability?: number | 'UNKNOWN' | undefined;
  contextWindow?: number | 'UNKNOWN' | undefined;
  reason?: string | undefined;
}

export type EvidenceLabel =
  | 'DEAD'
  | 'OPERATOR-DISABLED'
  | 'PROVIDER-INACTIVE'
  | 'NON-CHAT'
  | 'PAID';

export interface RankingConfig {
  version: number;
  blacklist: string[];
  operatorDisabled?: string[] | undefined;
  providerInactive?: string[] | undefined;
  nonChatPatterns: string[];
  zeroPaymentProviders: string[];
  demoteProviders: string[];
  excludeCombos: string[];
  criteria: RankingCriterion[];
  tierRules: Record<string, string[]>;
  modelScores: ModelScoreEntry[];
  interleaving: {
    enabled: boolean;
    applyToTiers: number[];
    preserveUnratedOrder: boolean;
  };
}

export type PriceStatus = 'FREE' | 'PRICE_UNVERIFIED' | 'PAID';

export interface ModelRankItem {
  id: string;
  raw: unknown;
  provider: string;
  tier: number; // 1-6 or 99 (unrated)
  scores: Record<string, number>;
  totalScore: number;
  originalIndex: number;
  priceStatus: PriceStatus;
  isDropped: boolean;
  dropReason?:
    | 'blacklist'
    | 'operator-disabled'
    | 'provider-inactive'
    | 'non-chat'
    | 'paid'
    | undefined;
  evidenceLabel?: EvidenceLabel | undefined;
  stability?: number | 'UNKNOWN' | undefined;
  contextWindow?: number | 'UNKNOWN' | undefined;
}

export interface ComboRankResult {
  comboName: string;
  routerId: string;
  originalCount: number;
  retainedCount: number;
  droppedCount: number;
  rankedModels: ModelRankItem[];
  droppedModels: ModelRankItem[];
  top15Before: string[];
  top15After: string[];
  positionChangesCount: number;
  providerAdditions: Record<string, number>;
  providerRemovals: Record<string, number>;
  coverageBefore: Record<string, number>;
  coverageAfter: Record<string, number>;
  lostProviders: string[];
  pendingOperatorDisabled?: string[] | undefined;
  pendingProviderInactive?: string[] | undefined;
  shrinkCappedCount?: number | undefined;
}
