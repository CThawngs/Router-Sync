/**
 * packages/core/src/normalizer/index.ts
 * 
 * Normalization utilities for Model IDs, context lengths, pricing, and capabilities.
 */

import type { ModelCapabilities, ModelInfo, ModelPricing } from '../domain/schema.js';

/**
 * Normalizes model identifiers into canonical format and provider extraction.
 */
export function normalizeModelId(
  rawId: string,
  defaultProvider = 'unknown'
): { id: string; provider: string; modelName: string } {
  const trimmed = rawId.trim();
  const parts = trimmed.split('/');

  if (parts.length >= 2) {
    const provider = parts[0]!.toLowerCase();
    const modelName = parts.slice(1).join('/');
    return {
      id: trimmed,
      provider,
      modelName,
    };
  }

  return {
    id: trimmed,
    provider: defaultProvider.toLowerCase(),
    modelName: trimmed,
  };
}

/**
 * Normalizes context window length, parsing human suffixes like '128k' or strings.
 */
export function normalizeContextLength(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/);
    if (match) {
      const num = parseFloat(match[1]!);
      const unit = match[2];
      if (unit === 'k') {
        return Math.floor(num * 1024);
      }
      if (unit === 'm') {
        return Math.floor(num * 1024 * 1024);
      }
      return Math.floor(num);
    }
  }

  return undefined;
}

/**
 * Normalizes pricing to cost per single token.
 */
export function normalizePricing(raw: unknown): ModelPricing | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;

  const parseCost = (val: unknown, perMillion = false): number | undefined => {
    let num: number | undefined;
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
      num = val;
    } else if (typeof val === 'string') {
      const parsed = parseFloat(val);
      if (Number.isFinite(parsed) && parsed >= 0) {
        num = parsed;
      }
    }

    if (num !== undefined) {
      return perMillion ? num / 1_000_000 : num;
    }
    return undefined;
  };

  const prompt = parseCost(obj['promptCostPerToken'] ?? obj['prompt'] ?? obj['prompt_cost']);
  const completion = parseCost(obj['completionCostPerToken'] ?? obj['completion'] ?? obj['completion_cost']);
  const cacheRead = parseCost(obj['cacheReadCostPerToken'] ?? obj['cache_read']);
  const cacheWrite = parseCost(obj['cacheWriteCostPerToken'] ?? obj['cache_write']);

  if (prompt === undefined && completion === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined;
  }

  const result: ModelPricing = {};
  if (prompt !== undefined) result.promptCostPerToken = prompt;
  if (completion !== undefined) result.completionCostPerToken = completion;
  if (cacheRead !== undefined) result.cacheReadCostPerToken = cacheRead;
  if (cacheWrite !== undefined) result.cacheWriteCostPerToken = cacheWrite;

  return result;
}

/**
 * Normalizes model capability flags.
 */
export function normalizeCapabilities(raw: unknown): ModelCapabilities {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const obj = raw as Record<string, unknown>;
  const caps: ModelCapabilities = {};

  if (typeof obj['functionCalling'] === 'boolean') caps.functionCalling = obj['functionCalling'];
  else if (typeof obj['tools'] === 'boolean') caps.functionCalling = obj['tools'];
  else if (typeof obj['function_calling'] === 'boolean') caps.functionCalling = obj['function_calling'];

  if (typeof obj['vision'] === 'boolean') caps.vision = obj['vision'];
  else if (typeof obj['supports_vision'] === 'boolean') caps.vision = obj['supports_vision'];

  if (typeof obj['reasoning'] === 'boolean') caps.reasoning = obj['reasoning'];
  else if (typeof obj['supports_reasoning'] === 'boolean') caps.reasoning = obj['supports_reasoning'];

  if (typeof obj['streaming'] === 'boolean') caps.streaming = obj['streaming'];
  else if (typeof obj['supports_streaming'] === 'boolean') caps.streaming = obj['supports_streaming'];

  return caps;
}

/**
 * Normalizes raw model object into a valid ModelInfo entity.
 */
export function normalizeModelInfo(raw: Record<string, unknown>, providerFallback = 'unknown'): ModelInfo {
  const rawId = String(raw['id'] ?? raw['name'] ?? '');
  const { id, provider, modelName } = normalizeModelId(rawId, String(raw['provider'] ?? providerFallback));

  const model: ModelInfo = {
    id,
    name: String(raw['name'] ?? modelName),
    provider,
    status: (raw['status'] as 'active' | 'quarantined' | 'dead') ?? 'active',
  };

  const contextLength = normalizeContextLength(raw['contextLength'] ?? raw['context_length'] ?? raw['context_window']);
  if (contextLength !== undefined) {
    model.contextLength = contextLength;
  }

  const pricing = normalizePricing(raw['pricing'] ?? raw);
  if (pricing) {
    model.pricing = pricing;
  }

  const caps = normalizeCapabilities(raw['capabilities'] ?? raw);
  if (Object.keys(caps).length > 0) {
    model.capabilities = caps;
  }

  if (Array.isArray(raw['modalities'])) {
    model.modalities = raw['modalities'].map(String);
  }

  return model;
}
