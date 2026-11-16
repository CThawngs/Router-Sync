/**
 * packages/core/test/normalizer.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeModelId,
  normalizeContextLength,
  normalizePricing,
  normalizeCapabilities,
  normalizeModelInfo,
} from '../src/normalizer/index.js';
import { ModelInfoSchema } from '../src/domain/schema.js';

describe('Normalizer Module', () => {
  it('normalizes model IDs with provider prefixes', () => {
    const res1 = normalizeModelId('openrouter/anthropic/claude-3-opus');
    expect(res1.provider).toBe('openrouter');
    expect(res1.modelName).toBe('anthropic/claude-3-opus');

    const res2 = normalizeModelId('deepseek-chat', 'deepseek');
    expect(res2.provider).toBe('deepseek');
    expect(res2.modelName).toBe('deepseek-chat');
  });

  it('normalizes context window length with suffixes', () => {
    expect(normalizeContextLength(128000)).toBe(128000);
    expect(normalizeContextLength('128k')).toBe(131072);
    expect(normalizeContextLength('32K')).toBe(32768);
    expect(normalizeContextLength('1m')).toBe(1048576);
    expect(normalizeContextLength('invalid')).toBeUndefined();
  });

  it('normalizes pricing rates', () => {
    const pricing = normalizePricing({
      prompt: 0.000001,
      completion: 0.000002,
    });
    expect(pricing?.promptCostPerToken).toBe(0.000001);
    expect(pricing?.completionCostPerToken).toBe(0.000002);

    expect(normalizePricing(null)).toBeUndefined();
  });

  it('normalizes capability flags across different naming conventions', () => {
    const caps = normalizeCapabilities({
      supports_vision: true,
      tools: true,
      supports_reasoning: true,
    });
    expect(caps.vision).toBe(true);
    expect(caps.functionCalling).toBe(true);
    expect(caps.reasoning).toBe(true);
  });

  it('normalizes full raw model object into valid ModelInfo entity', () => {
    const raw = {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      context_length: '128k',
      supports_vision: true,
      prompt_cost: 0.000005,
      completion_cost: 0.000015,
      modalities: ['text', 'image'],
    };

    const modelInfo = normalizeModelInfo(raw, 'openai');
    expect(modelInfo.id).toBe('openai/gpt-4o');
    expect(modelInfo.contextLength).toBe(131072);
    expect(modelInfo.capabilities?.vision).toBe(true);
    expect(modelInfo.pricing?.promptCostPerToken).toBe(0.000005);

    // Verify it passes strict schema validation
    const validated = ModelInfoSchema.parse(modelInfo);
    expect(validated.id).toBe('openai/gpt-4o');
  });
});
