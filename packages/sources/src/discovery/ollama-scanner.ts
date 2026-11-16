/**
 * packages/sources/src/discovery/ollama-scanner.ts
 *
 * Local Ollama Model Discovery Scanner (Phase 3a / SPEC §23.2).
 *
 * Discovers locally pulled models via GET /api/tags.
 * Invariant B-0: NEVER triggers local inference.
 */

import type { DiscoveredModel, ScannerOptions, ScanResult } from './provider-scanner.js';

export async function scanOllamaModels(
  baseUrl = 'http://127.0.0.1:11434',
  options?: ScannerOptions
): Promise<ScanResult> {
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const start = Date.now();

  const url = baseUrl.replace(/\/+$/, '') + '/api/tags';

  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      return {
        ok: false,
        models: [],
        error: `HTTP ${res.status} ${res.statusText}`,
        latencyMs,
      };
    }

    const payload = (await res.json()) as {
      models?: Array<{ name?: string }>;
    };

    if (!payload || !Array.isArray(payload.models)) {
      return {
        ok: false,
        models: [],
        error: 'Invalid response format: missing models array',
        latencyMs,
      };
    }

    const models: DiscoveredModel[] = payload.models
      .filter((m) => typeof m?.name === 'string' && m.name.trim().length > 0)
      .map((m) => ({
        id: m.name!.trim(),
        ownedBy: 'ollama',
      }));

    return {
      ok: true,
      models,
      latencyMs,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      models: [],
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  }
}
