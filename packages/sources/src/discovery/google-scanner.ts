/**
 * packages/sources/src/discovery/google-scanner.ts
 *
 * Google Gemini Model Discovery Scanner (Phase 3a / SPEC §23.2).
 *
 * Discovers available Gemini models directly via GET /v1beta/models.
 * Invariant B-0: NEVER calls generateContent or paid token endpoints.
 */

import type { DiscoveredModel, ScannerOptions, ScanResult } from './provider-scanner.js';

export async function scanGoogleGeminiModels(
  apiKey: string,
  options?: Omit<ScannerOptions, 'apiKey'>
): Promise<ScanResult> {
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const start = Date.now();

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;

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
      models?: Array<{ name?: string; displayName?: string; inputTokenLimit?: number }>;
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
      .map((m) => {
        // Strip 'models/' prefix from name if present
        const id = m.name!.replace(/^models\//, '').trim();
        return {
          id,
          ownedBy: 'google',
        };
      });

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
