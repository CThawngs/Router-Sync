/**
 * packages/cli/src/rank/interleave.ts
 *
 * Implements D1: Provider Interleaving.
 * Head (Tiers 1-5) strictly follows §31 hierarchy and lexicographic priority.
 * Tail (Fallback & UNRATED) interleaves across distinct providers round-robin
 * to balance load, mitigate single-provider rate-limits, and satisfy §15A coverage.
 * Within UNRATED of the same provider, stable original order is preserved.
 */

import type { ModelRankItem } from './types.js';

export function interleaveTailByProvider(tailItems: ModelRankItem[], preserveUnratedOrder = true): ModelRankItem[] {
  if (tailItems.length <= 1) {
    return tailItems;
  }

  // Group items by provider
  const providerQueues = new Map<string, ModelRankItem[]>();
  const providerOrder: string[] = [];

  for (const item of tailItems) {
    const prov = item.provider || 'unknown';
    if (!providerQueues.has(prov)) {
      providerQueues.set(prov, []);
      providerOrder.push(prov);
    }
    providerQueues.get(prov)!.push(item);
  }

  // If preserveUnratedOrder is set, sort UNRATED within each provider by originalIndex
  if (preserveUnratedOrder) {
    for (const [, queue] of providerQueues.entries()) {
      // Sort so fallback models (tier < 99) come first, and unrated (tier 99) preserve originalIndex
      queue.sort((a, b) => {
        if (a.tier !== b.tier) {
          return a.tier - b.tier;
        }
        return a.originalIndex - b.originalIndex;
      });
    }
  }

  // Round-robin interleaving
  const interleaved: ModelRankItem[] = [];
  let remainingCount = tailItems.length;

  while (remainingCount > 0) {
    for (const prov of providerOrder) {
      const q = providerQueues.get(prov);
      if (q && q.length > 0) {
        const item = q.shift()!;
        interleaved.push(item);
        remainingCount--;
      }
    }
  }

  return interleaved;
}

export function applyRankingInterleave(
  items: ModelRankItem[],
  applyToTiers = [99],
  preserveUnratedOrder = true
): ModelRankItem[] {
  const targetTiersSet = new Set(applyToTiers);

  const head: ModelRankItem[] = [];
  const tail: ModelRankItem[] = [];

  for (const item of items) {
    if (targetTiersSet.has(item.tier)) {
      tail.push(item);
    } else {
      head.push(item);
    }
  }

  const interleavedTail = interleaveTailByProvider(tail, preserveUnratedOrder);
  return [...head, ...interleavedTail];
}
