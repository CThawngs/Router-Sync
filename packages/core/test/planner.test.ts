/**
 * packages/core/test/planner.test.ts
 */

import { describe, it, expect } from 'vitest';
import { planCombos } from '../src/planner/index.js';
import type { ComboDefinition, ComboRule, ModelInfo } from '../src/domain/schema.js';

describe('Planner Module', () => {
  const catalog: ModelInfo[] = [
    {
      id: 'deepseek/deepseek-chat',
      name: 'DeepSeek Chat',
      provider: 'deepseek',
      status: 'active',
      capabilities: { functionCalling: true, streaming: true },
      pricing: { promptCostPerToken: 0.00000014, completionCostPerToken: 0.00000028 },
    },
    {
      id: 'openai/gpt-4o-mini',
      name: 'GPT-4o Mini',
      provider: 'openai',
      status: 'active',
      capabilities: { functionCalling: true, vision: true, streaming: true },
      pricing: { promptCostPerToken: 0.00000015, completionCostPerToken: 0.0000006 },
    },
    {
      id: 'meta/llama-3-8b-instruct:free',
      name: 'Llama 3 8B Free',
      provider: 'openrouter',
      status: 'active',
      pricing: { promptCostPerToken: 0, completionCostPerToken: 0 },
    },
    {
      id: 'google/gemini-2.0-flash-exp:free',
      name: 'Gemini 2.0 Flash Free',
      provider: 'google',
      status: 'active',
      pricing: { promptCostPerToken: 0, completionCostPerToken: 0 },
    },
    {
      id: 'dead/model',
      name: 'Dead Model',
      provider: 'dead-provider',
      status: 'dead',
    },
  ];

  it('generates additions for a new combo', () => {
    const rules: ComboRule[] = [
      {
        comboId: 'general-chat',
        name: 'General Chat',
        strategy: 'priority',
        minSteps: 2,
        freeOnly: false,
        requiredCapabilities: [],
        excludedModels: [],
        pinnedModels: ['deepseek/deepseek-chat'],
        maxSteps: 3,
      },
    ];

    const plan = planCombos([], catalog, rules);
    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0]?.id).toBe('general-chat');
    expect(plan.additions[0]?.models).toContain('deepseek/deepseek-chat');
    expect(plan.modifications).toHaveLength(0);
    expect(plan.deletions).toHaveLength(0);
  });

  it('proves idempotency I4: plan produces zero changes when state is already in sync', () => {
    const rules: ComboRule[] = [
      {
        comboId: 'general-chat',
        name: 'General Chat',
        strategy: 'priority',
        minSteps: 2,
        freeOnly: false,
        requiredCapabilities: [],
        excludedModels: [],
        pinnedModels: ['deepseek/deepseek-chat'],
        maxSteps: 2,
      },
    ];

    // First planning run
    const plan1 = planCombos([], catalog, rules);
    expect(plan1.additions).toHaveLength(1);

    // Simulate applied state
    const currentCombos: ComboDefinition[] = [...plan1.additions];

    // Second planning run against the applied state
    const plan2 = planCombos(currentCombos, catalog, rules);
    expect(plan2.additions).toHaveLength(0);
    expect(plan2.modifications).toHaveLength(0);
    expect(plan2.deletions).toHaveLength(0);
  });

  it('preserves unmanaged combos I5 without proposing modifications or deletions', () => {
    const unmanagedCombo: ComboDefinition = {
      id: 'my-custom-unmanaged',
      name: 'My Custom Unmanaged',
      strategy: 'roundrobin',
      models: ['openai/gpt-4o-mini'],
      managed: false,
    };

    const rules: ComboRule[] = [
      {
        comboId: 'new-managed',
        name: 'New Managed',
        strategy: 'priority',
        minSteps: 2,
        freeOnly: false,
        requiredCapabilities: [],
        excludedModels: [],
        pinnedModels: [],
        maxSteps: 2,
      },
    ];

    const plan = planCombos([unmanagedCombo], catalog, rules);
    expect(plan.deletions).not.toContain('my-custom-unmanaged');
    expect(plan.modifications.some((m) => m.id === 'my-custom-unmanaged')).toBe(false);
  });

  it('respects I3: preserves existing combo if candidate count drops below minSteps', () => {
    const existingCombo: ComboDefinition = {
      id: 'strict-combo',
      name: 'Strict Combo',
      strategy: 'priority',
      models: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini'],
      managed: true,
      minSteps: 2,
    };

    // Rule requires 3 models, but only 1 candidate matches
    const rules: ComboRule[] = [
      {
        comboId: 'strict-combo',
        name: 'Strict Combo',
        strategy: 'priority',
        minSteps: 3,
        freeOnly: false,
        requiredCapabilities: [],
        allowedProviders: ['deepseek'], // only 1 candidate in catalog
        excludedModels: [],
        pinnedModels: [],
        maxSteps: 3,
      },
    ];

    const plan = planCombos([existingCombo], catalog, rules);
    expect(plan.modifications).toHaveLength(0);
    expect(plan.deletions).toHaveLength(0);
    expect(plan.reasons['strict-combo']).toContain('PRESERVED_CURRENT');
  });

  it('filters models for freeOnly rule (I6)', () => {
    const rules: ComboRule[] = [
      {
        comboId: 'free-tier',
        name: 'Free Tier',
        strategy: 'priority',
        minSteps: 2,
        freeOnly: true,
        requiredCapabilities: [],
        excludedModels: [],
        pinnedModels: [],
        maxSteps: 5,
      },
    ];

    const plan = planCombos([], catalog, rules);
    expect(plan.additions).toHaveLength(1);
    const freeModels = plan.additions[0]?.models ?? [];
    expect(freeModels).toContain('meta/llama-3-8b-instruct:free');
    expect(freeModels).toContain('google/gemini-2.0-flash-exp:free');
    expect(freeModels).not.toContain('deepseek/deepseek-chat');
  });

  it('holds I6 violation per-step instead of throwing (F1)', () => {
    const rules: ComboRule[] = [
      {
        comboId: 'free-pinned-mix',
        name: 'Free Pinned Mix',
        strategy: 'priority',
        minSteps: 2,
        freeOnly: true,
        requiredCapabilities: [],
        excludedModels: [],
        pinnedModels: ['deepseek/deepseek-chat'],
        maxSteps: 5,
      },
    ];

    const plan = planCombos([], catalog, rules);
    expect(plan.additions).toHaveLength(0);
    expect(plan.reasons['free-pinned-mix']).toContain('BLOCKED HOLD I6');
    expect(plan.reasons['__tally__']).toContain('BLOCKED HOLD: 1 combo(s)');
  });

  it('prunes dead models in adopt guard mode while preserving manual model order (AT-8)', () => {
    const manualCombo: ComboDefinition = {
      id: 'my-manual-combo',
      name: 'My Manual Combo',
      strategy: 'roundrobin',
      models: ['openai/gpt-4o-mini', 'dead/model', 'deepseek/deepseek-chat'],
      managed: false,
      minSteps: 1,
    };

    // No rules for my-manual-combo, but configured in adopt with mode: 'guard'
    const plan = planCombos([manualCombo], catalog, [], {
      adopt: [{ name: 'my-manual-combo', mode: 'guard' }],
    });

    expect(plan.deletions).toHaveLength(0);
    expect(plan.additions).toHaveLength(0);
    expect(plan.modifications).toHaveLength(1);

    const mod = plan.modifications[0]!;
    expect(mod.id).toBe('my-manual-combo');
    // Order strictly preserved: gpt-4o-mini then deepseek-chat (dead/model pruned)
    expect(mod.models).toEqual(['openai/gpt-4o-mini', 'deepseek/deepseek-chat']);
    expect(plan.reasons['my-manual-combo']).toContain('ADOPT_GUARD: pruned 1 dead model(s)');
  });

  it('keeps adopt guard combo untouched when all its models are healthy', () => {
    const healthyManualCombo: ComboDefinition = {
      id: 'healthy-manual',
      name: 'Healthy Manual',
      strategy: 'priority',
      models: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini'],
      managed: false,
    };

    const plan = planCombos([healthyManualCombo], catalog, [], {
      adopt: [{ name: 'healthy-manual', mode: 'guard' }],
    });

    expect(plan.additions).toHaveLength(0);
    expect(plan.modifications).toHaveLength(0);
    expect(plan.deletions).toHaveLength(0);
  });
});
