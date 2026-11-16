/**
 * packages/sources/src/openrouter.ts
 * 
 * OpenRouter public models catalog source.
 * Conforms to zero-inference-token rule (GET /api/v1/models only).
 */

import type { CatalogSource, ModelInfo } from '@routersync/adapter-sdk';
import { normalizeModelInfo } from '@routersync/core';

export interface OpenRouterCatalogOptions {
  endpoint?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}

export class OpenRouterCatalogSource implements CatalogSource {
  readonly name = 'openrouter';
  private endpoint: string;
  private fetchFn: typeof fetch;

  constructor(options: OpenRouterCatalogOptions = {}) {
    this.endpoint = options.endpoint ?? 'https://openrouter.ai/api/v1/models';
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async fetchCatalog(): Promise<ModelInfo[]> {
    const res = await this.fetchFn(this.endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch OpenRouter catalog: HTTP ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as { data?: unknown[] };
    if (!json || !Array.isArray(json.data)) {
      throw new Error('Invalid OpenRouter catalog response: expected data array');
    }

    return json.data.map((item) => {
      const raw = item as Record<string, unknown>;
      const arch = (raw['architecture'] as Record<string, unknown>) ?? {};
      const modalityStr = String(arch['modality'] ?? '');
      const modalities = modalityStr ? modalityStr.split('->')[0]?.split('+') : undefined;

      return normalizeModelInfo(
        {
          id: raw['id'],
          name: raw['name'],
          context_length: raw['context_length'],
          pricing: raw['pricing'],
          modalities,
          supports_vision: modalityStr.includes('image'),
        },
        'openrouter'
      );
    });
  }
}
