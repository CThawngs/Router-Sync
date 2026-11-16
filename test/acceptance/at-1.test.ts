/**
 * test/acceptance/at-1.test.ts
 * 
 * Acceptance Test AT-1: Fake Model Elimination (Invariant I1).
 * 
 * Spec: When a router contains a combo referencing a model that no longer exists
 * in the provider catalog, the synchronization cycle eliminates the invalid model
 * and replaces it with healthy candidates while respecting Invariant I1.
 */

import { describe, it, expect } from 'vitest';
import { FakeRouter } from '../harness/fake-router.js';
import { planCombos, applyPlanSafe, validateInvariants } from '@routersync/core';
import type { ComboRule } from '@routersync/core';
import type { ComboDefinition, ModelInfo } from '@routersync/adapter-sdk';

describe('Acceptance Test AT-1: Fake Model Elimination (I1)', () => {
  it('eliminates non-existent models from managed combos and restores invariant I1', async () => {
    // 1. Initial State: router has a combo containing a fake model "fake-provider/ghost-model"
    const initialCombos: ComboDefinition[] = [
      {
        id: 'coding-combo',
        name: 'Coding Combo',
        strategy: 'priority',
        models: ['deepseek/deepseek-chat', 'fake-provider/ghost-model'],
        managed: true,
        minSteps: 2,
      },
    ];

    // 2. Real provider catalog (does NOT contain "fake-provider/ghost-model")
    const verifiedCatalog: ModelInfo[] = [
      {
        id: 'deepseek/deepseek-chat',
        name: 'DeepSeek Chat',
        provider: 'deepseek',
        status: 'active',
      },
      {
        id: 'openai/gpt-4o-mini',
        name: 'GPT-4o Mini',
        provider: 'openai',
        status: 'active',
      },
      {
        id: 'anthropic/claude-3-5-haiku',
        name: 'Claude 3.5 Haiku',
        provider: 'anthropic',
        status: 'active',
      },
    ];

    // Initial check: current combo violates I1
    const preValidation = validateInvariants({
      combos: initialCombos,
      catalog: verifiedCatalog,
    });
    expect(preValidation.valid).toBe(false);
    expect(preValidation.violations.some((v) => v.code === 'I1')).toBe(true);

    const router = new FakeRouter({
      initialCombos,
      catalog: verifiedCatalog,
    });

    // 3. Define Sync Rules
    const rules: ComboRule[] = [
      {
        comboId: 'coding-combo',
        name: 'Coding Combo',
        strategy: 'priority',
        minSteps: 2,
        freeOnly: false,
        requiredCapabilities: [],
        excludedModels: [],
        pinnedModels: ['deepseek/deepseek-chat'],
        maxSteps: 3,
      },
    ];

    // 4. Plan synchronization
    const currentCombos = await router.readCombos();
    const plan = planCombos(currentCombos, verifiedCatalog, rules, { target: router.name });

    // Plan should modify the combo to remove the fake model and include healthy models
    expect(plan.modifications).toHaveLength(1);
    const updatedCombo = plan.modifications[0]!;
    expect(updatedCombo.models).not.toContain('fake-provider/ghost-model');
    expect(updatedCombo.models).toContain('deepseek/deepseek-chat');
    expect(updatedCombo.models.length).toBeGreaterThanOrEqual(2);

    // 5. Apply plan safely
    const applyResult = await applyPlanSafe(router, plan, { dryRun: false });
    expect(applyResult.success).toBe(true);
    expect(applyResult.readBackVerified).toBe(true);

    // 6. Verification: read back combos from router
    const postCombos = await router.readCombos();
    const postValidation = validateInvariants({
      combos: postCombos,
      catalog: verifiedCatalog,
    });

    expect(postValidation.valid).toBe(true);
    expect(postCombos[0]?.models).not.toContain('fake-provider/ghost-model');
  });
});
