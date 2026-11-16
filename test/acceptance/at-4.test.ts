/**
 * test/acceptance/at-4.test.ts
 *
 * Acceptance Test AT-4: Multi-Router Parallel Apply and Partial Failure Independence (Condition B1).
 *
 * Spec:
 *  - Apply across two independent routers executes in parallel.
 *  - When one router fails, the other router is NOT affected and completes its update.
 *  - The overall execution report explicitly reports PARTIAL status.
 *  - The successful router is NEVER rolled back when a peer router fails.
 */

import { describe, it, expect } from 'vitest';
import { FakeRouter } from '../harness/fake-router.js';
import { applyMultiRouterSafe, type Plan, type ComboDefinition } from '@routersync/core';

describe('Acceptance Test AT-4: Multi-Router Parallel Apply & Partial Failure (Condition B1)', () => {
  it('updates Router A while Router B fails, reporting PARTIAL without rolling back Router A', async () => {
    // 1. Setup initial state for Router A and Router B
    const initialComboA: ComboDefinition = {
      id: 'combo-a',
      name: 'Combo A',
      strategy: 'priority',
      models: ['provider-a/model-1'],
      managed: true,
      minSteps: 1,
    };

    const initialComboB: ComboDefinition = {
      id: 'combo-b',
      name: 'Combo B',
      strategy: 'priority',
      models: ['provider-b/model-1'],
      managed: true,
      minSteps: 1,
    };

    const routerA = new FakeRouter({
      name: 'router-omni-live',
      initialCombos: [initialComboA],
    });

    const routerB = new FakeRouter({
      name: 'router-9router-locked',
      initialCombos: [initialComboB],
    });

    // Make router B fail during write (e.g. simulate SQLite busy lock or disk failure)
    routerB.applyPlan = async (plan: Plan) => {
      return {
        success: false,
        target: routerB.name,
        appliedAt: new Date().toISOString(),
        planId: plan.id,
        readBackVerified: false,
        staleDetected: false,
        error: 'SQLite lock contention: database is locked (busy_timeout exceeded)',
      };
    };

    // 2. Prepare distinct plans for both routers
    const updatedComboA: ComboDefinition = {
      ...initialComboA,
      models: ['provider-a/model-1', 'provider-a/model-2'],
    };

    const planA: Plan = {
      id: 'plan_router_a_1001',
      target: 'router-omni-live',
      timestamp: new Date().toISOString(),
      additions: [],
      modifications: [updatedComboA],
      deletions: [],
      reasons: { 'combo-a': 'Add new active model provider-a/model-2' },
    };

    const updatedComboB: ComboDefinition = {
      ...initialComboB,
      models: ['provider-b/model-1', 'provider-b/model-2'],
    };

    const planB: Plan = {
      id: 'plan_router_b_1002',
      target: 'router-9router-locked',
      timestamp: new Date().toISOString(),
      additions: [],
      modifications: [updatedComboB],
      deletions: [],
      reasons: { 'combo-b': 'Add new active model provider-b/model-2' },
    };

    // 3. Execute parallel apply across both independent routers
    const multiResult = await applyMultiRouterSafe(
      [
        { adapter: routerA, plan: planA },
        { adapter: routerB, plan: planB },
      ],
      { dryRun: false }
    );

    // 4. Verification:
    // 4.1 Overall status must be strictly PARTIAL
    expect(multiResult.status).toBe('PARTIAL');
    expect(multiResult.mode).toBe('live-write');
    expect(multiResult.results).toHaveLength(2);

    // 4.2 Router A succeeded and read-back verified
    const resultA = multiResult.results.find((r) => r.target === 'router-omni-live');
    expect(resultA).toBeDefined();
    expect(resultA?.success).toBe(true);
    expect(resultA?.readBackVerified).toBe(true);
    expect(resultA?.error).toBeUndefined();

    // 4.3 Router A has the new model, and was NOT rolled back
    const currentCombosA = await routerA.readCombos();
    expect(currentCombosA[0]?.models).toEqual(['provider-a/model-1', 'provider-a/model-2']);
    expect(routerA.rollbackCount).toBe(0);

    // 4.4 Router B failed with detailed error
    const resultB = multiResult.results.find((r) => r.target === 'router-9router-locked');
    expect(resultB).toBeDefined();
    expect(resultB?.success).toBe(false);
    expect(resultB?.readBackVerified).toBe(false);
    expect(resultB?.error).toContain('SQLite lock contention');

    // 4.5 Router B retains its original state
    const currentCombosB = await routerB.readCombos();
    expect(currentCombosB[0]?.models).toEqual(['provider-b/model-1']);
  });

  it('reports SUCCESS when all independent routers succeed', async () => {
    const routerA = new FakeRouter({ name: 'router-a' });
    const routerB = new FakeRouter({ name: 'router-b' });

    const planA: Plan = {
      id: 'plan_a',
      target: 'router-a',
      timestamp: new Date().toISOString(),
      additions: [],
      modifications: [],
      deletions: [],
      reasons: {},
    };
    const planB: Plan = {
      id: 'plan_b',
      target: 'router-b',
      timestamp: new Date().toISOString(),
      additions: [],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const multiResult = await applyMultiRouterSafe(
      [
        { adapter: routerA, plan: planA },
        { adapter: routerB, plan: planB },
      ],
      { dryRun: false }
    );

    expect(multiResult.status).toBe('SUCCESS');
    expect(multiResult.results.every((r) => r.success)).toBe(true);
  });

  it('reports FAILED when all routers fail', async () => {
    const routerA = new FakeRouter({ name: 'router-a' });
    const routerB = new FakeRouter({ name: 'router-b' });

    routerA.applyPlan = async (plan: Plan) => ({
      success: false,
      target: 'router-a',
      appliedAt: new Date().toISOString(),
      planId: plan.id,
      readBackVerified: false,
      staleDetected: false,
      error: 'Router A error',
    });

    routerB.applyPlan = async (plan: Plan) => ({
      success: false,
      target: 'router-b',
      appliedAt: new Date().toISOString(),
      planId: plan.id,
      readBackVerified: false,
      staleDetected: false,
      error: 'Router B error',
    });

    const plan: Plan = {
      id: 'plan_1',
      target: 'test',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'test-combo',
          name: 'Test Combo',
          strategy: 'priority',
          models: ['m1'],
          managed: true,
          minSteps: 1,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const multiResult = await applyMultiRouterSafe(
      [
        { adapter: routerA, plan },
        { adapter: routerB, plan },
      ],
      { dryRun: false }
    );

    expect(multiResult.status).toBe('FAILED');
    expect(multiResult.results.every((r) => !r.success)).toBe(true);
  });
});
