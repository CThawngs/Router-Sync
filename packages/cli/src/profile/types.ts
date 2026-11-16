/**
 * packages/cli/src/profile/types.ts
 *
 * Types for RouterSync User Profile configuration.
 * Captures general workload preferences (P1-P3), combo constraints (C1-C5),
 * and native router strategy mappings (9Router sequential, OmniRoute Policy §12 matrix).
 */

export type WorkloadRole = 'coding' | 'reasoning' | 'general-chat' | 'agent';

export type CostPreference = 'free-only' | 'budget' | 'performance-first';

export type NativeStrategy9Router = 'fallback' | 'round-robin';

export type NativeStrategyOmniRoute = 'priority' | 'weighted' | 'round-robin';

export interface GeneralPreferences {
  /** P1: Primary workload / role */
  workload: WorkloadRole;
  /** P2: Cost preference */
  costPreference: CostPreference;
  /** P3: Provider preferences */
  preferredProviders: string[];
  excludedProviders: string[];
}

export interface ComboProfileRule {
  /** C1: Target combo name pattern or exact name (or "all") */
  targetCombo: string;
  /** C2: Preferred routing strategy */
  strategy: 'fallback' | 'round-robin' | 'priority-matrix';
  /** C3: Minimum required steps (Invariant I3 >= 2) */
  minSteps: number;
  /** C4: Provider interleaving on tail (diversity) */
  enableInterleaving: boolean;
  /** C5: Free-only constraint */
  freeOnly: boolean;
}

export interface RouterStrategyMapping {
  nineRouter: NativeStrategy9Router;
  omniRoute: NativeStrategyOmniRoute;
}

export interface UserProfile {
  version: number;
  name: string;
  updatedAt: string;
  general: GeneralPreferences;
  combos: ComboProfileRule[];
  strategyMapping: Record<string, RouterStrategyMapping>;
}
