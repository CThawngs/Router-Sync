/**
 * packages/adapter-sdk/src/types.ts
 * 
 * Standardized interfaces for RouterSync Adapters, Harnesses, and Catalog Sources.
 */

export interface ModelPricing {
  promptCostPerToken?: number | undefined;
  completionCostPerToken?: number | undefined;
  cacheReadCostPerToken?: number | undefined;
  cacheWriteCostPerToken?: number | undefined;
}

export interface ModelCapabilities {
  functionCalling?: boolean | undefined;
  vision?: boolean | undefined;
  reasoning?: boolean | undefined;
  streaming?: boolean | undefined;
}

export interface ModelInfo {
  id: string;
  name?: string | undefined;
  provider: string;
  contextLength?: number | undefined;
  modalities?: string[] | undefined;
  pricing?: ModelPricing | undefined;
  capabilities?: ModelCapabilities | undefined;
  status?: 'active' | 'quarantined' | 'dead' | undefined;
}

export interface ComboDefinition {
  id: string;
  name: string;
  strategy?: string | undefined;
  models: string[];
  managed: boolean;
  minSteps?: number | undefined;
  freeOnly?: boolean | undefined;
  autoMaintain?: boolean | undefined;
  sortOrder?: number | undefined;
  updatedAt?: string | undefined;
  systemMessage?: string | undefined;
  rawData?: Record<string, unknown> | undefined;
}

export interface Snapshot {
  id: string;
  target: string;
  timestamp: string;
  combos: ComboDefinition[];
  metadata?: Record<string, unknown> | undefined;
  backupFilePath?: string | undefined;
}

export interface Plan {
  id: string;
  target: string;
  timestamp: string;
  additions: ComboDefinition[];
  modifications: ComboDefinition[];
  deletions: string[];
  reasons: Record<string, string>;
  snapshotId?: string | undefined;
}

export type ReadBackLevel = 'full' | 'existence-only' | 'db-only' | 'db-only (degraded)';

/**
 * Canonical read-back vocabulary shared by adapters, CLI and daemon.
 * `full` is reported as `api-verified`; every degraded/unknown value is `db-only`.
 */
export type CanonicalReadBackLevel = 'api-verified' | 'existence-only' | 'db-only';

export function normalizeReadBackLevel(
  level: ReadBackLevel | 'db-only' | 'api-verified' | undefined
): CanonicalReadBackLevel {
  if (level === 'full' || level === 'api-verified') return 'api-verified';
  if (level === 'existence-only') return 'existence-only';
  return 'db-only';
}

/**
 * Apply state (Spec §33.3, AT-109):
 * - 'verified': write persisted AND serving-path reflection confirmed (full/existence-only).
 * - 'written-pending-reload': write persisted to DB but serving-path reflection is
 *   unconfirmed (db-only). The combo becomes visible on the router only after the
 *   router reloads/refreshes its cache. Daemon must NOT count this as success.
 * - 'unwritten' (R19-2, DECISIONS 2026-10-18-01): there is NO evidence that this
 *   target was ever written. The value is ADDED; the two values above keep their
 *   meaning. A reader must never print 'written-pending-reload' without evidence
 *   of a write, so the absence of evidence gets its own name.
 */
export type ApplyState = 'verified' | 'written-pending-reload' | 'unwritten';

export interface ApplyResult {
  success: boolean;
  target: string;
  appliedAt: string;
  planId: string;
  readBackVerified: boolean;
  staleDetected: boolean;
  readBackLevel?: ReadBackLevel | undefined;
  canonicalReadBackLevel?: CanonicalReadBackLevel | undefined;
  degradedReason?: string | undefined;
  applyState?: ApplyState | undefined;
  error?: string | undefined;
  rollbackExecuted?: boolean | undefined;
}

export interface HealthStatus {
  ok: boolean;
  status: 'ok' | 'degraded' | 'down';
  latencyMs?: number | undefined;
  message?: string | undefined;
  timestamp: string;
}

export interface RouterAdapter {
  readonly name: string;
  readonly tier: 'T1' | 'T2' | 'T3';
  checkHealth(): Promise<HealthStatus>;
  readCatalog(): Promise<ModelInfo[]>;
  readCombos(): Promise<ComboDefinition[]>;
  createSnapshot(): Promise<Snapshot>;
  applyPlan(plan: Plan): Promise<ApplyResult>;
  rollback(snapshot: Snapshot): Promise<boolean>;
}

export interface HarnessConfigInfo {
  primaryRouter?: string | undefined;
  secondaryRouter?: string | undefined;
  activeModel?: string | undefined;
  isTargeting(routerName: string): boolean;
}

export interface HarnessAdapter {
  readonly name: string;
  detect(): Promise<boolean>;
  readActiveConfig(): Promise<HarnessConfigInfo>;
  injectMcpServer(serverConfig: Record<string, unknown>): Promise<boolean>;
}

export interface CatalogSource {
  readonly name: string;
  fetchCatalog(): Promise<ModelInfo[]>;
}
