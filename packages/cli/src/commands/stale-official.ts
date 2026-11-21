/**
 * C21 Y3: official upstream model lists for `combos stale --source official`.
 *
 * Read-only. No writes, no deletions. Each conclusion names the source and the
 * moment it was checked. Network errors become `UPSTREAM-UNREACHABLE`; a model
 * missing from a reachable list is `NOT-LISTED-UPSTREAM`.
 *
 * `NOT-LISTED-UPSTREAM` is NOT a removal argument: an upstream catalog can lag,
 * paginate, or simply not list a model the router still serves.
 *
 * C28 H1: HF (`hfModelUrl`) uses a per-id existence probe
 * (`GET /api/models/{id}`): 200 -> LISTED-UPSTREAM, 404 -> NOT-LISTED-UPSTREAM,
 * 429/5xx/network/timeout/unparseable body -> UPSTREAM-UNREACHABLE (never
 * NOT-LISTED, so a quota/error never turns into a "missing" claim). Other
 * sources keep the catalog-based check.
 */

import { hfModelUrl } from '../sync/confirm.js';

export type OfficialConclusion =
  | 'LISTED-UPSTREAM'
  | 'NOT-LISTED-UPSTREAM'
  | 'NO-OFFICIAL-SOURCE'
  | 'UPSTREAM-UNREACHABLE'
  // C29 J0: catalog-api (NVIDIA) conclusions
  | 'LISTED-IN-CATALOG'
  | 'NOT-IN-CATALOG'
  // C29 J0: 401/403/other HTTP statuses from per-id probes (e.g. openai/gpt-4o → 401)
  | 'ACCESS-RESTRICTED-OR-ABSENT';

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
  /** Test hook: backoff multiplier base for 429 retries (default PER_ID_429_DELAY_MS). */
  retryDelayMs?: number;
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
  if (source.provider === 'hf') {
    // C28 H1: per-id probe is fresher than a lagging/paginating catalog.
    return checkHfPerId(source, modelId, checkedAt, options);
  }
  try {
    const { ids } = await loadCatalog(source, options);
    const wanted = normalizeModelId(modelId);
    const listed = ids.has(modelId) || ids.has(wanted) || ids.has(`models/${wanted}`);
    if (source.kind === 'catalog-api') {
      // C29 J0.2: for the community catalog (NVIDIA/models.dev), absence from a
      // reachable catalog is a low-confidence conclusion, not the removal claim
      // of NOT-LISTED-UPSTREAM (an upstream catalog may lag or omit ids we serve).
      return {
        provider,
        conclusion: listed ? 'LISTED-IN-CATALOG' : 'NOT-IN-CATALOG',
        source,
        checkedAt,
      };
    }
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

/**
 * C28 H1: per-id existence probe for Hugging Face via `hfModelUrl`.
 * 429/5xx/network/timeout or an unparseable 200 body is UPSTREAM-UNREACHABLE,
 * never NOT-LISTED: only a real 404 from the per-model endpoint proves absence.
 *
 * C29 J0.1: non-200/404 HTTP statuses other than 429 are ACCESS-RESTRICTED-OR-ABSENT
 * (e.g. 401 for repos that do not exist or need login): the endpoint answered, so
 * the model is neither listed nor proven absent.
 *
 * C29 J0.3: 429 is retried with exponential backoff, up to PER_ID_429_LIMIT; after
 * the budget is spent the outcome is ACCESS-RESTRICTED-OR-ABSENT ("rate limited").
 */
export let PER_ID_429_LIMIT = 4;
export function setPerId429Limit(limit: number): void {
  PER_ID_429_LIMIT = limit;
}
const PER_ID_429_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkHfPerId(
  source: OfficialSource,
  modelId: string,
  checkedAt: string,
  options: OfficialOptions
): Promise<OfficialCheck> {
  const wanted = normalizeModelId(modelId);
  const base = { provider: source.provider, source, checkedAt };
  const restricted = (detail: string): OfficialCheck => ({
    ...base,
    conclusion: 'ACCESS-RESTRICTED-OR-ABSENT',
    detail,
  });
  const unreachable = (detail: string): OfficialCheck => ({
    ...base,
    conclusion: 'UPSTREAM-UNREACHABLE',
    detail,
  });
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const url = hfModelUrl(wanted);
  for (let attempt = 0; attempt <= PER_ID_429_LIMIT; attempt++) {
    try {
      const response = await doFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'routersync-stale-official/0.1' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
      });
      if (response.status === 200) {
        // Prove the body parses before claiming existence.
        await response.json();
        return { ...base, conclusion: 'LISTED-UPSTREAM' };
      }
      if (response.status === 404) {
        return { ...base, conclusion: 'NOT-LISTED-UPSTREAM' };
      }
      if (response.status !== 429) {
        return restricted(`HTTP ${response.status}`);
      }
      if (attempt >= PER_ID_429_LIMIT) {
        return restricted(`HTTP 429 (retries exhausted)`);
      }
      await sleep((options.retryDelayMs ?? PER_ID_429_DELAY_MS) * 2 ** attempt);
    } catch (error) {
      return unreachable(error instanceof Error ? error.message : String(error));
    }
  }
  return restricted('HTTP 429 (retries exhausted)');
}

/** Test hook: drop the cache so a test can change the fake catalog. */
export function clearOfficialCache(): void {
  cache.clear();
}