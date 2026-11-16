/**
 * packages/sources/src/litellm.ts
 * 
 * LiteLLM static catalog reader.
 * Reads model definitions, pricing, context window from JSON dataset.
 */

import type { CatalogSource, ModelInfo } from '@routersync/adapter-sdk';
import { normalizeModelInfo } from '@routersync/core';
import * as fs from 'node:fs/promises';

export interface LiteLLMCatalogOptions {
  data?: Record<string, unknown> | undefined;
  filePath?: string | undefined;
  url?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}

export class LiteLLMCatalogSource implements CatalogSource {
  readonly name = 'litellm';
  private data: Record<string, unknown> | undefined;
  private filePath: string | undefined;
  private url: string | undefined;
  private fetchFn: typeof fetch;

  constructor(options: LiteLLMCatalogOptions = {}) {
    this.data = options.data;
    this.filePath = options.filePath;
    this.url = options.url;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async fetchCatalog(): Promise<ModelInfo[]> {
    let rawDict: Record<string, unknown>;

    if (this.data) {
      rawDict = this.data;
    } else if (this.filePath) {
      const content = await fs.readFile(this.filePath, 'utf-8');
      rawDict = JSON.parse(content) as Record<string, unknown>;
    } else if (this.url) {
      const res = await this.fetchFn(this.url, { method: 'GET' });
      if (!res.ok) {
        throw new Error(`Failed to fetch LiteLLM catalog: HTTP ${res.status}`);
      }
      rawDict = (await res.json()) as Record<string, unknown>;
    } else {
      throw new Error('LiteLLMCatalogSource requires either data, filePath, or url');
    }

    const models: ModelInfo[] = [];

    for (const [modelKey, rawVal] of Object.entries(rawDict)) {
      if (modelKey.startsWith('sample_')) continue;
      if (!rawVal || typeof rawVal !== 'object') continue;

      const obj = rawVal as Record<string, unknown>;
      const provider = String(obj['litellm_provider'] ?? 'unknown');
      const maxTokens = obj['max_input_tokens'] ?? obj['max_tokens'];

      const model = normalizeModelInfo(
        {
          id: modelKey,
          name: modelKey,
          provider,
          context_length: maxTokens,
          prompt_cost: obj['input_cost_per_token'],
          completion_cost: obj['output_cost_per_token'],
          cache_read: obj['cache_read_input_token_cost'],
          supports_vision: Boolean(obj['supports_vision']),
          function_calling: Boolean(obj['supports_function_calling']),
        },
        provider
      );

      models.push(model);
    }

    return models;
  }
}
