/**
 * test/acceptance/at-3.test.ts
 * 
 * Acceptance Test AT-3: Stale Cache Detection & Automatic Rollback.
 * 
 * Spec §5.2: When direct database write succeeds but gateway serves a stale cache
 * during read-back verification, RouterSync detects the desynchronization,
 * aborts the change, and automatically rolls back to the pre-apply snapshot.
 */

import { describe, it, expect } from 'vitest';
import { FakeRouter } from '../harness/fake-router.js';
import { applyPlanSafe } from '@routersync/core';
import type { ComboDefinition, Plan } from '@routersync/adapter-sdk';

describe('Acceptance Test AT-3: Stale Cache Detection & Rollback', () => {
  it('detects desynchronization during read-back and rolls back automatically', async () => {
    // 1. Initial router state
    const initialCombos: ComboDefinition[] = [
      {
        id: 'stable-combo',
        name: 'Stable Combo',
        strategy: 'priority',
        models: ['model-1', 'model-2'],
        managed: true,
        minSteps: 2,
      },
    ];

    // Setup router with staleCache enabled (simulating a gateway returning outdated cache)
    const router = new FakeRouter({
      initialCombos,
      staleCache: true,
    });

    // 2. Define a mutation plan
    const plan: Plan = {
      id: 'plan_mutate_combo',
      target: router.name,
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'new-active-combo',
          name: 'New Active Combo',
          strategy: 'weighted',
          models: ['model-3', 'model-4'],
          managed: true,
          minSteps: 2,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: { 'new-active-combo': 'Adding high throughput combo' },
    };

    // 3. Execute apply with Safe Write Protocol
    const result = await applyPlanSafe(router, plan, { dryRun: false });

    // 4. Assertions:
    // - Apply must fail due to read-back mismatch
    expect(result.success).toBe(false);
    // - Must flag stale cache
    expect(result.staleDetected).toBe(true);
    expect(result.readBackVerified).toBe(false);
    // - Must have executed automatic rollback
    expect(result.rollbackExecuted).toBe(true);
    expect(router.rollbackCount).toBe(1);
    expect(result.error).toContain('STALE cache detected');

    // 5. Verify router state after rollback is restored to initialCombos
    router.staleCache = false; // disable simulation to inspect underlying storage
    const currentStorage = await router.readCombos();
    expect(currentStorage).toHaveLength(1);
    expect(currentStorage[0]?.id).toBe('stable-combo');
  });
});
