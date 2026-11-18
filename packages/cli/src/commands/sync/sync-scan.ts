/**
 * packages/cli/src/commands/sync/sync-scan.ts
 *
 * Two-round zero-token model-list scanning. One GET per host per round (hosts
 * shared by two prefixes are fetched once and reused).
 */

import { createHash } from 'node:crypto';
import { fetchModelList, canonicalPrefix, type ProviderTarget } from '../../sync/providers.js';
import type { RouterView } from './sync-plan.js';
import type { ProviderLive } from '../../sync/plan.js';
import { isLowResource } from '../../low-resource.js';

export type ScanMeta = Map<string, { status: number; incomplete: boolean; pages: number; bytes?: number | undefined; rawCount?: number | undefined; error?: string | undefined; errorClass?: string | undefined; at?: string | undefined }>;

/** Băm tập id đã sắp xếp (D3): thay "3 id đầu" làm dấu vân tay. */
export function hashIdSet(ids: readonly string[]): string {
  return createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 16);
}

export async function scanAll(
  views: RouterView[],
  round: number,
  timeoutMs: number,
  quiet = false,
  incompleteOut?: Set<string>,
  metaOut?: ScanMeta
): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();
  const jobs: Array<{ view: RouterView; target: ProviderTarget }> = [];
  for (const view of views) {
    for (const target of view.targets) {
      if (!target.skipReason) jobs.push({ view, target });
    }
  }

  // Two prefixes can point at the same host (e.g. a node prefix and its raw
  // connection id). One GET per host per round is enough.
  const hostCache = new Map<string, string[]>();
  const reqTimes: Array<{ view: string; prefix: string; at: string }> = [];
  const metaCache = new Map<string, { status: number; incomplete: boolean; pages: number; bytes?: number | undefined; rawCount?: number | undefined; error?: string | undefined; errorClass?: string | undefined; at?: string | undefined }>();
  const lowResource = isLowResource();
  const concurrency = lowResource ? 1 : 4;
  const effectiveTimeoutMs = lowResource ? Math.min(timeoutMs, 10000) : timeoutMs;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const job = jobs[index];
      if (!job) return;
      const fp = createHash('sha256').update(`${job.target.baseUrl ?? ''}|${job.target.apiKey ?? ''}`).digest('hex').slice(0, 16);
      const cacheKey = `${job.view.name}|${job.target.baseUrl ?? ''}|${fp}|${job.target.keySource}`;
      const cached = hostCache.get(cacheKey);
      if (cached) {
        const ckey = `${job.view.name}:${job.target.prefix}`;
        results.set(ckey, cached);
        metaOut?.set(ckey, metaCache.get(cacheKey) ?? { status: 200, incomplete: false, pages: 1 });
        if (!quiet) {
          console.log(
            `SYNC-SCAN router=${job.view.name} prefix=${job.target.prefix} round=${round} models=${cached.length} reused=1`
          );
        }
        continue;
      }
      const outcome = await fetchModelList(job.target, { timeoutMs: effectiveTimeoutMs });
      const at = new Date().toISOString();
      const key = `${job.view.name}:${job.target.prefix}`;
      const meta = { status: outcome.status, incomplete: !!outcome.incomplete, pages: outcome.pages ?? 1, bytes: outcome.bytes, rawCount: outcome.rawCount, error: outcome.error, errorClass: outcome.errorClass, at };
      metaCache.set(cacheKey, meta);
      metaOut?.set(key, meta);
      if (outcome.incomplete) incompleteOut?.add(key);
      hostCache.set(cacheKey, outcome.incomplete ? [] : outcome.models);
      results.set(key, outcome.incomplete ? [] : outcome.models);
      if (!quiet) {
        console.log(
          `SYNC-SCAN router=${job.view.name} prefix=${job.target.prefix} round=${round} status=${outcome.status} models=${outcome.models.length} pages=${outcome.pages ?? 1}${outcome.incomplete ? ' INCOMPLETE=1' : ''}${outcome.ok ? '' : ` error=${outcome.error ?? 'unknown'}`}`
        );
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function buildProviderLive(
  views: RouterView[],
  round1: Map<string, string[]>,
  round2: Map<string, string[]>,
  catalog: Map<string, number>,
  incomplete?: Set<string>
): ProviderLive[] {
  const live: ProviderLive[] = [];
  for (const view of views) {
    for (const target of view.targets) {
      const key = `${view.name}:${target.prefix}`;
      const isIncomplete = incomplete?.has(key);
      const skipReason = target.skipReason ?? (isIncomplete ? 'incomplete-pagination' : undefined);
      live.push({
        router: view.name,
        id: `${view.name}:${target.id}`,
        prefix: target.prefix,
        label: target.label,
        skipReason,
        scan1: isIncomplete ? [] : (round1.get(key) ?? []),
        scan2: isIncomplete ? [] : (round2.get(key) ?? []),
        // Prefer the canonical provider name: a connection id is often a UUID,
        // while the catalog is keyed by provider name (`huggingface`).
        catalogCount:
          catalog.get(canonicalPrefix(target.prefix)) ?? catalog.get(target.id.toLowerCase()),
      });
    }
  }
  return live;
}
