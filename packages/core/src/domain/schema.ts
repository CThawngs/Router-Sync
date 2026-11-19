/**
 * packages/core/src/domain/schema.ts
 * 
 * Zod schemas and TypeScript domain types for RouterSync.
 */

import { z } from 'zod';

export const ModelPricingSchema = z.object({
  promptCostPerToken: z.number().nonnegative().optional(),
  completionCostPerToken: z.number().nonnegative().optional(),
  cacheReadCostPerToken: z.number().nonnegative().optional(),
  cacheWriteCostPerToken: z.number().nonnegative().optional(),
});

export const ModelCapabilitiesSchema = z.object({
  functionCalling: z.boolean().optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  streaming: z.boolean().optional(),
});

export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  provider: z.string().min(1),
  contextLength: z.number().int().positive().optional(),
  modalities: z.array(z.string()).optional(),
  pricing: ModelPricingSchema.optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  status: z.enum(['active', 'quarantined', 'dead']).optional(),
});

export const ComboDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  strategy: z.string().min(1).optional(),
  models: z.array(z.string().min(1)),
  managed: z.boolean().default(true),
  minSteps: z.number().int().min(1).optional(),
  freeOnly: z.boolean().optional(),
  autoMaintain: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  updatedAt: z.string().optional(),
  systemMessage: z.string().optional(),
  rawData: z.record(z.string(), z.unknown()).optional(),
});

export const SnapshotSchema = z.object({
  id: z.string().min(1),
  target: z.string().min(1),
  timestamp: z.string().min(1),
  combos: z.array(ComboDefinitionSchema),
  metadata: z.record(z.string(), z.unknown()).optional(),
  backupFilePath: z.string().optional(),
});

export const PlanSchema = z.object({
  id: z.string().min(1),
  target: z.string().min(1),
  timestamp: z.string().min(1),
  additions: z.array(ComboDefinitionSchema),
  modifications: z.array(ComboDefinitionSchema),
  deletions: z.array(z.string()),
  reasons: z.record(z.string(), z.string()),
  snapshotId: z.string().optional(),
});

export const ApplyResultSchema = z.object({
  success: z.boolean(),
  target: z.string().min(1),
  appliedAt: z.string().min(1),
  planId: z.string().min(1),
  readBackVerified: z.boolean(),
  staleDetected: z.boolean(),
  error: z.string().optional(),
  rollbackExecuted: z.boolean().optional(),
});

export const HealthStatusSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['ok', 'degraded', 'down']),
  latencyMs: z.number().nonnegative().optional(),
  message: z.string().optional(),
  timestamp: z.string().min(1),
});

export const ComboRuleSchema = z.object({
  comboId: z.string().min(1),
  name: z.string().min(1),
  strategy: z.string().default('priority'),
  minSteps: z.number().int().min(1).default(2),
  freeOnly: z.boolean().default(false),
  requiredCapabilities: z.array(z.string()).default([]),
  allowedProviders: z.array(z.string()).optional(),
  excludedModels: z.array(z.string()).default([]),
  pinnedModels: z.array(z.string()).default([]),
  maxSteps: z.number().int().positive().default(5),
});

export type ModelPricing = z.infer<typeof ModelPricingSchema>;
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
export type ModelInfo = z.infer<typeof ModelInfoSchema>;
export type ComboDefinition = z.infer<typeof ComboDefinitionSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type ApplyResult = z.infer<typeof ApplyResultSchema>;
export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export type ComboRule = z.infer<typeof ComboRuleSchema>;

// --- Model Tier Architecture (3-Tier Universe: R3) ---

export const ModelTierSchema = z.enum(['A', 'B', 'C', 'UNKNOWN']);
export type ModelTier = 'A' | 'B' | 'C' | 'UNKNOWN';

export const PlanActionTypeSchema = z.enum([
  'REMOVE_MODEL',
  'ENABLE_MODEL',
  'ADD_MODEL',
  'DISABLE_MODEL',
]);
export type PlanActionType = z.infer<typeof PlanActionTypeSchema>;

