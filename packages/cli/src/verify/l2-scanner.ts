/**
 * packages/cli/src/verify/l2-scanner.ts
 *
 * Implements L2 web catalog scanner (models.dev + OpenRouter catalog).
 * Runs at most once per hour, cached by ETag and content hash.
 * Zero-token: pure public HTTP GET guarded by canonical outbound allowlist.
 * Enforces flag `ẨN-GIÁ-0`: models with price 0 that lack -free / :free suffix.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertAllowedOutboundUrl,
  createGuardedFetch,
  OutboundGuardError,
} from '@routersync/core';
import type { L2ModelEntry, L2ScanState } from './types.js';

export const PROVIDER_ALIASES: Record<string, string> = {
  hf: 'huggingface',
  gemini: 'google',
  google: 'gemini',
  huggingface: 'hf',
  oai: 'openai',
  openai: 'oai',
};

export interface L2ScannerOptions {
  stateDir?: string | undefined;
  nowMs?: number | undefined;
  minIntervalMs?: number | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
  openRouterUrl?: string | undefined;
  modelsDevUrl?: string | undefined;
}

const DEFAULT_L2_MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function isZeroPriceHidden(modelId: string, price: number | null): boolean {
  if (price !== 0) return false;
  const normalized = modelId.toLowerCase();
  return !normalized.endsWith('-free') && !normalized.endsWith(':free') && !normalized.includes('/free');
}

export function loadL2Cache(cachePath: string): L2ScanState {
  if (!fs.existsSync(cachePath)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), models: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Partial<L2ScanState>;
    if (raw && typeof raw === 'object' && raw.models && typeof raw.models === 'object') {
      return {
        version: 1,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
        etagOpenRouter: raw.etagOpenRouter,
        etagModelsDev: raw.etagModelsDev,
        hashOpenRouter: raw.hashOpenRouter,
        hashModelsDev: raw.hashModelsDev,
        models: raw.models as Record<string, L2ModelEntry>,
      };
    }
  } catch {
    // Corrupted: start fresh
  }
  return { version: 1, updatedAt: new Date(0).toISOString(), models: {} };
}

export async function runL2Scan(options: L2ScannerOptions = {}): Promise<{
  state: L2ScanState;
  fromCache: boolean;
  requests: number;
}> {
  const orUrl = options.openRouterUrl ?? 'https://openrouter.ai/api/v1/models';
  const mdUrl = options.modelsDevUrl ?? 'https://models.dev/api.json';
  assertAllowedOutboundUrl(orUrl);
  assertAllowedOutboundUrl(mdUrl);

  const nowMs = options.nowMs ?? Date.now();
  const minInterval = options.minIntervalMs ?? DEFAULT_L2_MIN_INTERVAL_MS;
  const sDir = options.stateDir ?? path.join(process.cwd(), '.routersync');
  if (!fs.existsSync(sDir)) fs.mkdirSync(sDir, { recursive: true });

  const cachePath = path.join(sDir, 'l2-cache.json');
  const cached = loadL2Cache(cachePath);
  const lastUpdatedMs = Date.parse(cached.updatedAt);

  // Check 1h cache freshness window
  if (
    Number.isFinite(lastUpdatedMs) &&
    lastUpdatedMs > 0 &&
    nowMs - lastUpdatedMs >= 0 &&
    nowMs - lastUpdatedMs < minInterval
  ) {
    return { state: cached, fromCache: true, requests: 0 };
  }

  const fetchFn = createGuardedFetch(options.fetchFn ?? globalThis.fetch);
  let requests = 0;
  const modelMap: Record<string, L2ModelEntry> = { ...cached.models };

  let nextOrEtag = cached.etagOpenRouter ?? null;
  let nextOrHash = cached.hashOpenRouter ?? '';
  let nextMdEtag = cached.etagModelsDev ?? null;
  let nextMdHash = cached.hashModelsDev ?? '';

  // 1. Fetch OpenRouter catalog
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cached.etagOpenRouter) headers['If-None-Match'] = cached.etagOpenRouter;

    requests++;
    const res = await fetchFn(orUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.status === 200) {
      nextOrEtag = res.headers.get('etag');
      const text = await res.text();
      nextOrHash = createHash('sha256').update(text).digest('hex').slice(0, 16);
      const json = JSON.parse(text) as { data?: unknown[] };
      if (Array.isArray(json.data)) {
        for (const item of json.data) {
          const raw = item as Record<string, unknown>;
          const id = String(raw['id'] ?? '').trim();
          if (!id) continue;
          const pricing = raw['pricing'] as Record<string, unknown> | undefined;
          let price: number | null = null;
          if (pricing) {
            const p = Number(pricing['prompt'] ?? 0);
            const c = Number(pricing['completion'] ?? 0);
            if (Number.isFinite(p) && Number.isFinite(c)) price = p + c;
          }
          const zeroHidden = isZeroPriceHidden(id, price);
          const expirationDate = typeof raw['expiration_date'] === 'string' ? raw['expiration_date'] : undefined;
          modelMap[id] = {
            id,
            price,
            isZeroPriceHidden: zeroHidden,
            contextLength: Number(raw['context_length'] ?? 0) || undefined,
            source: modelMap[id] ? 'both' : 'openrouter',
            rawPricing: pricing,
            expirationDate,
          };
        }
      }
    }
  } catch (err) {
    if (err instanceof OutboundGuardError) throw err;
    // Non-fatal network error, preserve cached entries
  }

  // 2. Fetch models.dev catalog
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cached.etagModelsDev) headers['If-None-Match'] = cached.etagModelsDev;

    requests++;
    const res = await fetchFn(mdUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.status === 200) {
      nextMdEtag = res.headers.get('etag');
      const text = await res.text();
      nextMdHash = createHash('sha256').update(text).digest('hex').slice(0, 16);
      const json = JSON.parse(text) as Record<string, unknown>;
      if (json && typeof json === 'object') {
        for (const [providerKey, providerInfo] of Object.entries(json)) {
          const modelsObj = (providerInfo as Record<string, unknown>)?.['models'];
          if (modelsObj && typeof modelsObj === 'object') {
            for (const [modelKey, modelVal] of Object.entries(modelsObj as Record<string, unknown>)) {
              const fullKey = `${providerKey}/${modelKey}`;
              const mObj = modelVal as Record<string, unknown>;
              const costObj = mObj['cost'] as Record<string, unknown> | undefined;
              const cost = costObj?.['input'] ?? mObj['cost_per_token'] ?? mObj['input_cost_per_token'];
              const price = cost != null && Number.isFinite(Number(cost)) ? Number(cost) : null;
              const zeroHidden = isZeroPriceHidden(modelKey, price);
              const existing = modelMap[modelKey] ?? modelMap[fullKey];

              const entry: L2ModelEntry = {
                id: modelKey,
                provider: providerKey,
                price: price ?? existing?.price ?? null,
                isZeroPriceHidden: zeroHidden || (existing?.isZeroPriceHidden ?? false),
                source: existing ? 'both' : 'models.dev',
              };
              modelMap[modelKey] = entry;
              if (fullKey !== modelKey) modelMap[fullKey] = entry;
            }
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof OutboundGuardError) throw err;
    // Non-fatal network error
  }

  const newState: L2ScanState = {
    version: 1,
    updatedAt: new Date(nowMs).toISOString(),
    etagOpenRouter: nextOrEtag,
    etagModelsDev: nextMdEtag,
    hashOpenRouter: nextOrHash,
    hashModelsDev: nextMdHash,
    models: modelMap,
  };

  fs.writeFileSync(cachePath, JSON.stringify(newState, null, 2), 'utf8');
  return { state: newState, fromCache: false, requests };
}
