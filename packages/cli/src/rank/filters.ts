/**
 * packages/cli/src/rank/filters.ts
 *
 * Deterministic gating filters:
 * 1. Blacklist check (space-bunny, union-alpha, minimax-m3.1, deepseek-v4-pro, etc.)
 * 2. Non-chat specialist check across all 5 non-chat families (embedding, audio,
 *    moderation/guard, image-gen, rerank) + vision-only
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

export type NonChatSpecialistKind =
  | 'embedding'
  | 'audio'
  | 'moderation'
  | 'image-gen'
  | 'rerank'
  | 'vision-only';

export interface NonChatClassifierInput {
  modelId: string;
  type?: string | undefined;
  mode?: string | undefined;
  capabilities?: readonly string[] | undefined;
  inputModalities?: readonly string[] | undefined;
  outputModalities?: readonly string[] | undefined;
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
  'nomic-embed',
  'jina-embeddings',
  'voyage-',
  'tts',
  'playai-tts',
  'kokoro',
  'canary-',
  'whisper',
  'transcribe',
  'dall-e',
  'gpt-image',
  'imagen',
  'flux',
  'sdxl',
  'midjourney',
  'stable-diffusion',
  'recraft',
  'ideogram',
  'moderation',
  'omni-moderation',
  'llama-guard',
  'prompt-guard',
  'shieldgemma',
  'safeguard',
  'clip',
  'rerank',
  'bge-',
  'guard',
  'vision-only',
  'ocr-only',
];

const RERANK_PATTERNS: readonly RegExp[] = [
  /\brerank(?:er)?\b/i,
  /bge-reranker/i,
  /jina-reranker/i,
];

const EMBEDDING_PATTERNS: readonly RegExp[] = [
  /\bembed(?:ding|dings)?\b/i,
  /text-embedding/i,
  /(?:^|[/._:-])(?:bge|e5)-(?:small|base|large|m3|en|multilingual|mistral)/i,
  /nomic-embed/i,
  /jina-embeddings/i,
  /voyage-(?:large|code|finance|law|multilingual|\d)/i,
];

const AUDIO_PATTERNS: readonly RegExp[] = [
  /(?:^|[/._:-])tts(?:$|[/._:-])/i,
  /whisper/i,
  /transcribe/i,
  /(?:^|[/._:-])audio(?:$|[/._:-])/i,
  /(?:^|[/._:-])speech(?:$|[/._:-])/i,
  /kokoro/i,
  /playai-tts/i,
  /canary-\d/i,
  /(?:^|[/._:-])stt(?:$|[/._:-])/i,
];

const MODERATION_PATTERNS: readonly RegExp[] = [
  /moderation/i,
  /omni-moderation/i,
  /llama-guard/i,
  /prompt-guard/i,
  /shieldgemma/i,
  /safeguard/i,
];

const IMAGE_GEN_PATTERNS: readonly RegExp[] = [
  /dall-e/i,
  /gpt-image/i,
  /(?:^|[/._:-])imagen(?:$|[/._:-\d])/i,
  /(?:^|[/._:-])flux(?:$|[/._:-\d])/i,
  /(?:^|[/._:-])sdxl(?:$|[/._:-])/i,
  /stable-diffusion/i,
  /midjourney/i,
  /recraft/i,
  /ideogram/i,
];

const VISION_ONLY_PATTERNS: readonly RegExp[] = [
  /vision-only/i,
  /ocr-only/i,
];

/**
 * Deterministically classifies specialist non-chat models across all 5 C45 WP5
 * non-chat model families (`embedding`, `audio`, `moderation`, `image-gen`, `rerank`)
 * plus `vision-only`, using both explicit metadata (`mode`, `type`, `capabilities`,
 * `outputModalities`) and model-ID patterns while keeping multimodal general chat
 * models (`gpt-4o`, `gemini-2.5-pro`, `claude-sonnet-4-5`, etc.) as `null`.
 */
export function classifyNonChatSpecialist(
  input: string | NonChatClassifierInput
): NonChatSpecialistKind | null {
  const normalized: NonChatClassifierInput =
    typeof input === 'string' ? { modelId: input } : input;

  const explicitTag = `${normalized.mode ?? ''} ${normalized.type ?? ''}`.trim().toLowerCase();
  if (explicitTag) {
    if (/\brerank/.test(explicitTag)) return 'rerank';
    if (/\bembed/.test(explicitTag)) return 'embedding';
    if (/\b(?:audio|tts|stt|speech|transcri)/.test(explicitTag)) return 'audio';
    if (/\b(?:moderation|guard|safety)/.test(explicitTag)) return 'moderation';
    if (/\b(?:image_generation|image-gen|image_edit|text-to-image)/.test(explicitTag)) {
      return 'image-gen';
    }
    if (/\b(?:vision-only|ocr-only)/.test(explicitTag)) return 'vision-only';
  }

  if (normalized.outputModalities && normalized.outputModalities.length > 0) {
    const outs = normalized.outputModalities.map((m) => m.toLowerCase());
    const hasTextOut = outs.includes('text');
    if (!hasTextOut) {
      if (outs.includes('embedding') || outs.includes('embeddings')) return 'embedding';
      if (outs.includes('audio') || outs.includes('speech')) return 'audio';
      if (outs.includes('image')) return 'image-gen';
    }
  }

  if (normalized.capabilities && normalized.capabilities.length > 0) {
    const caps = normalized.capabilities.map((c) => c.toLowerCase());
    const hasChat = caps.includes('chat') || caps.includes('text-generation') || caps.includes('completion');
    if (!hasChat) {
      if (caps.includes('rerank')) return 'rerank';
      if (caps.includes('embedding') || caps.includes('embeddings')) return 'embedding';
      if (caps.includes('tts') || caps.includes('asr') || caps.includes('audio-transcription')) return 'audio';
      if (caps.includes('moderation')) return 'moderation';
      if (caps.includes('image-generation') || caps.includes('image-gen')) return 'image-gen';
    }
  }

  const id = normalized.modelId.trim();
  // Check rerank BEFORE embedding so `bge-reranker-*` maps to `rerank`
  if (RERANK_PATTERNS.some((re) => re.test(id))) return 'rerank';
  if (EMBEDDING_PATTERNS.some((re) => re.test(id))) return 'embedding';
  if (AUDIO_PATTERNS.some((re) => re.test(id))) return 'audio';
  if (MODERATION_PATTERNS.some((re) => re.test(id))) return 'moderation';
  if (IMAGE_GEN_PATTERNS.some((re) => re.test(id))) return 'image-gen';
  if (VISION_ONLY_PATTERNS.some((re) => re.test(id))) return 'vision-only';

  return null;
}

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
  if (classifyNonChatSpecialist(modelId) !== null) {
    return true;
  }
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
