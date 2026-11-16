/**
 * test/acceptance/at-5.test.ts
 * 
 * Acceptance Test AT-5: Idempotency (Invariant I4).
 * 
 * Spec §8.1: Applying the synchronization cycle twice in succession
 * produces zero subsequent changes (Plan has 0 additions, modifications, or deletions).
 */

import { describe, it, expect } from 'vitest';
import { FakeRouter } from '../harness/fake-router.js';
import { planCombos, applyPlanSafe } from '@routersync/core';
import type { ComboRule } from '@routersync/core';
import type { ModelInfo } from '@routersync/adapter-sdk';

describe('Acceptance Test AT-5: Idempotency (I4)', () => {
  it('applying synchronization twice produces no changes on second pass', async () => {
    const catalog: ModelInfo[] = [
      { id: 'deepseek/deepseek-chat', provider: 'deepseek', status: 'active' },
      { id: 'openai/gpt-4o-mini', provider: 'openai', status: 'active' },
      { id: 'anthropic/claude-3-5-haiku', provider: 'anthropic', status: 'active' },
    ];

    const rules: ComboRule[] = [
      {
        comboId: 'idempotent-combo',
        name: 'Idempotent Combo',
        strategy: 'priority',
        minSteps: 2,
        freeOnly: false,
        requiredCapabilities: [],
        excludedModels: [],
        pinnedModels: ['deepseek/deepseek-chat'],
        maxSteps: 2,
      },
    ];

    const router = new FakeRouter({ initialCombos: [], catalog });

    // --- First Sync Cycle ---
    const current1 = await router.readCombos();
    const plan1 = planCombos(current1, catalog, rules, { target: router.name });

    expect(plan1.additions).toHaveLength(1);
    expect(plan1.modifications).toHaveLength(0);
    expect(plan1.deletions).toHaveLength(0);

    const applyResult1 = await applyPlanSafe(router, plan1, { dryRun: false });
    expect(applyResult1.success).toBe(true);
    expect(router.writeCount).toBe(1);

    const combosAfterFirstSync = await router.readCombos();
    expect(combosAfterFirstSync).toHaveLength(1);

    // --- Second Sync Cycle (Immediately following first) ---
    const current2 = await router.readCombos();
    const plan2 = planCombos(current2, catalog, rules, { target: router.name });

    // Invariant I4: Second plan must have zero mutations
    expect(plan2.additions).toHaveLength(0);
    expect(plan2.modifications).toHaveLength(0);
    expect(plan2.deletions).toHaveLength(0);

    const applyResult2 = await applyPlanSafe(router, plan2, { dryRun: false });
    expect(applyResult2.success).toBe(true);
    // Write count should NOT increase for a no-op plan
    expect(router.writeCount).toBe(1);
  });
});
