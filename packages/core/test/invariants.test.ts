/**
 * packages/core/test/invariants.test.ts
 */

import { describe, it, expect } from 'vitest';
import { validateInvariants } from '../src/domain/invariants.js';
import type { ComboDefinition, ModelInfo, Plan } from '../src/domain/schema.js';

describe('Invariants I1–I8 Pure Validator', () => {
  const baseCatalog: ModelInfo[] = [
    {
      id: 'deepseek/deepseek-chat',
      provider: 'deepseek',
      status: 'active',
      pricing: { promptCostPerToken: 0.00000014, completionCostPerToken: 0.00000028 },
    },
    {
      id: 'openai/gpt-4o-mini',
      provider: 'openai',
      status: 'active',
      pricing: { promptCostPerToken: 0.00000015, completionCostPerToken: 0.0000006 },
    },
    {
      id: 'meta/llama-3-8b-instruct:free',
      provider: 'openrouter',
      status: 'active',
      pricing: { promptCostPerToken: 0, completionCostPerToken: 0 },
    },
    {
      id: 'google/gemini-2.0-flash-exp:free',
      provider: 'google',
      status: 'active',
      pricing: { promptCostPerToken: 0, completionCostPerToken: 0 },
    },
    {
      id: 'dead-provider/old-model',
      provider: 'dead-provider',
      status: 'dead',
    },
  ];

  it('passes on a valid configuration', () => {
    const combos: ComboDefinition[] = [
      {
        id: 'coding-combo',
        name: 'Coding Combo',
        strategy: 'priority',
        models: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini'],
        managed: true,
        minSteps: 2,
        freeOnly: false,
      },
    ];

    const result = validateInvariants({ combos, catalog: baseCatalog });
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('I1: catches non-existent model in managed combo', () => {
    const combos: ComboDefinition[] = [
      {
        id: 'bad-combo',
        name: 'Bad Combo',
        strategy: 'priority',
        models: ['deepseek/deepseek-chat', 'non-existent/ghost-model'],
        managed: true,
        minSteps: 2,
        freeOnly: false,
      },
    ];

    const result = validateInvariants({ combos, catalog: baseCatalog });
    expect(result.valid).toBe(false);
    const i1 = result.violations.find((v) => v.code === 'I1');
    expect(i1).toBeDefined();
    expect(i1?.message).toContain('ghost-model');
  });

  it('I2: catches quarantined/dead model when healthy candidates exist', () => {
    const combos: ComboDefinition[] = [
      {
        id: 'zombie-combo',
        name: 'Zombie Combo',
        strategy: 'priority',
        models: ['deepseek/deepseek-chat', 'dead-provider/old-model'],
        managed: true,
        minSteps: 2,
        freeOnly: false,
      },
    ];

    const result = validateInvariants({ combos, catalog: baseCatalog });
    expect(result.valid).toBe(false);
    const i2 = result.violations.find((v) => v.code === 'I2');
    expect(i2).toBeDefined();
    expect(i2?.message).toContain('dead');
  });

  it('I3: catches combo with fewer models than minSteps', () => {
    const combos: ComboDefinition[] = [
      {
        id: 'fragile-combo',
        name: 'Fragile Combo',
        strategy: 'priority',
        models: ['deepseek/deepseek-chat'],
        managed: true,
        minSteps: 2,
        freeOnly: false,
      },
    ];

    const result = validateInvariants({ combos, catalog: baseCatalog });
    expect(result.valid).toBe(false);
    const i3 = result.violations.find((v) => v.code === 'I3');
    expect(i3).toBeDefined();
    expect(i3?.message).toContain('less than minSteps');
  });

  it('I5: catches plan modifying or deleting unmanaged combos', () => {
    const currentCombos: ComboDefinition[] = [
      {
        id: 'user-custom-combo',
        name: 'User Custom Combo',
        strategy: 'priority',
        models: ['deepseek/deepseek-chat'],
        managed: false, // unmanaged
      },
    ];

    const plan: Plan = {
      id: 'plan_test',
      target: 'router',
      timestamp: new Date().toISOString(),
      additions: [],
      modifications: [
        {
          id: 'user-custom-combo',
          name: 'Modified Unmanaged',
          strategy: 'priority',
          models: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini'],
          managed: false,
        },
      ],
      deletions: [],
      reasons: {},
    };

    const result = validateInvariants({
      combos: currentCombos,
      catalog: baseCatalog,
      unmanagedCombos: currentCombos,
      plan,
    });

    expect(result.valid).toBe(false);
    const i5 = result.violations.find((v) => v.code === 'I5');
    expect(i5).toBeDefined();
    expect(i5?.message).toContain('unmanaged combo');
  });

  it('I6: catches metered or unknown pricing models in freeOnly combo', () => {
    const combos: ComboDefinition[] = [
      {
        id: 'fake-free-combo',
        name: 'Fake Free Combo',
        strategy: 'priority',
        models: ['meta/llama-3-8b-instruct:free', 'deepseek/deepseek-chat'], // deepseek is metered
        managed: true,
        minSteps: 2,
        freeOnly: true,
      },
    ];

    const result = validateInvariants({ combos, catalog: baseCatalog });
    expect(result.valid).toBe(false);
    const i6 = result.violations.find((v) => v.code === 'I6');
    expect(i6).toBeDefined();
    expect(i6?.message).toContain('metered model');
  });

  it('I7: warns if combo has models from only 1 provider', () => {
    const singleProviderCatalog: ModelInfo[] = [
      { id: 'openai/gpt-4o', provider: 'openai', status: 'active' },
      { id: 'openai/gpt-4o-mini', provider: 'openai', status: 'active' },
    ];

    const combos: ComboDefinition[] = [
      {
        id: 'single-provider-combo',
        name: 'Single Provider',
        strategy: 'priority',
        models: ['openai/gpt-4o', 'openai/gpt-4o-mini'],
        managed: true,
        minSteps: 2,
        freeOnly: false,
      },
    ];

    const result = validateInvariants({ combos, catalog: singleProviderCatalog });
    // I7 is a warning, so valid is still true
    expect(result.valid).toBe(true);
    const i7 = result.violations.find((v) => v.code === 'I7');
    expect(i7).toBeDefined();
    expect(i7?.severity).toBe('warning');
  });

  it('I8: catches out-of-order write sequence', () => {
    // Correct sequence: providers -> models -> combos -> defaultSlots
    const invalidSequence = ['combos', 'models', 'providers'];

    const result = validateInvariants({
      combos: [],
      catalog: [],
      writeSequence: invalidSequence,
    });

    expect(result.valid).toBe(false);
    const i8 = result.violations.find((v) => v.code === 'I8');
    expect(i8).toBeDefined();
    expect(i8?.message).toContain('dependency order I8');
  });
});
