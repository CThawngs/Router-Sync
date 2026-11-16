/**
 * packages/sources/test/litellm.test.ts
 */

import { describe, it, expect } from 'vitest';
import { LiteLLMCatalogSource } from '../src/litellm.js';

describe('LiteLLMCatalogSource', () => {
  const sampleLiteLLMDict = {
    sample_spec: {
      version: '1.0',
    },
    'gpt-4o': {
      max_tokens: 128000,
      max_input_tokens: 128000,
      max_output_tokens: 4096,
      input_cost_per_token: 0.000005,
      output_cost_per_token: 0.000015,
      litellm_provider: 'openai',
      mode: 'chat',
      supports_function_calling: true,
      supports_vision: true,
    },
    'deepseek/deepseek-chat': {
      max_tokens: 65536,
      max_input_tokens: 65536,
      max_output_tokens: 8192,
      input_cost_per_token: 0.00000014,
      output_cost_per_token: 0.00000028,
      litellm_provider: 'deepseek',
      mode: 'chat',
      supports_function_calling: true,
      supports_vision: false,
    },
  };

  it('parses catalog dictionary and ignores sample_ headers', async () => {
    const source = new LiteLLMCatalogSource({
      data: sampleLiteLLMDict,
    });

    const models = await source.fetchCatalog();
    expect(models).toHaveLength(2);

    const gpt4o = models.find((m) => m.id === 'gpt-4o');
    expect(gpt4o).toBeDefined();
    expect(gpt4o?.provider).toBe('openai');
    expect(gpt4o?.contextLength).toBe(128000);
    expect(gpt4o?.pricing?.promptCostPerToken).toBe(0.000005);
    expect(gpt4o?.capabilities?.vision).toBe(true);
    expect(gpt4o?.capabilities?.functionCalling).toBe(true);

    const deepseek = models.find((m) => m.id === 'deepseek/deepseek-chat');
    expect(deepseek).toBeDefined();
    expect(deepseek?.provider).toBe('deepseek');
    expect(deepseek?.capabilities?.vision).toBe(false);
  });
});
