/**
 * packages/cli/src/track/free-classify.ts
 *
 * Pure function classifyFree: classifies models as free or paid with deterministic basis.
 * Pure function: zero I/O, no network, no filesystem.
 */

export interface ClassifyModelInput {
  id?: unknown;
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
  } | null;
  [key: string]: unknown;
}

export interface OwnerConfig {
  freeProviders?: string[];
  freeModels?: string[];
  paidModels?: string[];
}

export interface ClassifyFreeInput {
  provider: string;
  models: Array<string | ClassifyModelInput | unknown>;
  ownerConfig?: OwnerConfig | null;
}

export interface ClassifiedItem {
  id: string;
  raw: string;
  free: boolean;
  basis: string;
}

export interface ClassifyFreeResult {
  items: ClassifiedItem[];
  skipped: number;
}

function parsePrice(v: unknown): number | null {
  if (v === null || v === undefined || v === '') {
    return null;
  }
  if (typeof v === 'number') {
    return Number.isNaN(v) ? null : v;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    const num = Number(trimmed);
    return Number.isNaN(num) ? null : num;
  }
  return null;
}

export function classifyFree(input: ClassifyFreeInput): ClassifyFreeResult {
  const provider = input.provider || '';
  const models = Array.isArray(input.models) ? input.models : [];
  const ownerConfig = input.ownerConfig || {};

  const paidModelsSet = new Set(Array.isArray(ownerConfig.paidModels) ? ownerConfig.paidModels : []);
  const freeModelsSet = new Set(Array.isArray(ownerConfig.freeModels) ? ownerConfig.freeModels : []);
  const freeProvidersSet = new Set(Array.isArray(ownerConfig.freeProviders) ? ownerConfig.freeProviders : []);

  let skipped = 0;
  const rawItems: Array<{ raw: string; original: ClassifyModelInput | null }> = [];

  for (const m of models) {
    if (typeof m === 'string') {
      const trimmed = m.trim();
      if (trimmed.length > 0) {
        rawItems.push({ raw: trimmed, original: null });
      } else {
        skipped++;
      }
    } else if (m && typeof m === 'object' && !Array.isArray(m)) {
      const obj = m as Record<string, unknown>;
      if (typeof obj['id'] === 'string' && obj['id'].trim().length > 0) {
        rawItems.push({ raw: obj['id'].trim(), original: obj as ClassifyModelInput });
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }
  }

  // Deduplicate and process items
  const resultMap = new Map<string, ClassifiedItem>();

  for (const item of rawItems) {
    const raw = item.raw;
    const fullId = `${provider}/${raw}`;

    if (resultMap.has(fullId)) {
      continue;
    }

    let free = false;
    let basis = 'no-evidence';

    if (paidModelsSet.has(fullId)) {
      // F5: paidModels trumps everything
      free = false;
      basis = 'owner-declared-paid';
    } else if (freeModelsSet.has(fullId)) {
      // F5: freeModels
      free = true;
      basis = 'owner-declared-model';
    } else if (freeProvidersSet.has(provider)) {
      // F4: freeProviders
      free = true;
      basis = 'owner-declared';
    } else if (provider.toLowerCase() === 'openrouter') {
      const hasSuffixFree = raw.endsWith(':free');
      const pricing = item.original?.pricing;

      let promptPrice: number | null = null;
      let completionPrice: number | null = null;

      if (pricing && typeof pricing === 'object') {
        promptPrice = parsePrice(pricing.prompt);
        completionPrice = parsePrice(pricing.completion);
      }

      const hasValidPrompt = promptPrice !== null;
      const hasValidCompletion = completionPrice !== null;
      const hasPricing = hasValidPrompt && hasValidCompletion;

      if (hasPricing) {
        const isZeroPrice = promptPrice === 0 && completionPrice === 0;
        const hasPositivePrice = (promptPrice !== null && promptPrice > 0) || (completionPrice !== null && completionPrice > 0);
        const hasNegativePrice = (promptPrice !== null && promptPrice < 0) || (completionPrice !== null && completionPrice < 0);

        if (hasSuffixFree && hasPositivePrice) {
          // F6: conflict
          free = false;
          basis = 'conflict';
        } else if (isZeroPrice) {
          // F1, F7: zero-priced
          free = true;
          basis = 'openrouter-zero-price';
        } else if (hasPositivePrice) {
          // F1: positive price
          free = false;
          basis = 'openrouter-paid';
        } else if (hasNegativePrice) {
          // F1: negative price (e.g. -1 auto router)
          free = false;
          basis = 'openrouter-dynamic';
        } else if (hasSuffixFree) {
          free = true;
          basis = 'openrouter-free';
        } else {
          free = false;
          basis = 'no-evidence';
        }
      } else {
        // No complete pricing
        if (hasSuffixFree) {
          free = true;
          basis = 'openrouter-free';
        } else {
          free = false;
          basis = 'no-evidence';
        }
      }
    } else {
      // F3: other provider without declaration
      free = false;
      basis = 'no-evidence';
    }

    resultMap.set(fullId, {
      id: fullId,
      raw,
      free,
      basis,
    });
  }

  // F9: sort ascending by id
  const items = Array.from(resultMap.values()).sort((a, b) => a.id.localeCompare(b.id));

  return {
    items,
    skipped,
  };
}
