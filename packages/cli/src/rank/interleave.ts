/**
 * packages/cli/src/rank/interleave.ts
 *
 * Implements D1: Provider Interleaving + C45 WP5 Max-Remaining-Bucket
 * Cross-Provider Alternation (`interleaveAcrossProviders`).
 */

import type { ModelRankItem } from './types.js';

export interface InterleaveCandidateLike {
  provider: string;
  step?: string | undefined;
  score?: number | undefined;
}

export interface InterleaveAcrossProvidersResult<T extends InterleaveCandidateLike> {
  ordered: T[];
  adjacentSameProviderCount: number;
  distinctProviders: number;
}

/**
 * Deterministic max-remaining-bucket provider alternation (C45 WP5 §2.2):
 *  - At position `i`, picks the highest-ranked remaining candidate from a
 *    provider `p !== prevProvider`, preferring the provider bucket with the
 *    largest remaining count, breaking ties by top candidate `score` (desc),
 *    then `step` / `provider` (asc).
 *  - Falls back to `p === prevProvider` ONLY when no other provider has
 *    remaining candidates.
 *  - Mathematically guarantees `adjacentSameProviderCount === 0` whenever
 *    `maxProviderCount <= Math.ceil(N / 2)`.
 */
export function interleaveAcrossProviders<T extends InterleaveCandidateLike>(
  candidates: readonly T[]
): InterleaveAcrossProvidersResult<T> {
  if (candidates.length === 0) {
    return { ordered: [], adjacentSameProviderCount: 0, distinctProviders: 0 };
  }

  const buckets = new Map<string, T[]>();
  for (const item of candidates) {
    const prov = (item.provider || 'unknown').toLowerCase();
    let list = buckets.get(prov);
    if (!list) {
      list = [];
      buckets.set(prov, list);
    }
    list.push(item);
  }

  const distinctProviders = buckets.size;
  const ordered: T[] = [];
  let prevProvider: string | null = null;
  let remaining = candidates.length;

  const compareBuckets = (
    [provA, listA]: [string, T[]],
    [provB, listB]: [string, T[]]
  ): number => {
    if (listB.length !== listA.length) {
      return listB.length - listA.length;
    }
    const topA = listA[0]!;
    const topB = listB[0]!;
    const scoreA = topA.score ?? 0;
    const scoreB = topB.score ?? 0;
    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }
    const keyA = topA.step ?? provA;
    const keyB = topB.step ?? provB;
    const stepCmp = keyA.localeCompare(keyB);
    if (stepCmp !== 0) return stepCmp;
    return provA.localeCompare(provB);
  };

  while (remaining > 0) {
    const nonEmpty = [...buckets.entries()].filter(([, list]) => list.length > 0);
    const diffProv = nonEmpty.filter(([prov]) => prov !== prevProvider);
    const pool = diffProv.length > 0 ? diffProv : nonEmpty;
    pool.sort(compareBuckets);

    const [chosenProv, chosenList] = pool[0]!;
    const picked = chosenList.shift()!;
    ordered.push(picked);
    prevProvider = chosenProv;
    remaining -= 1;
  }

  let adjacentSameProviderCount = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = (ordered[i - 1]!.provider || 'unknown').toLowerCase();
    const curr = (ordered[i]!.provider || 'unknown').toLowerCase();
    if (curr === prev) {
      adjacentSameProviderCount += 1;
    }
  }

  return {
    ordered,
    adjacentSameProviderCount,
    distinctProviders,
  };
}

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
