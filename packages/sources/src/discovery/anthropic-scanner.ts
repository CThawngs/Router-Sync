/**
 * packages/sources/src/discovery/anthropic-scanner.ts
 *
 * Anthropic Model Discovery Scanner (Phase 3a / P1-DEBT-01 / SPEC §23.2).
 *
 * Discovers available Claude models directly via GET /v1/models endpoint.
 * Invariant B-0: NEVER calls completions or paid token endpoints (/v1/messages).
 */

import type { DiscoveredModel, ScannerOptions, ScanResult } from './provider-scanner.js';

export interface AnthropicScannerOptions extends ScannerOptions {
  anthropicVersion?: string | undefined;
  baseUrl?: string | undefined;
}

/**
 * Scans Anthropic GET /v1/models endpoint strictly using zero-token GET.
 */
export async function scanAnthropicModels(
  apiKey: string,
  options?: AnthropicScannerOptions
): Promise<ScanResult> {
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const baseUrl = options?.baseUrl ?? 'https://api.anthropic.com/v1';
  const anthropicVersion = options?.anthropicVersion ?? '2023-06-01';
  const start = Date.now();

  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': anthropicVersion,
  };

  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers,
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
      data?: Array<{ id?: string; type?: string; display_name?: string; created_at?: string }>;
    };

    if (!payload || !Array.isArray(payload.data)) {
      return {
        ok: false,
        models: [],
        error: 'Invalid response format: missing data array',
        latencyMs,
      };
    }

    const models: DiscoveredModel[] = payload.data
      .filter((item) => typeof item?.id === 'string' && item.id.trim().length > 0)
      .map((item) => ({
        id: item.id!.trim(),
        ownedBy: 'anthropic',
        created: item.created_at ? Date.parse(item.created_at) : undefined,
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
