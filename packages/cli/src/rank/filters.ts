/**
 * packages/cli/src/rank/filters.ts
 *
 * Deterministic gating filters:
 * 1. Blacklist check (space-bunny, union-alpha, minimax-m3.1, deepseek-v4-pro, etc.)
 * 2. Non-chat check (embeddings, tts, whisper, image generation, moderation, audio, guard)
 * 3. Price classification (FREE, PRICE_UNVERIFIED, PAID) with zero-payment-providers list
 * 4. Model catalog enrichment from %APPDATA%\9router\model-catalog.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PriceStatus } from './types.js';

export interface CatalogMetadata {
  vision?: boolean;
  videoInput?: boolean;
  audioInput?: boolean;
  pdf?: boolean;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
  };
  context_length?: number;
  [key: string]: unknown;
}

export const DEFAULT_ZERO_PAYMENT_PROVIDERS: readonly string[] = [
  'gemini',
  'groq',
  'nvidia',
  'oc',
  'opencode',
  'ocz',
  'cloudflare-ai',
  'cf',
  'hf',
  'cohere',
  'sambanova',
  'cerebras',
];

export const DEFAULT_NON_CHAT_PATTERNS: readonly string[] = [
  'embed',
  'text-embedding',
  'tts',
  'whisper',
  'dall-e',
  'flux',
  'sdxl',
  'midjourney',
  'stable-diffusion',
  'moderation',
  'clip',
  'rerank',
  'bge-',
  'guard',
  'safeguard',
  'prompt-guard',
  'transcribe',
];

export function extractProvider(fullId: string): { provider: string; modelName: string } {
  const trimmed = fullId.trim();
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx !== -1) {
    return {
      provider: trimmed.slice(0, slashIdx).toLowerCase(),
      modelName: trimmed.slice(slashIdx + 1),
    };
  }
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx !== -1) {
    return {
      provider: trimmed.slice(0, colonIdx).toLowerCase(),
      modelName: trimmed.slice(colonIdx + 1),
    };
  }
  return { provider: 'unknown', modelName: trimmed };
}

/**
 * Blacklist matching.
 * - Default: case-insensitive substring match (`mistral-large` also matches
 *   `mistral-large-2-instruct`).
 * - `=` prefix: case-insensitive EXACT match of the full model ID. Use this when a
 *   substring pattern would also swallow a still-usable sibling model, e.g.
 *   `=nvidia/mistralai/mistral-large` leaves `mistral-large-2-instruct` alive.
 */
export function isBlacklisted(modelId: string, blacklistPatterns: string[]): boolean {
  const lower = modelId.toLowerCase();
  for (const pattern of blacklistPatterns) {
    const p = pattern.trim().toLowerCase();
    if (p.length === 0) {
      continue;
    }
    if (p.startsWith('=')) {
      if (lower === p.slice(1).trim()) {
        return true;
      }
      continue;
    }
    if (lower.includes(p)) {
      return true;
    }
  }
  return false;
}

export function isNonChat(modelId: string, nonChatPatterns: string[]): boolean {
  const lower = modelId.toLowerCase();
  for (const pattern of nonChatPatterns) {
    const p = pattern.trim().toLowerCase();
    if (p.length > 0 && lower.includes(p)) {
      return true;
    }
  }
  return false;
}

/**
 * Classifies price status of a model according to Round 59 rules:
 * - Providers in zeroPaymentProviders are always FREE
 * - Models with explicit :free or -free suffix are FREE
 * - Models with confirmed positive price (> 0) and not in zeroPaymentProviders are PAID
 * - Models with missing or unverified price are PRICE_UNVERIFIED (retained, never dropped)
 */
export function classifyPrice(
  modelId: string,
  provider: string,
  zeroPaymentProviders: string[],
  catalogMeta?: CatalogMetadata
): PriceStatus {
  const lower = modelId.toLowerCase();
  const provLower = provider.toLowerCase();

  // 1. Zero payment providers list
  const zeroSet = new Set(zeroPaymentProviders.map((p) => p.toLowerCase()));
  if (zeroSet.has(provLower)) {
    return 'FREE';
  }

  // 2. Explicit free tags
  if (
    lower.endsWith(':free') ||
    lower.endsWith('-free') ||
    lower.includes(':free') ||
    lower.includes('/free')
  ) {
    return 'FREE';
  }

  // 3. Check catalog pricing if available
  if (catalogMeta && catalogMeta.pricing) {
    const promptPrice = parseFloat(String(catalogMeta.pricing.prompt ?? 0));
    const compPrice = parseFloat(String(catalogMeta.pricing.completion ?? 0));
    if ((!isNaN(promptPrice) && promptPrice > 0) || (!isNaN(compPrice) && compPrice > 0)) {
      return 'PAID';
    }
    if (promptPrice === 0 && compPrice === 0) {
      return 'FREE';
    }
  }

  // 4. Default when price cannot be definitively proven > 0
  return 'PRICE_UNVERIFIED';
}

export function loadModelCatalog(): Record<string, CatalogMetadata> {
  const appData =
    process.env['APPDATA'] ||
    path.join(process.env['USERPROFILE'] || '', 'AppData', 'Roaming');
  const catalogPath = path.join(appData, '9router', 'model-catalog.json');
  if (!fs.existsSync(catalogPath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(catalogPath, 'utf8');
    const parsed = JSON.parse(content);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.models &&
      typeof parsed.models === 'object'
    ) {
      return parsed.models as Record<string, CatalogMetadata>;
    }
    return {};
  } catch {
    return {};
  }
}
