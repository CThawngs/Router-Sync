/**
 * packages/sources/src/discovery/provider-scanner.ts
 *
 * Zero-Token Provider Discovery Scanner (Phase 3a / P1-DEBT-01 / SPEC §23.2).
 *
 * Discovers available models directly via standard GET /v1/models endpoints.
 * Invariant B-0: NEVER calls paid completions endpoints (/chat/completions).
 */

export interface DiscoveredModel {
  id: string;
  ownedBy?: string | undefined;
  created?: number | undefined;
}

export interface ScannerOptions {
  apiKey?: string | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
  timeoutMs?: number | undefined;
}

export interface ScanResult {
  ok: boolean;
  models: DiscoveredModel[];
  error?: string;
  latencyMs: number;
}

/**
 * Scans an OpenAI-compatible /v1/models endpoint strictly using zero-token GET.
 */
export async function scanOpenAiCompatibleModels(
  baseUrl: string,
  options?: ScannerOptions
): Promise<ScanResult> {
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const start = Date.now();

  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (options?.apiKey) {
    headers['Authorization'] = `Bearer ${options.apiKey}`;
  }

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

    const payload = (await res.json()) as { data?: Array<{ id?: string; owned_by?: string; created?: number }> };
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
        ownedBy: typeof item.owned_by === 'string' ? item.owned_by : undefined,
        created: typeof item.created === 'number' ? item.created : undefined,
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
