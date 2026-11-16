/**
 * packages/core/src/planner/index.ts
 * 
 * Pure planner that calculates deterministic combo plans respecting Invariants I1–I8.
 */

import type { ComboDefinition, ComboRule, ModelInfo, Plan } from '../domain/schema.js';
import { validateInvariants } from '../domain/invariants.js';

export interface AdoptSpec {
  name: string;
  mode: 'guard' | 'full';
}

export interface PlanOptions {
  target?: string;
  snapshotId?: string;
  adopt?: AdoptSpec[];
}

/**
 * Plans deterministic combo additions, modifications, and deletions.
 * Fully pure and idempotent (I4).
 */
export function planCombos(
  currentCombos: ComboDefinition[],
  catalog: ModelInfo[],
  rules: ComboRule[],
  options: PlanOptions = {}
): Plan {
  const target = options.target ?? 'default-router';
  const planId = `plan_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const timestamp = new Date().toISOString();

  const currentMap = new Map<string, ComboDefinition>(currentCombos.map((c) => [c.id, c]));
  const catalogMap = new Map<string, ModelInfo>(catalog.map((m) => [m.id, m]));

  const additions: ComboDefinition[] = [];
  const modifications: ComboDefinition[] = [];
  const deletions: string[] = [];
  const reasons: Record<string, string> = {};

  const processedComboIds = new Set<string>();

  for (const rule of rules) {
    processedComboIds.add(rule.comboId);
    const existingCombo = currentMap.get(rule.comboId);

    // If existing combo is explicitly unmanaged, DO NOT touch it unless adopted with mode 'full' (I5)
    if (existingCombo && !existingCombo.managed) {
      const isAdoptFull = options.adopt?.some(
        (a) => (a.name === rule.comboId || a.name === existingCombo.name) && a.mode === 'full'
      );
      if (!isAdoptFull) {
        continue;
      }
    }

    // 1. Filter candidates according to rule
    const validCandidates = catalog.filter((model) => {
      // Exclude dead or quarantined models (I2)
      if (model.status === 'dead' || model.status === 'quarantined') {
        return false;
      }

      // Exclude explicitly forbidden models
      if (rule.excludedModels.includes(model.id)) {
        return false;
      }

      // Filter by allowed providers
      if (rule.allowedProviders && rule.allowedProviders.length > 0) {
        if (!rule.allowedProviders.includes(model.provider)) {
          return false;
        }
      }

      // I6: Filter free-only
      if (rule.freeOnly) {
        if (!model.pricing) return false;
        const isMetered =
          (model.pricing.promptCostPerToken !== undefined && model.pricing.promptCostPerToken > 0) ||
          (model.pricing.completionCostPerToken !== undefined && model.pricing.completionCostPerToken > 0);
        if (isMetered) return false;
      }

      // Check required capabilities
      if (rule.requiredCapabilities && rule.requiredCapabilities.length > 0) {
        if (!model.capabilities) return false;
        for (const cap of rule.requiredCapabilities) {
          if (cap === 'vision' && !model.capabilities.vision) return false;
          if (cap === 'functionCalling' && !model.capabilities.functionCalling) return false;
          if (cap === 'reasoning' && !model.capabilities.reasoning) return false;
          if (cap === 'streaming' && !model.capabilities.streaming) return false;
        }
      }

      return true;
    });

    // 2. Prioritize pinned models first, then fill from candidates up to maxSteps
    const selectedModelIds: string[] = [];

    for (const pinnedId of rule.pinnedModels) {
      const model = catalogMap.get(pinnedId);
      if (model && model.status === 'active') {
        if (!selectedModelIds.includes(pinnedId)) {
          selectedModelIds.push(pinnedId);
        }
      }
    }

    for (const cand of validCandidates) {
      if (selectedModelIds.length >= rule.maxSteps) break;
      if (!selectedModelIds.includes(cand.id)) {
        selectedModelIds.push(cand.id);
      }
    }

    // 3. Check I3: minSteps requirement
    if (selectedModelIds.length < rule.minSteps) {
      if (existingCombo) {
        // I3 fallback: Preserve existing combo rather than creating an invalid one
        reasons[rule.comboId] = `PRESERVED_CURRENT: candidates (${selectedModelIds.length}) below minSteps (${rule.minSteps})`;
      } else {
        reasons[rule.comboId] = `SKIPPED: candidates (${selectedModelIds.length}) below minSteps (${rule.minSteps})`;
      }
      continue;
    }

    const proposedCombo: ComboDefinition = {
      id: rule.comboId,
      name: rule.name,
      strategy: rule.strategy,
      models: selectedModelIds,
      managed: true,
      minSteps: rule.minSteps,
      freeOnly: rule.freeOnly,
      autoMaintain: false,
      updatedAt: timestamp,
    };

    // 4. Compare with existing combo for idempotency (I4)
    if (existingCombo) {
      const isModelsSame =
        existingCombo.models.length === selectedModelIds.length &&
        existingCombo.models.every((m, idx) => m === selectedModelIds[idx]);
      const isStrategySame = existingCombo.strategy === rule.strategy;
      const isNameSame = existingCombo.name === rule.name;

      if (isModelsSame && isStrategySame && isNameSame) {
        // Identical: No change required (I4)
        continue;
      }

      modifications.push(proposedCombo);
      reasons[rule.comboId] = `UPDATED: models or strategy adjusted`;
    } else {
      additions.push(proposedCombo);
      reasons[rule.comboId] = `ADDED: new managed combo`;
    }
  }

  // 4b. Process Adopt Guard combos (Condition B2, AT-8)
  for (const current of currentCombos) {
    const adoptGuard = options.adopt?.find(
      (a) => (a.name === current.id || a.name === current.name) && a.mode === 'guard'
    );
    if (!adoptGuard) continue;

    // Guard mode protects this combo from deletion even if absent from rules
    processedComboIds.add(current.id);

    // Filter out confirmed dead models, strictly preserving original order of remaining models
    const remainingModels: string[] = [];
    let deadCount = 0;
    for (const modelId of current.models) {
      const model = catalogMap.get(modelId);
      if (model && model.status === 'dead') {
        deadCount++;
      } else {
        remainingModels.push(modelId);
      }
    }

    if (deadCount > 0) {
      const minSteps = current.minSteps ?? 1;
      if (remainingModels.length < minSteps) {
        // I3 fallback: preserve current combo rather than leaving it below minSteps
        reasons[current.id] = `ADOPT_GUARD_PRESERVED: Pruning dead models leaves ${remainingModels.length} candidates, below minSteps (${minSteps})`;
      } else {
        modifications.push({
          ...current,
          models: remainingModels,
          updatedAt: timestamp,
        });
        reasons[current.id] = `ADOPT_GUARD: pruned ${deadCount} dead model(s) while strictly preserving manual order`;
      }
    }
  }

  // 5. Delete managed combos that are no longer specified in rules
  for (const current of currentCombos) {
    if (current.managed && !processedComboIds.has(current.id)) {
      deletions.push(current.id);
      reasons[current.id] = `DELETED: no longer defined in rules`;
    }
  }

  const plan: Plan = {
    id: planId,
    target,
    timestamp,
    additions,
    modifications,
    deletions,
    reasons,
  };

  if (options.snapshotId) {
    plan.snapshotId = options.snapshotId;
  }

  // Validate plan with invariant checks
  const futureCombos: ComboDefinition[] = [
    ...currentCombos.filter((c) => !deletions.includes(c.id) && !modifications.some((m) => m.id === c.id)),
    ...additions,
    ...modifications,
  ];

  const validation = validateInvariants({
    combos: futureCombos,
    catalog,
    unmanagedCombos: currentCombos.filter((c) => !c.managed),
    plan,
    adoptedCombos: (options.adopt ?? []).map((a) => a.name),
  });

  if (!validation.valid) {
    const errors = validation.violations.filter((v) => v.severity === 'error');
    const nonI6 = errors.filter((v) => v.code !== 'I6');
    if (nonI6.length > 0) {
      const errorMessages = nonI6.map((v) => `[${v.code}] ${v.message}`).join('; ');
      throw new Error(`Plan generation produced invariant violations: ${errorMessages}`);
    }
    // I6 only: HOLD/BLOCKED per-step, never fail whole plan (F1).
    const blockedIds = new Set<string>();
    for (const v of errors) {
      const comboId = typeof v.details?.comboId === 'string' ? (v.details.comboId as string) : null;
      if (comboId) blockedIds.add(comboId);
      const tagged = `BLOCKED HOLD I6: ${v.message}`;
      if (comboId) {
        plan.reasons[comboId] = plan.reasons[comboId] ? `${plan.reasons[comboId]} | ${tagged}` : tagged;
      }
    }
    for (let i = plan.additions.length - 1; i >= 0; i--) {
      if (blockedIds.has(plan.additions[i]!.id)) plan.additions.splice(i, 1);
    }
    for (let i = plan.modifications.length - 1; i >= 0; i--) {
      if (blockedIds.has(plan.modifications[i]!.id)) plan.modifications.splice(i, 1);
    }
    const blockedList = [...blockedIds].sort().join(', ') || '(unknown)';
    plan.reasons['__tally__'] = `BLOCKED HOLD: ${blockedIds.size} combo(s): ${blockedList}`;
  }

  return plan;
}
