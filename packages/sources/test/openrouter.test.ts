/**
 * packages/sources/test/openrouter.test.ts
 */

import { describe, it, expect } from 'vitest';
import { OpenRouterCatalogSource } from '../src/openrouter.js';

describe('OpenRouterCatalogSource', () => {
  const sampleOpenRouterResponse = {
    data: [
      {
        id: 'anthropic/claude-3-5-sonnet',
        name: 'Anthropic: Claude 3.5 Sonnet',
        context_length: 200000,
        pricing: {
          prompt: '0.000003',
          completion: '0.000015',
        },
        architecture: {
          modality: 'text+image->text',
          tokenizer: 'Claude',
        },
      },
      {
        id: 'meta-llama/llama-3.1-8b-instruct:free',
        name: 'Meta: Llama 3.1 8B Instruct (free)',
        context_length: 131072,
        pricing: {
          prompt: '0',
          completion: '0',
        },
        architecture: {
          modality: 'text->text',
        },
      },
    ],
  };

  it('parses models and extracts capabilities, pricing, and modalities', async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify(sampleOpenRouterResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const source = new OpenRouterCatalogSource({
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const models = await source.fetchCatalog();
    expect(models).toHaveLength(2);

    const sonnet = models.find((m) => m.id === 'anthropic/claude-3-5-sonnet');
    expect(sonnet).toBeDefined();
    expect(sonnet?.contextLength).toBe(200000);
    expect(sonnet?.pricing?.promptCostPerToken).toBe(0.000003);
    expect(sonnet?.pricing?.completionCostPerToken).toBe(0.000015);
    expect(sonnet?.capabilities?.vision).toBe(true);

    const llama = models.find((m) => m.id === 'meta-llama/llama-3.1-8b-instruct:free');
    expect(llama).toBeDefined();
    expect(llama?.pricing?.promptCostPerToken).toBe(0);
    expect(llama?.capabilities?.vision).toBe(false);
  });

  it('throws helpful error on network failure', async () => {
    const mockFetch = async () =>
      new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' });

    const source = new OpenRouterCatalogSource({
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(source.fetchCatalog()).rejects.toThrow('HTTP 503');
  });
});
