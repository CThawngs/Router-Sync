/**
 * C21 Y3: official upstream model lists for `combos stale --source official`.
 *
 * Read-only. No writes, no deletions. Each conclusion names the source and the
 * moment it was checked. Network errors become `UPSTREAM-UNREACHABLE`; a model
 * missing from a reachable list is `NOT-LISTED-UPSTREAM`.
 *
 * `NOT-LISTED-UPSTREAM` is NOT a removal argument: an upstream catalog can lag,
 * paginate, or simply not list a model the router still serves.
 */

export type OfficialConclusion =
  | 'LISTED-UPSTREAM'
  | 'NOT-LISTED-UPSTREAM'
  | 'NO-OFFICIAL-SOURCE'
  | 'UPSTREAM-UNREACHABLE';

export interface OfficialSource {
  /** Public provider id as used in a combo step. */
  provider: string;
  /** Human label used in reports; never a private gateway name. */
  label: string;
  url: string;
  kind: 'model-list-api' | 'catalog-api' | 'docs-page' | 'deprecation-notice';
}

/**
 * Public providers with a machine-readable model list. Providers that only have
 * a documentation page are deliberately absent: a docs page cannot be parsed
 * reliably, and pretending otherwise would invent conclusions.
 */
export const OFFICIAL_SOURCES: Readonly<Record<string, OfficialSource>> = {
  openrouter: {
    provider: 'openrouter',
    label: 'OpenRouter models API',
    url: 'https://openrouter.ai/api/v1/models',
    kind: 'model-list-api',
  },
  // C26 D5: the two public providers with the most rows in the 9Router DB
  // (hf=936, nvidia=270). NVIDIA has no official no-key model list, so its
  // community catalog is labelled `catalog`, never `official`.
  hf: {
    provider: 'hf',
    label: 'Hugging Face public models API',
    url: 'https://huggingface.co/api/models',
    kind: 'model-list-api',
  },
  nvidia: {
    provider: 'nvidia',
    label: 'NVIDIA models (models.dev community catalog)',
    url: 'https://models.dev/api.json',
    kind: 'catalog-api',
  },
};

/** Alias prefixes that resolve to the same upstream catalog. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  or: 'openrouter',
  openrouter: 'openrouter',
};

export function resolveOfficialSource(provider: string): OfficialSource | null {
  const key = provider.toLowerCase();
  const canonical = PROVIDER_ALIASES[key] ?? key;
  return OFFICIAL_SOURCES[canonical] ?? null;
}

function normalizeModelId(raw: string): string {
  let id = raw.trim();
  if (id.startsWith('models/')) id = id.slice('models/'.length);
  return id;
}

/** Extract the set of model ids from a provider-specific JSON payload. */
export function extractModelIds(source: OfficialSource, payload: unknown): Set<string> {
  const ids = new Set<string>();
  const record = payload as Record<string, unknown>;
  if (source.url.endsWith('/models') && Array.isArray(record?.['data'])) {
    for (const entry of record['data'] as Array<Record<string, unknown>>) {
      const id = entry?.['id'];
      if (typeof id === 'string') ids.add(normalizeModelId(id));
    }
  }
  // C26 D5: Hugging Face returns a bare array of { id }; models.dev returns
  // { <provider>: { models: { <id>: {...} } } }.
  if (source.kind === 'catalog-api' && record && typeof record === 'object') {
    for (const providerEntry of Object.values(record)) {
      const models = (providerEntry as Record<string, unknown>)?.['models'];
      if (models && typeof models === 'object') {
        for (const id of Object.keys(models)) ids.add(normalizeModelId(id));
      }
    }
  }
  if (Array.isArray(payload)) {
    for (const entry of payload as Array<Record<string, unknown>>) {
      const id = entry?.['id'];
      if (typeof id === 'string') ids.add(normalizeModelId(id));
    }
  }
  return ids;
}

export interface OfficialCheck {
  provider: string;
  conclusion: OfficialConclusion;
  source: OfficialSource | null;
  checkedAt: string;
  detail?: string;
}

export interface OfficialOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** Short cache so one report run does not refetch the same catalog per row. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { ids: Set<string>; checkedAt: string }>();

function cacheKey(source: OfficialSource): string {
  return `${source.url}#${source.kind}`;
}

async function loadCatalog(
  source: OfficialSource,
  options: OfficialOptions
): Promise<{ ids: Set<string>; checkedAt: string }> {
  const key = cacheKey(source);
  const hit = cache.get(key);
  const now = options.now?.() ?? new Date();
  if (hit && now.getTime() - Date.parse(hit.checkedAt) < CACHE_TTL_MS) return hit;

  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const response = await doFetch(source.url, {
    headers: { 'User-Agent': 'routersync-stale-official/0.1' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const entry = { ids: extractModelIds(source, payload), checkedAt: now.toISOString() };
  cache.set(key, entry);
  return entry;
}

export async function checkOfficial(
  provider: string,
  modelId: string,
  options: OfficialOptions = {}
): Promise<OfficialCheck> {
  const source = resolveOfficialSource(provider);
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  if (!source) {
    return { provider, conclusion: 'NO-OFFICIAL-SOURCE', source: null, checkedAt };
  }
  try {
    const { ids } = await loadCatalog(source, options);
    const wanted = normalizeModelId(modelId);
    const listed = ids.has(modelId) || ids.has(wanted) || ids.has(`models/${wanted}`);
    return {
      provider,
      conclusion: listed ? 'LISTED-UPSTREAM' : 'NOT-LISTED-UPSTREAM',
      source,
      checkedAt,
    };
  } catch (error) {
    return {
      provider,
      conclusion: 'UPSTREAM-UNREACHABLE',
      source,
      checkedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Test hook: drop the cache so a test can change the fake catalog. */
export function clearOfficialCache(): void {
  cache.clear();
}