export const TieredModelEntrySchema = z.object({
  modelId: z.string().min(1),
  provider: z.string().min(1),
  tier: ModelTierSchema,
  inCombo: z.boolean().default(false),
  reason: z.string().optional(),
  capabilities: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional(),
  source: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type TieredModelEntry = z.infer<typeof TieredModelEntrySchema>;

export const ModelTierEvidenceSchema = z.object({
  modelId: z.string().min(1),
  provider: z.string().min(1),
  observedTier: ModelTierSchema,
  sourceEvidence: z.enum(['router_active', 'router_disabled', 'catalog', 'public_api', 'web_search']),
  rawStatus: z.string().nullable().optional(),
  observedAt: z.string().min(1),
});
export type ModelTierEvidence = z.infer<typeof ModelTierEvidenceSchema>;

export const ProviderModelUniverseSchema = z.object({
  provider: z.string().min(1),
  tiers: z.object({
    A: z.array(TieredModelEntrySchema),
    B: z.array(TieredModelEntrySchema),
    C: z.array(TieredModelEntrySchema),
    UNKNOWN: z.array(TieredModelEntrySchema).optional(),
  }),
  counts: z.object({
    A: z.number().int().nonnegative(),
    B: z.number().int().nonnegative(),
    C: z.number().int().nonnegative(),
    UNKNOWN: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative(),
  }),
  timestamp: z.string().optional(),
});
export type ProviderModelUniverse = z.infer<typeof ProviderModelUniverseSchema>;

/**
 * Pure classifier assigning a model to Tier A, B, C, or UNKNOWN:
 * Tier A: Model is active / enabled in router (regardless of whether it is in a combo).
 * Tier B: Model is known to router but disabled / deprecated / inactive suggestion.
 * Tier C: Model is discovered in official provider sources / registry / web, but unconfigured in router.
 * UNKNOWN: Cannot determine router state (e.g. unverified status).
 */
export function classifyModelTier(
  _modelId: string,
  status: {
    isActive?: boolean;
    isDisabled?: boolean;
    isKnownInRouter?: boolean;
    isDeprecated?: boolean;
    isDiscovered?: boolean;
    inCombo?: boolean;
    isUnknown?: boolean;
  }
): ModelTier {
  if (status.isUnknown) return 'UNKNOWN';
  if (status.isActive) return 'A';
  if (status.isDisabled || status.isDeprecated || status.isKnownInRouter) return 'B';
  return 'C';
}

/**
 * Builds a valid ProviderModelUniverse from raw entries, ensuring deterministic counts.
 */
export function buildProviderModelUniverse(
  provider: string,
  entries: TieredModelEntry[],
  timestamp: string = new Date().toISOString()
): ProviderModelUniverse {
  const tiers: {
    A: TieredModelEntry[];
    B: TieredModelEntry[];
    C: TieredModelEntry[];
    UNKNOWN: TieredModelEntry[];
  } = {
    A: [],
    B: [],
    C: [],
    UNKNOWN: [],
  };
  for (const entry of entries) {
    if (entry.tier === 'A') tiers.A.push(entry);
    else if (entry.tier === 'B') tiers.B.push(entry);
    else if (entry.tier === 'C') tiers.C.push(entry);
    else tiers.UNKNOWN.push(entry);
  }
  return {
    provider,
    tiers: {
      A: tiers.A,
      B: tiers.B,
      C: tiers.C,
      ...(tiers.UNKNOWN.length > 0 ? { UNKNOWN: tiers.UNKNOWN } : {}),
    },
    counts: {
      A: tiers.A.length,
      B: tiers.B.length,
      C: tiers.C.length,
      ...(tiers.UNKNOWN.length > 0 ? { UNKNOWN: tiers.UNKNOWN.length } : {}),
      total: entries.length,
    },
    timestamp,
  };
}

