/**
 * packages/core/src/domain/invariants.ts
 * 
 * Pure invariant validators for RouterSync (Invariants I1–I8).
 */

import type { ComboDefinition, ModelInfo, Plan } from './schema.js';

export type InvariantCode = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'I8';

export interface InvariantViolation {
  code: InvariantCode;
  severity: 'error' | 'warning';
  message: string;
  details?: Record<string, unknown>;
}

export interface InvariantValidationResult {
  valid: boolean;
  violations: InvariantViolation[];
}

export interface InvariantContext {
  combos: ComboDefinition[];
  catalog: ModelInfo[];
  unmanagedCombos?: ComboDefinition[];
  plan?: Plan;
  writeSequence?: string[];
  adoptedCombos?: string[];
}

/**
 * Validates Invariants I1 to I8 against the current state, catalog, and optional plan/write sequence.
 */
export function validateInvariants(context: InvariantContext): InvariantValidationResult {
  const violations: InvariantViolation[] = [];
  const catalogMap = new Map<string, ModelInfo>(context.catalog.map((m) => [m.id, m]));

  for (const combo of context.combos) {
    if (!combo.managed) {
      continue;
    }

    const minSteps = combo.minSteps ?? 2;

    // --- I1: Combo managed không trỏ model không tồn tại trong catalog ---
    for (const modelId of combo.models) {
      if (!catalogMap.has(modelId)) {
        violations.push({
          code: 'I1',
          severity: 'error',
          message: `Model '${modelId}' in managed combo '${combo.id}' does not exist in catalog`,
          details: { comboId: combo.id, missingModelId: modelId },
        });
      }
    }

    // --- I2: Model quarantined/dead không vào combo khi còn ứng viên khoẻ ---
    const healthyCandidatesAvailable = context.catalog.some(
      (m) => m.status === 'active' && !combo.models.includes(m.id)
    );

    for (const modelId of combo.models) {
      const model = catalogMap.get(modelId);
      if (model && (model.status === 'dead' || model.status === 'quarantined')) {
        violations.push({
          code: 'I2',
          severity: 'error',
          message: `Model '${modelId}' with status '${model.status}' included in combo '${combo.id}' while healthy candidates are available`,
          details: { comboId: combo.id, modelId, status: model.status, healthyCandidatesAvailable },
        });
      }
    }

    // --- I3: Combo giữ >= minSteps (mặc định 2) ---
    if (combo.models.length < minSteps) {
      violations.push({
        code: 'I3',
        severity: 'error',
        message: `Managed combo '${combo.id}' has ${combo.models.length} model(s), which is less than minSteps (${minSteps})`,
        details: { comboId: combo.id, currentSteps: combo.models.length, minSteps },
      });
    }

    // --- I6: Combo freeOnly không chứa metered/unknown ---
    if (combo.freeOnly) {
      for (const modelId of combo.models) {
        const model = catalogMap.get(modelId);
        if (!model) continue;

        if (!model.pricing) {
          violations.push({
            code: 'I6',
            severity: 'error',
            message: `Free-only combo '${combo.id}' contains model '${modelId}' with unknown pricing`,
            details: { comboId: combo.id, modelId },
          });
        } else {
          const isMetered =
            (model.pricing.promptCostPerToken !== undefined && model.pricing.promptCostPerToken > 0) ||
            (model.pricing.completionCostPerToken !== undefined && model.pricing.completionCostPerToken > 0);
          if (isMetered) {
            violations.push({
              code: 'I6',
              severity: 'error',
              message: `Free-only combo '${combo.id}' contains metered model '${modelId}'`,
              details: { comboId: combo.id, modelId, pricing: model.pricing },
            });
          }
        }
      }
    }

    // --- I7: >= 2 provider độc lập mỗi combo (cảnh báo) ---
    const providers = new Set<string>();
    for (const modelId of combo.models) {
      const model = catalogMap.get(modelId);
      if (model?.provider) {
        providers.add(model.provider);
      }
    }
    if (combo.models.length >= 2 && providers.size < 2) {
      violations.push({
        code: 'I7',
        severity: 'warning',
        message: `Combo '${combo.id}' has models from only ${providers.size} provider(s); recommended at least 2 independent providers to avoid single-point-of-failure`,
        details: { comboId: combo.id, providerCount: providers.size, providers: Array.from(providers) },
      });
    }
  }

  // --- I5: Không đụng combo không managed / không adopted ---
  if (context.plan) {
    const adoptedSet = new Set<string>(context.adoptedCombos ?? []);
    const unmanagedIds = new Set<string>(
      (context.unmanagedCombos ?? context.combos.filter((c) => !c.managed))
        .map((c) => c.id)
        .filter((id) => !adoptedSet.has(id))
    );

    for (const mod of context.plan.modifications) {
      if (unmanagedIds.has(mod.id)) {
        violations.push({
          code: 'I5',
          severity: 'error',
          message: `Attempted to modify unmanaged combo '${mod.id}' in plan`,
          details: { comboId: mod.id },
        });
      }
    }

    for (const delId of context.plan.deletions) {
      if (unmanagedIds.has(delId) || adoptedSet.has(delId)) {
        violations.push({
          code: 'I5',
          severity: 'error',
          message: `Attempted to delete unmanaged or adopted combo '${delId}' in plan`,
          details: { comboId: delId },
        });
      }
    }
  }

  // --- I8: Thứ tự ghi: providers -> models -> combos -> default slots ---
  if (context.writeSequence && context.writeSequence.length > 0) {
    const validOrder = ['providers', 'models', 'combos', 'defaultSlots'];
    let lastIndex = -1;
    for (const step of context.writeSequence) {
      const currentIndex = validOrder.indexOf(step);
      if (currentIndex !== -1) {
        if (currentIndex < lastIndex) {
          violations.push({
            code: 'I8',
            severity: 'error',
            message: `Write sequence violates dependency order I8: '${step}' executed after higher-level entity`,
            details: { writeSequence: context.writeSequence, currentStep: step },
          });
          break;
        }
        lastIndex = currentIndex;
      }
    }
  }

  const hasErrors = violations.some((v) => v.severity === 'error');
  return {
    valid: !hasErrors,
    violations,
  };
}
