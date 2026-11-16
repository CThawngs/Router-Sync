/**
 * packages/core/test/applier.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { applyPlanSafe } from '../src/applier/index.js';
import type { RouterAdapter, ComboDefinition, Plan, Snapshot, HealthStatus, ApplyResult } from '@routersync/adapter-sdk';

describe('Safe Write Protocol (Applier)', () => {
  const initialCombos: ComboDefinition[] = [
    {
      id: 'combo-1',
      name: 'Combo 1',
      strategy: 'priority',
      models: ['model-a', 'model-b'],
      managed: true,
      minSteps: 2,
    },
  ];

  function createMockAdapter(options: {
    combos?: ComboDefinition[];
    staleOnReadBack?: boolean;
    writeFails?: boolean;
  }): { adapter: RouterAdapter; state: { combos: ComboDefinition[]; snapshots: Snapshot[]; rollbackCalled: boolean } } {
    const state = {
      combos: options.combos ? JSON.parse(JSON.stringify(options.combos)) : [],
      snapshots: [] as Snapshot[],
      rollbackCalled: false,
    };

    const adapter: RouterAdapter = {
      name: 'mock-router',
      tier: 'T3',
      async checkHealth(): Promise<HealthStatus> {
        return { ok: true, status: 'ok', timestamp: new Date().toISOString() };
      },
      async readCatalog() {
        return [];
      },
      async readCombos(): Promise<ComboDefinition[]> {
        if (options.staleOnReadBack) {
          // Simulate STALE cache by returning old combos
          return JSON.parse(JSON.stringify(initialCombos));
        }
        return JSON.parse(JSON.stringify(state.combos));
      },
      async createSnapshot(): Promise<Snapshot> {
        const snap: Snapshot = {
          id: `snap_${Date.now()}`,
          target: 'mock-router',
          timestamp: new Date().toISOString(),
          combos: JSON.parse(JSON.stringify(state.combos)),
        };
        state.snapshots.push(snap);
        return snap;
      },
      async applyPlan(plan: Plan): Promise<ApplyResult> {
        if (options.writeFails) {
          return {
            success: false,
            target: 'mock-router',
            appliedAt: new Date().toISOString(),
            planId: plan.id,
            readBackVerified: false,
            staleDetected: false,
            error: 'Simulated DB lock write error',
          };
        }

        // Apply additions & modifications to internal state
        const comboMap = new Map(state.combos.map((c: ComboDefinition) => [c.id, c]));
        for (const add of plan.additions) {
          comboMap.set(add.id, add);
        }
        for (const mod of plan.modifications) {
          comboMap.set(mod.id, mod);
        }
        for (const del of plan.deletions) {
          comboMap.delete(del);
        }
        state.combos = Array.from(comboMap.values());

        return {
          success: true,
          target: 'mock-router',
          appliedAt: new Date().toISOString(),
          planId: plan.id,
          readBackVerified: true,
          staleDetected: false,
        };
      },
      async rollback(snapshot: Snapshot): Promise<boolean> {
        state.combos = JSON.parse(JSON.stringify(snapshot.combos));
        state.rollbackCalled = true;
        return true;
      },
    };

    return { adapter, state };
  }

  const samplePlan: Plan = {
    id: 'plan_apply_1',
    target: 'mock-router',
    timestamp: new Date().toISOString(),
    additions: [
      {
        id: 'new-combo',
        name: 'New Combo',
        strategy: 'priority',
        models: ['model-x', 'model-y'],
        managed: true,
        minSteps: 2,
      },
    ],
    modifications: [],
    deletions: [],
    reasons: {},
  };

  it('runs dry-run by default without touching adapter or writing', async () => {
    const { adapter, state } = createMockAdapter({ combos: initialCombos });
    const result = await applyPlanSafe(adapter, samplePlan); // default dryRun = true

    expect(result.success).toBe(true);
    expect(state.snapshots).toHaveLength(0);
    expect(state.combos).toHaveLength(1);
    expect(state.combos[0]?.id).toBe('combo-1');
  });

  it('performs safe apply with snapshot and read-back verification', async () => {
    const { adapter, state } = createMockAdapter({ combos: initialCombos });
    const result = await applyPlanSafe(adapter, samplePlan, { dryRun: false });

    expect(result.success).toBe(true);
    expect(result.readBackVerified).toBe(true);
    expect(result.staleDetected).toBe(false);
    expect(state.snapshots).toHaveLength(1);
    expect(state.combos).toHaveLength(2);
    expect(state.combos.some((c: ComboDefinition) => c.id === 'new-combo')).toBe(true);
  });

  it('detects STALE cache on read-back and triggers automatic rollback', async () => {
    const { adapter, state } = createMockAdapter({ combos: initialCombos, staleOnReadBack: true });
    const result = await applyPlanSafe(adapter, samplePlan, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.staleDetected).toBe(true);
    expect(result.rollbackExecuted).toBe(true);
    expect(state.rollbackCalled).toBe(true);
    expect(result.error).toContain('STALE cache detected');
  });

  it('blocks apply when approvalToken is invalid', async () => {
    const { adapter } = createMockAdapter({ combos: initialCombos });
    const result = await applyPlanSafe(adapter, samplePlan, {
      dryRun: false,
      expectedToken: 'valid-secret-token',
      approvalToken: 'wrong-token',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('approval token');
  });
});
