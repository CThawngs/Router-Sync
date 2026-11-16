/**
 * packages/daemon/src/probe/reachability.ts
 *
 * Real-time reachability probe for local LLM routers with short TTL caching (B-1 / D7 / R9-2).
 *
 * Classification rules (R9-2):
 * - HTTP 200..299: 'up'
 * - Connection refused / timeout / network failure: 'down'
 * - HTTP response returned but non-2xx (e.g. 404, 500): 'unknown' (with httpStatus)
 *   (a router answering on port with 404 is alive/running, but the health route is unconfirmed;
 *    reporting 'down' would be untruthful).
 */

import { readDaemonConfig } from '../config/reader.js';
import type { RouterProbeResult } from '../types.js';

interface CacheEntry {
  result: RouterProbeResult;
  timestamp: number;
}

const probeCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 2500; // <= 3 seconds cache per R9-1 (b)

export function resolveRouterBaseUrl(targetId: 'omniroute' | '9router'): string {
  const cfg = readDaemonConfig();
  if (targetId === 'omniroute') {
    return process.env['OMNIROUTE_URL'] || cfg.omniUrl || 'http://127.0.0.1:30128';
  }
  return process.env['NINEROUTER_URL'] || cfg.nineUrl || 'http://127.0.0.1:20128';
}

export async function probeRouter(
  targetId: 'omniroute' | '9router',
  customUrl?: string
): Promise<RouterProbeResult> {
  const baseUrl = customUrl || resolveRouterBaseUrl(targetId);
  const cacheKey = `${targetId}:${baseUrl}`;

  const cached = probeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  const nowIso = new Date().toISOString();
  let result: RouterProbeResult;

  // Primary zero-token health endpoint documented in docs/adapters/9router.md & omniroute.md
  const targetEndpoint = `${baseUrl}/api/health`;

  try {
    const res = await fetch(targetEndpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(800), // 800ms timeout
    });

    if (res.ok) {
      result = {
        reachability: 'up',
        url: baseUrl,
        lastChecked: nowIso,
        httpStatus: res.status,
      };
    } else if (res.status === 404) {
      // 404 on /api/health -> check fallback /v1/models per R10-2
      try {
        const fallbackRes = await fetch(`${baseUrl}/v1/models`, {
          method: 'GET',
          signal: AbortSignal.timeout(800),
        });
        if (fallbackRes.ok) {
          result = {
            reachability: 'up',
            url: baseUrl,
            lastChecked: nowIso,
            httpStatus: fallbackRes.status,
          };
        } else {
          result = {
            reachability: 'unknown',
            url: baseUrl,
            lastChecked: nowIso,
            httpStatus: fallbackRes.status,
            error: `HTTP ${fallbackRes.status}`,
          };
        }
      } catch (fallbackErr: unknown) {
        result = {
          reachability: 'down',
          url: baseUrl,
          lastChecked: nowIso,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        };
      }
    } else {
      // 5xx, 401, etc. -> 'unknown'
      result = {
        reachability: 'unknown',
        url: baseUrl,
        lastChecked: nowIso,
        httpStatus: res.status,
        error: `HTTP ${res.status}`,
      };
    }
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    result = {
      reachability: 'down',
      url: baseUrl,
      lastChecked: nowIso,
      error: errMessage,
    };
  }

  probeCache.set(cacheKey, { result, timestamp: Date.now() });
  return result;
}

export async function probeAllRouters(): Promise<{
  omniroute: RouterProbeResult;
  ninerouter: RouterProbeResult;
}> {
  const [omniroute, ninerouter] = await Promise.all([
    probeRouter('omniroute'),
    probeRouter('9router'),
  ]);
  return { omniroute, ninerouter };
}

export function clearProbeCache(): void {
  probeCache.clear();
}

