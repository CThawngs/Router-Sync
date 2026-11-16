/**
 * packages/core/test/schema.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  ModelInfoSchema,
  ComboDefinitionSchema,
  PlanSchema,
  HealthStatusSchema,
} from '../src/domain/schema.js';

describe('Domain Schemas', () => {
  it('validates a correct ModelInfo', () => {
    const validModel = {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      provider: 'openai',
      contextLength: 128000,
      modalities: ['text', 'image'],
      pricing: {
        promptCostPerToken: 0.000005,
        completionCostPerToken: 0.000015,
      },
      capabilities: {
        functionCalling: true,
        vision: true,
      },
      status: 'active' as const,
    };

    const parsed = ModelInfoSchema.parse(validModel);
    expect(parsed.id).toBe('openai/gpt-4o');
    expect(parsed.provider).toBe('openai');
    expect(parsed.status).toBe('active');
  });

  it('rejects ModelInfo with negative pricing', () => {
    const invalidModel = {
      id: 'bad-model',
      provider: 'bad-provider',
      pricing: {
        promptCostPerToken: -0.01,
      },
    };

    expect(() => ModelInfoSchema.parse(invalidModel)).toThrow();
  });

  it('validates a correct ComboDefinition', () => {
    const combo = {
      id: 'fast-chat',
      name: 'Fast Chat',
      strategy: 'priority',
      models: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini'],
      managed: true,
      minSteps: 2,
      freeOnly: false,
    };

    const parsed = ComboDefinitionSchema.parse(combo);
    expect(parsed.id).toBe('fast-chat');
    expect(parsed.models).toHaveLength(2);
  });

  it('validates Plan schema', () => {
    const plan = {
      id: 'plan_123',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [],
      modifications: [],
      deletions: ['old-combo'],
      reasons: { 'old-combo': 'removed' },
    };

    const parsed = PlanSchema.parse(plan);
    expect(parsed.deletions).toContain('old-combo');
  });

  it('validates HealthStatus schema', () => {
    const health = {
      ok: true,
      status: 'ok' as const,
      latencyMs: 3.5,
      timestamp: new Date().toISOString(),
    };

    const parsed = HealthStatusSchema.parse(health);
    expect(parsed.ok).toBe(true);
  });
});
