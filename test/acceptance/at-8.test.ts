/**
 * test/acceptance/at-8.test.ts
 *
 * Acceptance Test AT-8: Adopt Guard and Unmanaged Combo Safety (Condition B2, Invariant I5).
 *
 * Spec:
 *  - Unmanaged/manual combos not in `adopt` configuration are NEVER touched (never modified, never deleted).
 *  - Combos in `adopt` with `mode: 'guard'` ONLY have confirmed dead models pruned;
 *    their manual model ordering is strictly preserved and no foreign models are inserted.
 *  - Managed combos are fully updated and managed according to rules.
 */

import { describe, it, expect } from 'vitest';
import { FakeRouter } from '../harness/fake-router.js';
import { planCombos, applyPlanSafe, type ComboRule, type ComboDefinition, type ModelInfo } from '@routersync/core';

describe('Acceptance Test AT-8: Adopt Guard & Unmanaged Combo Safety (Condition B2 & I5)', () => {
  it('preserves unmanaged combo, prunes dead model in adopt guard, and updates managed combo', async () => {
    // 1. Initial State on Router: 3 combos
    // - Combo 1: Completely manual/unmanaged, not in adopt config
    const manualUntouched: ComboDefinition = {
      id: 'manual-my-custom',
      name: 'Manual My Custom',
      strategy: 'round-robin',
      models: ['manual-model-x', 'dead/provider/zombie'],
      managed: false,
      minSteps: 1,
    };

    // - Combo 2: Manual combo adopted with mode: 'guard'
    const adoptedGuarded: ComboDefinition = {
      id: 'adopted-legacy-pipeline',
      name: 'Adopted Legacy Pipeline',
      strategy: 'priority',
      models: ['provider-a/model-1', 'dead/provider/zombie', 'provider-b/model-2'],
      managed: false,
      minSteps: 1,
    };

    // - Combo 3: Managed combo created and owned by RouterSync
    const managedCombo: ComboDefinition = {
      id: 'rs-coder',
      name: 'RS Coder',
      strategy: 'priority',
      models: ['provider-a/model-1'],
      managed: true,
      minSteps: 1,
    };

    const router = new FakeRouter({
      name: 'router-adopt-test',
      initialCombos: [manualUntouched, adoptedGuarded, managedCombo],
    });

    // 2. Provider Catalog:
    // Notice: 'dead/provider/zombie' is marked as 'dead'
    const catalog: ModelInfo[] = [
      { id: 'provider-a/model-1', provider: 'provider-a', status: 'active' },
      { id: 'provider-b/model-2', provider: 'provider-b', status: 'active' },
      { id: 'provider-c/model-3', provider: 'provider-c', status: 'active' },
      { id: 'dead/provider/zombie', provider: 'dead-provider', status: 'dead' },
    ];

    // 3. Rules: only defines 'rs-coder' (no rules define manual-my-custom or adopted-legacy-pipeline)
    const rules: ComboRule[] = [
      {
        comboId: 'rs-coder',
        name: 'RS Coder',
        strategy: 'priority',
        minSteps: 2,
        freeOnly: false,
        requiredCapabilities: [],
        excludedModels: [],
        pinnedModels: ['provider-a/model-1', 'provider-c/model-3'],
        maxSteps: 3,
      },
    ];

    // 4. Generate plan with adopt guard for 'adopted-legacy-pipeline'
    const plan = planCombos(
      await router.readCombos(),
      catalog,
      rules,
      {
        target: 'router-adopt-test',
        adopt: [{ name: 'adopted-legacy-pipeline', mode: 'guard' }],
      }
    );

    // 5. Verify Plan properties before applying:
    // 5.1 manualUntouched must NOT appear anywhere in the plan
    expect(plan.additions.some((a) => a.id === manualUntouched.id)).toBe(false);
    expect(plan.modifications.some((m) => m.id === manualUntouched.id)).toBe(false);
    expect(plan.deletions).not.toContain(manualUntouched.id);

    // 5.2 adoptedGuarded must be modified to prune dead model while preserving order
    const adoptedMod = plan.modifications.find((m) => m.id === adoptedGuarded.id);
    expect(adoptedMod).toBeDefined();
    // Dead model 'dead/provider/zombie' is pruned
    expect(adoptedMod?.models).toEqual(['provider-a/model-1', 'provider-b/model-2']);
    // No foreign models (like model-3) were added
    expect(adoptedMod?.models).not.toContain('provider-c/model-3');
    // Not deleted
    expect(plan.deletions).not.toContain(adoptedGuarded.id);

    // 5.3 managedCombo is updated with rules
    const managedMod = plan.modifications.find((m) => m.id === managedCombo.id);
    expect(managedMod).toBeDefined();
    expect(managedMod?.models).toContain('provider-c/model-3');

    // 6. Apply Plan to router
    const applyResult = await applyPlanSafe(router, plan, { dryRun: false });
    expect(applyResult.success).toBe(true);
    expect(applyResult.readBackVerified).toBe(true);

    // 7. Verify final database state:
    const finalCombos = await router.readCombos();
    const finalMap = new Map(finalCombos.map((c) => [c.id, c]));

    // 7.1 Unmanaged combo is 100% intact with original models
    const finalUntouched = finalMap.get(manualUntouched.id);
    expect(finalUntouched).toBeDefined();
    expect(finalUntouched?.models).toEqual(manualUntouched.models);

    // 7.2 Adopted guarded combo has dead model pruned in exact manual order
    const finalAdopted = finalMap.get(adoptedGuarded.id);
    expect(finalAdopted).toBeDefined();
    expect(finalAdopted?.models).toEqual(['provider-a/model-1', 'provider-b/model-2']);

    // 7.3 Managed combo has updated models
    const finalManaged = finalMap.get(managedCombo.id);
    expect(finalManaged).toBeDefined();
    expect(finalManaged?.models).toContain('provider-c/model-3');
  });
});
