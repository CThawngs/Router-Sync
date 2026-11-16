/**
 * packages/cli/src/sync/providers.ts
 *
 * Provider registry + zero-token model-list scanner for `routersync sync`
 * (ROUND 56 §2). Two jobs:
 *
 *  1. Resolve which combo namespace prefix (`nvidia`, `hf`, `node-b`, ...) maps
 *     to exactly ONE provider connection and one GET host.
 *  2. Fetch that provider's own model list with a plain GET. NEVER calls
 *     /chat/completions, /embeddings or any billed endpoint, never scrapes a
 *     website, never runs an LLM.
 *
 * Secrets: API keys are read from the router DB into process memory only.
 * They are never logged, printed, serialised into a plan, or put in a URL.
 */

import { openBetterSqlite3, locateRouterDb, type SqliteDriver } from '@routersync/core';
import { loadProviderRegistry } from './provider-registry.js';

export type SkipReason =
  | 'oauth-router-managed'
  | 'key-encrypted'
  | 'missing-param'
  | 'no-key'
  | 'unknown-prefix'
  | 'incomplete-pagination'
  | 'redirect-blocked';

/**
 * Providers whose public model list requires no API key (free/anonymous GET).
 * The list lives in registry/providers.yaml (shared product data) so a private
 * provider never has to be hardcoded in the source.
 */
function noKeyPublicProviders(): ReadonlySet<string> {
  return new Set(loadProviderRegistry().noKeyPublic.map((p) => p.toLowerCase()));
}

export interface ProviderTarget {
  /** Stable identifier used in reports (provider connection id). */
  id: string;
  /** Human-facing label. */
  label: string;
  /** Combo namespace prefix this provider serves. */
  prefix: string;
  /** GET base URL, already resolved. Never contains a secret. */
  baseUrl?: string | undefined;
  /** RAM-only credential. Never printed. */
  apiKey?: string | undefined;
  keySource: '9router-key' | 'omniroute-key' | 'none';
  /** When set, this provider is not scanned and its steps are never removed. */
  skipReason?: SkipReason | undefined;
}

/** D4.2/C2b: nhãn khóa — 9router-key+9router là OWN-KEY, +omniroute là BORROWED-KEY. */
export function keySourceLabel(keySource: ProviderTarget['keySource'], router: string = '9router'): string {
  if (keySource === '9router-key' && router !== '9router') return 'BORROWED-KEY (9router-key muon)';
  if (keySource === '9router-key') return 'OWN-KEY (9router-key)';
  if (keySource === 'omniroute-key') return 'omniroute-key';
  return 'none';
}

/** Nhãn lý do bỏ qua có dấu, dùng cho SCAN-COMPLETENESS + SYNC-TARGETS. */
export function skipReasonLabel(
  reason: string | undefined,
  ctx: { status?: number | undefined; prefix?: string | undefined } = {}
): string {
  switch (reason) {
    case 'oauth-router-managed': return 'SKIP-OAUTH (router quản lý, bỏ qua tự động)';
    case 'missing-param': return 'SKIP-MISSING-PARAM (thiếu tham số kết nối)';
    case 'key-encrypted': return 'SKIP-KEY-ENCRYPTED (khóa đã mã hóa, bỏ qua)';
    case 'no-key': return 'SKIP-NO-KEY (không có khóa, bỏ qua)';
    case 'unknown-prefix': return 'NO-HOST (prefix lạ, không có host)';
    case 'no-base-url': return 'NO-HOST (không có host URL)';
    case 'incomplete-pagination': return 'SKIP-INCOMPLETE-PAGINATION (phân trang dở dang, bỏ qua)';
    case 'redirect-blocked': return 'SKIP-REDIRECT-BLOCKED (chuyển hướng bị chặn, bỏ qua)';
    default:
      break;
  }
  if (ctx.status === 429) return 'HTTP-429-QUOTA (hết hạn mức, thử lại sau)';
  if (ctx.status === 404) return 'CONTROL-404 (điểm đối chứng không thấy, chưa kết luận)';
  return reason ?? '(thiếu)';
}

export interface RouterScanInput {
  router: '9router' | 'omniroute';
  targets: ProviderTarget[];
  /** Prefixes referenced by in-scope combos. */
  prefixes: string[];
}

interface ConnectionRow {
  provider: string;
  apiKey?: string | undefined;
  authType: string;
  active: boolean;
  baseUrl?: string | undefined;
  prefix?: string | undefined;
  accountId?: string | undefined;
  extra?: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Known provider table (public GET /models endpoints, zero tokens)
// Loaded from registry/providers.yaml - shared product data, no private entry.
// ---------------------------------------------------------------------------

function knownBaseUrls(): Readonly<Record<string, string>> {
  return loadProviderRegistry().providers;
}

/** Providers whose list endpoint needs a parameter RouterSync does not hold. */
const NEEDS_PARAM: Readonly<Record<string, string>> = {
  'cloudflare-ai': 'accountId',
};

/** Combo prefixes that are not the provider id verbatim. */
function prefixAliases(): Readonly<Record<string, string>> {
  return loadProviderRegistry().alias;
}

/**
 * Router-managed subscription/OAuth providers: RouterSync never uses their
 * tokens for a keyed GET and never removes their steps (R2/§2d).
 */
const OAUTH_PROVIDERS: ReadonlySet<string> = new Set([
  'antigravity',
  'claude-code',
  'codex',
  'gemini-cli',
  'copilot',
  'cursor',
]);

// ---------------------------------------------------------------------------
// DB readers (read-only)
// ---------------------------------------------------------------------------

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function openReadOnly(router: '9router' | 'omniroute'): SqliteDriver {
  return openBetterSqlite3(locateRouterDb(router), { readOnly: true, busyTimeoutMs: 5000 });
}

function readNineRouterConnections(db: SqliteDriver): ConnectionRow[] {
  const rows = db.prepare(
    'SELECT provider, name, authType, isActive, data FROM providerConnections'
  ).all() as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const data = parseJsonObject(row['data']);
    const active = Number(row['isActive'] ?? 0) === 1;
    const authType = String(row['authType'] ?? 'none');
    // RouterSync only ever needs the credential itself; everything else here
    // is non-secret metadata.
    const apiKey = authType === 'apikey' ? str(data['apiKey']) : undefined;
    return {
      provider: String(row['provider'] ?? ''),
      apiKey,
      authType,
      active,
      baseUrl: str(data['baseUrl']),
      prefix: str(data['prefix']),
      accountId: str(data['accountId']),
    };
  });
}

function readOmniRouteConnections(db: SqliteDriver): ConnectionRow[] {
  const rows = db.prepare(
    'SELECT provider, name, auth_type, is_active, api_key, provider_specific_data FROM provider_connections'
  ).all() as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const data = parseJsonObject(row['provider_specific_data']);
    const apiKey = str(row['api_key']);
    return {
      provider: String(row['provider'] ?? ''),
      apiKey,
      authType: String(row['auth_type'] ?? 'none'),
      active: Number(row['is_active'] ?? 0) === 1,
      baseUrl: str(data['baseUrl']),
      prefix: str(data['prefix']),
      accountId: str(data['accountId']),
      extra: data,
    };
  });
}

/**
 * OmniRoute provider_nodes: openai-compatible custom nodes with prefix + base_url.
 * R57: read these to resolve uuid-named connections (e.g. openai-compatible-chat-75b6525d)
 * that have a declared prefix and host but whose api_key lives on the connection row.
 */
function readOmniRouteNodes(db: SqliteDriver): Map<string, { provider: string; baseUrl?: string | undefined }> {
  const byPrefix = new Map<string, { provider: string; baseUrl?: string | undefined }>();
  try {
    const nodes = db.prepare(
      'SELECT id, prefix, base_url FROM provider_nodes WHERE prefix IS NOT NULL'
    ).all() as Array<Record<string, unknown>>;
    for (const node of nodes) {
      const prefix = str(node['prefix']);
      const id = String(node['id'] ?? '');
      if (!prefix) continue;
      const entry = { provider: id, baseUrl: str(node['base_url']) };
      // Both prefix and uuid id may appear in combo steps; register both.
      byPrefix.set(prefix.toLowerCase(), entry);
      if (id) byPrefix.set(id.toLowerCase(), entry);
    }
  } catch {
    // provider_nodes may not exist in older OmniRoute versions; silently skip.
  }
  return byPrefix;
}

/**
 * OmniRoute encrypts provider keys at rest. A ciphertext is long and has no
 * recognisable vendor shape; a plaintext key from 9Router is short. Decide by
 * length only — the value itself is never inspected for its content.
 */
export function looksEncrypted(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 100;
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/** Canonical provider name for a combo prefix (alias table, then identity). */
export function canonicalPrefix(prefix: string): string {
  const lower = prefix.trim().toLowerCase();
  return prefixAliases()[lower] ?? lower;
}

/**
 * Builds the provider targets for one router. Only prefixes that are actually
 * referenced by an in-scope combo are returned — scanning a provider whose
 * steps nobody uses is pure noise.
 *
 * `sharedKeys` carries credentials already resolved from 9Router, keyed by
 * canonical prefix. OmniRoute encrypts its own keys at rest, so a provider that
 * both routers configure is scanned once, with the 9Router key, against the
 * OmniRoute-declared host (ROUND 56 §2c).
 */
export function resolveProviderTargets(
  router: '9router' | 'omniroute',
  prefixes: string[],
  sharedKeys: ReadonlyMap<string, { apiKey: string; baseUrl?: string | undefined }> = new Map()
): ProviderTarget[] {
  const db = openReadOnly(router);
  let rows: ConnectionRow[];
  let byPrefix = new Map<string, { provider: string; baseUrl?: string | undefined }>();
  try {
    rows = router === '9router' ? readNineRouterConnections(db) : readOmniRouteConnections(db);

    if (router === '9router') {
      const nodes = db.prepare('SELECT id, data FROM providerNodes').all() as Array<
        Record<string, unknown>
      >;
      const entries: Array<readonly [string, { provider: string; baseUrl?: string | undefined }]> =
        [];
      for (const node of nodes) {
        const data = parseJsonObject(node['data']);
        const id = String(node['id'] ?? '');
        const entry = { provider: id, baseUrl: str(data['baseUrl']) } as const;
        const prefix = str(data['prefix']);
        // Both names are real: combos reference the node prefix
        // and, after a rename, the raw connection id
        // (`openai-compatible-chat-<uuid>`). Both reach the same host.
        if (prefix) entries.push([prefix.toLowerCase(), entry]);
        if (id) entries.push([id.toLowerCase(), entry]);
      }
      byPrefix = new Map(entries);
    } else {
      // OmniRoute declares prefix + baseUrl on the connection itself.
      for (const row of rows) {
        if (!row.prefix) continue;
        byPrefix.set(row.prefix.toLowerCase(), { provider: row.provider, baseUrl: row.baseUrl });
      }
      // R57: also read provider_nodes (openai-compatible custom nodes) which carry
      // prefix + base_url independently of the connection row. Nodes take lower
      // priority than connection-declared prefix so they don't overwrite existing entries.
      const nodeMap = readOmniRouteNodes(db);
      for (const [key, entry] of nodeMap) {
        if (!byPrefix.has(key)) byPrefix.set(key, entry);
      }
    }
  } finally {
    db.close();
  }

  // provider id -> row, for every active connection.
  const byProvider = new Map<string, ConnectionRow>();
  for (const row of rows) {
    if (!byProvider.has(row.provider) || row.active) byProvider.set(row.provider, row);
  }

  const targets: ProviderTarget[] = [];
  const seen = new Set<string>();

  for (const prefix of prefixes) {
    const lower = prefix.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    const declared = byPrefix.get(lower);
    const provider = declared?.provider ?? canonicalPrefix(lower);
    const row = byProvider.get(provider);

    const label = row?.provider === provider ? provider : prefix;
    const base = { id: provider, label, prefix: lower } as const;
    const shared = sharedKeys.get(canonicalPrefix(lower));
    const encrypted = looksEncrypted(row?.apiKey);
    const ownKey = encrypted ? undefined : row?.apiKey;
    const apiKey = ownKey ?? shared?.apiKey;
    // A borrowed key is always a 9Router key, even when the step belongs to
    // OmniRoute; the report says so instead of implying OmniRoute's own key.
    const keySource: '9router-key' | 'omniroute-key' | 'none' = ownKey
      ? router === '9router'
        ? '9router-key'
        : 'omniroute-key'
      : shared
        ? '9router-key'
        : 'none';

    if (OAUTH_PROVIDERS.has(provider) || row?.authType === 'oauth') {
      targets.push({ ...base, keySource: 'none', skipReason: 'oauth-router-managed' });
      continue;
    }

    // RouterSync has no parameterised list endpoint (e.g. the Cloudflare
    // account-scoped path): the provider is skipped, never guessed.
    if (NEEDS_PARAM[provider]) {
      targets.push({ ...base, keySource: 'none', skipReason: 'missing-param' });
      continue;
    }

    // Nothing is configured under this namespace at all -> the step must stay
    // (R3). Reported as unknown-prefix, never removed.
    if (!row && !declared) {
      targets.push({ ...base, keySource: 'none', skipReason: 'unknown-prefix' });
      continue;
    }

    if (!apiKey) {
      // R57: providers in NO_KEY_PUBLIC serve /models without authentication.
      // Allow a keyless GET rather than skipping with 'no-key'.
      const isPublic = noKeyPublicProviders().has(canonicalPrefix(lower));
      if (!isPublic) {
        targets.push({
          ...base,
          keySource: 'none',
          skipReason: encrypted ? 'key-encrypted' : 'no-key',
        });
        continue;
      }
      // Fall through: isPublic=true, apiKey=undefined, keySource='none', no skipReason.
    }

    const baseUrl = declared?.baseUrl ?? row?.baseUrl ?? knownBaseUrls()[provider] ?? shared?.baseUrl;
    if (!baseUrl) {
      targets.push({ ...base, keySource: 'none', skipReason: 'unknown-prefix' });
      continue;
    }

    targets.push({
      ...base,
      baseUrl,
      apiKey,
      keySource,
    });
  }

  return targets;
}

// ---------------------------------------------------------------------------
// Zero-token scan
// ---------------------------------------------------------------------------

export type NetworkErrorClass = 'timeout' | 'reset' | 'dns' | 'tls' | 'refused' | 'unknown';
export function classifyNetworkError(err: unknown): NetworkErrorClass {
  const inner = (err as { cause?: unknown } | null)?.cause ?? err;
  // C3o O3(e): Windows/undici báo fetch-refused là AggregateError; đọc errors[].code trước.
  const agg = ((err as { errors?: Array<{ code?: string }> } | null)?.errors ?? (inner as { errors?: Array<{ code?: string }> } | null)?.errors);
  const aggCode = agg?.[0]?.code ?? '';
  const code = aggCode || (inner as { code?: string } | null)?.code || (err as { code?: string } | null)?.code || '';
  const name = err instanceof Error ? err.name : '';
  const msg = (err instanceof Error ? err.message : String(err)) + ' ' + (inner instanceof Error ? inner.message : '');
  if (name === 'TimeoutError' || /timeout|timed out|ETIMEDOUT/i.test(msg)) return 'timeout';
  if (code === 'ECONNRESET' || /reset/i.test(msg)) return 'reset';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /dns|getaddrinfo/i.test(msg)) return 'dns';
  if (code === 'ECONNREFUSED' || /refused/i.test(msg)) return 'refused';
  if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(code + msg)) return 'tls';
  return 'unknown';
}
export interface ScanOutcome {
  ok: boolean;
  status: number;
  models: string[];
  serverEtag?: string | null | undefined;
  error?: string | undefined;
  skipReason?: SkipReason | undefined;
  errorClass?: NetworkErrorClass | undefined;
  attempts?: number | undefined;
  latencyMs: number;
  truncated?: boolean | undefined;
  incomplete?: boolean | undefined;
  pages?: number | undefined;
  topKeys?: string[] | undefined;
  pagination?: string | undefined;
  bytes?: number | undefined;
  rawCount?: number | undefined;
}

export const SCAN_MAX_PAGES = 20;
export const SCAN_MAX_MODELS = 5000;
export const SCAN_MAX_BYTES_PER_PAGE = 10 * 1024 * 1024; // 10 MiB per-page ceiling (C4n/N7 safe-http protection)

export const FORBIDDEN_INFERENCE_PATH_PATTERN = /(?:^|\/)(chat|completions|embeddings|responses|messages|images|audio|generate|predict|infer)(?:$|\/|\?)/i;

/** ponytail: detect common pagination signals only; add provider-specific pagers when a host proves different. */
export function detectNextPage(
  payload: unknown,
  headers?: Headers | Map<string, string> | Record<string, string>
): {
  url: string | null;
  total: number | null;
  signalWithoutCursor?: boolean | undefined;
  forbiddenDiscarded?: boolean | undefined;
} {
  if (payload === null || typeof payload !== 'object') return { url: null, total: null };
  const r = payload as Record<string, unknown>;
  let url: string | null = null;
  let signalWithoutCursor = false;
  let forbiddenDiscarded = false;
  const link = typeof (headers as any)?.get === 'function' ? (headers as any).get('link') : (headers as Record<string,string>)?.['Link'] ?? (headers as Record<string,string>)?.['link'];
  if (typeof link === 'string') { const m = link.match(/<([^>]+)>;\s*rel="next"/i); if (m) url = m[1] ?? null; }
  if (!url && typeof r['next'] === 'string') url = r['next'] as string;
  if (!url && typeof r['next_url'] === 'string') url = r['next_url'] as string;
  if (!url && typeof r['next_page'] === 'string') url = r['next_page'] as string;
  const pag = r['pagination'] && typeof r['pagination'] === 'object' ? r['pagination'] as Record<string, unknown> : null;
  if (!url && pag && typeof pag['next'] === 'string') url = pag['next'] as string;
  if (!url && r['has_more'] === true) {
    const cur = typeof r['next_cursor'] === 'string' ? r['next_cursor'] : typeof r['cursor'] === 'string' ? r['cursor'] : typeof r['last_id'] === 'string' ? r['last_id'] : null;
    if (cur) url = cur;
    else {
      url = ''; // signal present but no cursor -> incomplete
      signalWithoutCursor = true;
    }
  }
  if (url && FORBIDDEN_INFERENCE_PATH_PATTERN.test(url)) {
    url = null; // discard pagination pointing to inference/chat endpoints
    forbiddenDiscarded = true;
  }
  const t = typeof r['total'] === 'number' ? r['total'] : pag && typeof pag['total'] === 'number' ? pag['total'] as number : null;
  return {
    url,
    total: t,
    ...(signalWithoutCursor ? { signalWithoutCursor: true } : {}),
    ...(forbiddenDiscarded ? { forbiddenDiscarded: true } : {}),
  };
}

function extractIds(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record['data'])
    ? record['data']
    : Array.isArray(record['models'])
      ? record['models']
      : [];

  const ids: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      ids.push(entry);
    } else if (entry !== null && typeof entry === 'object') {
      const item = entry as Record<string, unknown>;
      const value = item['id'] ?? item['name'] ?? item['model'];
      if (typeof value === 'string') ids.push(value);
    }
  }
  return ids;
}

/**
 * Same-origin check: protocol, hostname, and port must match.
 * Used to verify pagination links and redirect destinations so credentials
 * (Authorization: Bearer <apiKey>) are never sent to a foreign origin (C4o/O4).
 */
export function isSameOrigin(targetUrl: string, baseOriginUrl: string): boolean {
  try {
    const t = new URL(targetUrl);
    const b = new URL(baseOriginUrl);
    return t.protocol === b.protocol && t.hostname === b.hostname && t.port === b.port;
  } catch {
    return false;
  }
}

/**
 * Reads an HTTP response body with a strict per-page byte cap (`maxBytes`).
 *
 * Uses `res.body.getReader()` when available so that an oversized chunked or
 * streaming response without `Content-Length` is cancelled mid-stream as soon
 * as cumulative bytes exceed `maxBytes`, before buffering the whole body.
 *
 * Falls back to `res.text()` / `res.json()` ONLY when `res.body?.getReader` is
 * absent (synthetic unit-test response mocks that omit a Web ReadableStream).
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number = SCAN_MAX_BYTES_PER_PAGE
): Promise<
  | { ok: true; payload: unknown; byteLen: number }
  | { ok: false; byteLen: number; error: string }
> {
  const bodyAny = (
    res as unknown as {
      body?: { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | null;
    }
  ).body;
  if (bodyAny && typeof bodyAny.getReader === 'function') {
    const reader = bodyAny.getReader();
    const chunks: Uint8Array[] = [];
    let byteLen = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          byteLen += value.byteLength;
          if (byteLen > maxBytes) {
            await reader.cancel().catch(() => {});
            return {
              ok: false,
              byteLen,
              error: `payload-too-large: response exceeds ${maxBytes} bytes (${byteLen} bytes)`,
            };
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore if already released after cancel
      }
    }
    const text = Buffer.concat(chunks, byteLen).toString('utf8');
    try {
      return { ok: true, payload: JSON.parse(text), byteLen };
    } catch (parseErr) {
      return {
        ok: false,
        byteLen,
        error: `bad-shape: response body is not valid JSON (${parseErr instanceof Error ? parseErr.name : 'parse-error'})`,
      };
    }
  }

  // Fallback for synthetic unit-test response objects that only implement res.text() or res.json()
  // without providing a Web ReadableStream on res.body.
  if (typeof res.text === 'function') {
    const text = await res.text();
    const byteLen = Buffer.byteLength(text, 'utf8');
    if (byteLen > maxBytes) {
      return {
        ok: false,
        byteLen,
        error: `payload-too-large: response exceeds ${maxBytes} bytes (${byteLen} bytes)`,
      };
    }
    try {
      return { ok: true, payload: JSON.parse(text), byteLen };
    } catch (parseErr) {
      return {
        ok: false,
        byteLen,
        error: `bad-shape: response body is not valid JSON (${parseErr instanceof Error ? parseErr.name : 'parse-error'})`,
      };
    }
  }

  const payload = await (res as typeof res & { json: () => Promise<unknown> }).json();
  const serialized = JSON.stringify(payload);
  const byteLen = Buffer.byteLength(serialized, 'utf8');
  if (byteLen > maxBytes) {
    return {
      ok: false,
      byteLen,
      error: `payload-too-large: response exceeds ${maxBytes} bytes (${byteLen} bytes)`,
    };
  }
  return { ok: true, payload, byteLen };
}

/**
 * GET <baseUrl>/models. This is the only network call RouterSync makes here:
 * a model listing, billed at zero tokens.
 */
async function fetchModelListOnce(
  target: ProviderTarget,
  options: { fetchFn?: typeof globalThis.fetch; timeoutMs?: number; serverEtag?: string | null } = {}
): Promise<ScanOutcome> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const started = Date.now();

  if (!target.baseUrl) {
    return { ok: false, status: 0, models: [], error: 'no-base-url', latencyMs: 0 };
  }

  const baseUrl = `${target.baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (target.apiKey) headers['Authorization'] = `Bearer ${target.apiKey}`;
  if (options.serverEtag) headers['If-None-Match'] = options.serverEtag;

  const all: string[] = [];
  let currentUrl: string | null = baseUrl;
  let pages = 0;
  let incomplete = false;
  let lastStatus = 0;
  let topKeys: string[] = [];
  let pagination = 'none';
  let bytesAcc = 0;
  let rawCount = 0;
  let foundServerEtag: string | null = null;
  try {
    while (currentUrl && pages < SCAN_MAX_PAGES && all.length < SCAN_MAX_MODELS) {
      const res = await fetchFn(currentUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
      pages++;
      lastStatus = res.status;
      if (res.status === 304) {
        return { ok: true, status: 304, models: [], serverEtag: options.serverEtag, latencyMs: Date.now() - started, pages: 1, incomplete: false, bytes: 0, rawCount: 0 };
      }
      // C4o/O4 & C4p/P2: handle redirects under manual redirect to prevent credential leakage
      if (res.status >= 300 && res.status < 400) {
        const headersAny = res.headers as unknown as { get?: (k: string) => string | null } & Record<string, string>;
        const loc = typeof headersAny?.get === 'function' ? headersAny.get('location') : headersAny?.['location'] ?? headersAny?.['Location'];
        if (loc) {
          const resolvedLoc = new URL(loc, currentUrl).toString();
          if (isSameOrigin(resolvedLoc, baseUrl)) {
            const pathname = new URL(resolvedLoc).pathname;
            if (FORBIDDEN_INFERENCE_PATH_PATTERN.test(pathname) || FORBIDDEN_INFERENCE_PATH_PATTERN.test(resolvedLoc)) {
              return {
                ok: false,
                status: res.status,
                models: [],
                error: `redirect-blocked: refusing redirect to forbidden inference path ${resolvedLoc}`,
                skipReason: 'redirect-blocked',
                latencyMs: Date.now() - started,
                pages,
                incomplete: false,
                topKeys,
                pagination,
                bytes: bytesAcc,
                rawCount,
              };
            }
            currentUrl = resolvedLoc;
            continue;
          }
        }
        return {
          ok: false,
          status: res.status,
          models: [],
          error: `redirect-blocked: refusing redirect to ${loc ?? 'unknown'}`,
          skipReason: 'redirect-blocked',
          latencyMs: Date.now() - started,
          pages,
          incomplete: false,
          topKeys,
          pagination,
          bytes: bytesAcc,
          rawCount,
        };
      }
      if (pages === 1) {
        const headersAny = res.headers as unknown as { get?: (k: string) => string | null } & Record<string, string>;
        const etagHeader = typeof headersAny?.get === 'function'
          ? headersAny.get('etag')
          : headersAny?.['etag'] ?? headersAny?.['ETag'];
        if (typeof etagHeader === 'string' && etagHeader.trim()) {
          foundServerEtag = etagHeader.trim();
        }
      }
      const headersAny = res.headers as unknown as { get?: (k: string) => string | null } & Record<string, string>;
      const clHeader = typeof headersAny?.get === 'function' ? headersAny.get('content-length') : headersAny?.['content-length'] ?? headersAny?.['Content-Length'];
      if (clHeader && Number(clHeader) > SCAN_MAX_BYTES_PER_PAGE) {
        return {
          ok: false,
          status: res.status,
          models: [],
          error: `payload-too-large: response content-length (${clHeader}) exceeds ${SCAN_MAX_BYTES_PER_PAGE} bytes`,
          latencyMs: Date.now() - started,
          pages,
          incomplete,
          topKeys,
          pagination,
          bytes: bytesAcc,
          rawCount,
        };
      }
      if (!res.ok) return { ok: false, status: res.status, models: [], error: `HTTP ${res.status}`, latencyMs: Date.now() - started, pages, incomplete, topKeys, pagination, bytes: bytesAcc, rawCount };
      const bodyResult = await readBodyCapped(res, SCAN_MAX_BYTES_PER_PAGE);
      bytesAcc += bodyResult.byteLen;
      if (!bodyResult.ok) {
        return {
          ok: false,
          status: res.status,
          models: [],
          error: bodyResult.error,
          latencyMs: Date.now() - started,
          pages,
          incomplete,
          topKeys,
          pagination,
          bytes: bytesAcc,
          rawCount,
        };
      }
      const payload = bodyResult.payload;
      if (pages === 1 && payload && typeof payload === 'object') topKeys = Object.keys(payload as Record<string, unknown>);
      const next = detectNextPage(payload, res.headers as any);
      {
        const r = payload as Record<string, unknown>;
        const sigs: string[] = [];
        if (typeof r['next'] === 'string') sigs.push('next');
        if (typeof r['next_url'] === 'string') sigs.push('next_url');
        if (typeof r['has_more'] === 'boolean') sigs.push('has_more');
        if (typeof r['total'] === 'number') sigs.push('total');
        if (r['pagination'] && typeof r['pagination'] === 'object') sigs.push('pagination');
        pagination = sigs.length ? sigs.join(',') : 'none';
      }
      const ids = extractIds(payload);
      rawCount += ids.length;
      for (const id of ids) { if (all.length < SCAN_MAX_MODELS) all.push(id); }
      if (rawCount > all.length) {
        incomplete = true;
      }
      if (pages === 1) {
        const hasListShape = Array.isArray((payload as Record<string, unknown> | null)?.['data']) || Array.isArray((payload as Record<string, unknown> | null)?.['models']);
        if (!hasListShape && ids.length === 0) {
          return { ok: false, status: res.status, models: [], error: `bad-shape: response has no 'data' or 'models' array`, latencyMs: Date.now() - started, pages, incomplete, topKeys, pagination, bytes: bytesAcc, rawCount };
        }
      }
      if (next.total !== null && next.total > all.length && (!next.url)) {
        incomplete = true;
        currentUrl = null;
        break;
      }
      if (next.url === '' || next.signalWithoutCursor || next.forbiddenDiscarded) {
        incomplete = true;
        currentUrl = null;
        break;
      }
      if (!next.url) {
        currentUrl = null;
        break;
      }
      if (pages >= SCAN_MAX_PAGES || all.length >= SCAN_MAX_MODELS) {
        incomplete = true;
        currentUrl = null;
        break;
      }
      let resolvedNextUrl: string;
      if (next.url.startsWith('http://') || next.url.startsWith('https://')) {
        if (!isSameOrigin(next.url, baseUrl)) {
          // C4o/O4: cross-origin pagination rejected to prevent credential leakage
          incomplete = true;
          currentUrl = null;
          break;
        }
        resolvedNextUrl = next.url;
      } else if (next.url.startsWith('/')) {
        resolvedNextUrl = new URL(next.url, currentUrl).toString();
      } else {
        resolvedNextUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(next.url)}`;
      }
      if (!isSameOrigin(resolvedNextUrl, baseUrl)) {
        incomplete = true;
        currentUrl = null;
        break;
      }
      const nextPathname = new URL(resolvedNextUrl).pathname;
      if (FORBIDDEN_INFERENCE_PATH_PATTERN.test(nextPathname) || FORBIDDEN_INFERENCE_PATH_PATTERN.test(resolvedNextUrl)) {
        incomplete = true;
        currentUrl = null;
        break;
      }
      currentUrl = resolvedNextUrl;
    }
    const latencyMs = Date.now() - started;
    return {
      ok: all.length > 0,
      status: lastStatus,
      models: all,
      serverEtag: foundServerEtag,
      error: incomplete ? 'incomplete-pagination' : all.length > 0 ? undefined : 'empty-list',
      skipReason: incomplete ? 'incomplete-pagination' : undefined,
      latencyMs,
      truncated: incomplete || undefined,
      incomplete,
      pages,
      topKeys,
      pagination,
      bytes: bytesAcc,
      rawCount,
    };
  } catch (err) {
    const ec = classifyNetworkError(err);
    return { ok: false, status: 0, models: [], error: `network-${ec}: ${err instanceof Error ? err.message : 'fetch-failed'}`, errorClass: ec, latencyMs: Date.now() - started, pages, incomplete, topKeys, pagination, bytes: bytesAcc, rawCount };
  }
}
/** C3m M1: retries tối đa 2 lần cho lỗi mạng (3s rồi 9s), không retry HTTP/bad-shape. */
export async function fetchModelList(
  target: ProviderTarget,
  options: {
    fetchFn?: typeof globalThis.fetch;
    timeoutMs?: number;
    retryDelaysMs?: number[];
    serverEtag?: string | null;
  } = {}
): Promise<ScanOutcome> {
  const delays = options.retryDelaysMs ?? [3000, 9000];
  let last: ScanOutcome | null = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    last = await fetchModelListOnce(target, options);
    last.attempts = attempt + 1;
    if (last.ok || !last.errorClass) return last;
    if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt] ?? 0));
  }
  return last!;
}

export interface ModelEntry {
  id: string;
  raw: Record<string, unknown>;
  /** Pricing field names actually present in the response, e.g. 'pricing.input' / 'pricing.output' or 'cost'. */
  priceFields: string[];
  /** Resolved input price (number or undefined). */
  inputPrice: number | undefined;
  /** Resolved completion/output price (number or undefined). */
  outputPrice: number | undefined;
}

function extractPriceNumbers(obj: Record<string, unknown> | undefined): { input: number | undefined; output: number | undefined; fields: string[] } {
  if (!obj) return { input: undefined, output: undefined, fields: [] as string[] };
  const fields: string[] = [];
  let input: number | undefined;
  let output: number | undefined;

  // OpenRouter style: pricing.prompt / pricing.completion
  const pricing = obj['pricing'];
  if (pricing && typeof pricing === 'object') {
    const p = pricing as Record<string, unknown>;
    const prompt = p['prompt'] ?? p['input'];
    const completion = p['completion'] ?? p['output'];
    if (typeof prompt === 'number') { fields.push('pricing.prompt'); input = prompt; }
    else if (typeof p['input'] === 'number') { fields.push('pricing.input'); input = p['input']; }
    if (typeof completion === 'number') { fields.push('pricing.completion'); output = completion; }
    else if (typeof p['output'] === 'number') { fields.push('pricing.output'); output = p['output']; }
  }

  // Flat cost field
  const cost = obj['cost'];
  if (typeof cost === 'number') { fields.push('cost'); input = cost; output = cost; }

  // Flat input/output
  if (typeof obj['input'] === 'number' && !fields.includes('pricing.input')) { fields.push('input'); input = obj['input']; }
  if (typeof obj['output'] === 'number' && !fields.includes('pricing.output')) { fields.push('output'); output = obj['output']; }

  // Node-A style (C3p P2): price_input_vnd / price_output_vnd (VNĐ/1M tokens) con số thật.
  if (typeof obj['price_input_vnd'] === 'number') { fields.push('price_input_vnd'); input = obj['price_input_vnd']; }
  if (typeof obj['price_output_vnd'] === 'number') { fields.push('price_output_vnd'); output = obj['price_output_vnd']; }

  return { input, output, fields };
}

function extractModelEntries(payload: unknown): ModelEntry[] {
  if (payload === null || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record['data'])
    ? record['data']
    : Array.isArray(record['models'])
      ? record['models']
      : [];

  const entries: ModelEntry[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const idValue = obj['id'] ?? obj['name'] ?? obj['model'];
    if (typeof idValue !== 'string') continue;
    const { input, output, fields } = extractPriceNumbers(obj);
    entries.push({ id: idValue, raw: obj, priceFields: fields, inputPrice: input, outputPrice: output });
  }
  return entries;
}

/**
 * FETCH /models and return raw model entries with resolved pricing.
 * Zero-token listing only; never calls billed endpoints.
 */
export async function fetchModelEntries(
  target: ProviderTarget,
  options: { fetchFn?: typeof globalThis.fetch; timeoutMs?: number } = {}
): Promise<{ ok: boolean; status: number; entries: ModelEntry[]; error?: string | undefined; latencyMs: number; bytes: number }> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const started = Date.now();

  if (!target.baseUrl) {
    return { ok: false, status: 0, entries: [], error: 'no-base-url', latencyMs: 0, bytes: 0 };
  }

  const url = `${target.baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (target.apiKey) headers['Authorization'] = `Bearer ${target.apiKey}`;

  let currentUrl: string | null = url;
  const baseUrl = target.baseUrl;
  let redirects = 0;
  const MAX_REDIRECTS = 5;

  try {
    while (currentUrl) {
      const res = await fetchFn(currentUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });

      if (res.status >= 300 && res.status < 400) {
        if (redirects >= MAX_REDIRECTS) {
          return { ok: false, status: res.status, entries: [], error: 'redirect-blocked: too many redirects', latencyMs: Date.now() - started, bytes: 0 };
        }
        redirects++;
        const headersAny = res.headers as unknown as { get?: (k: string) => string | null } & Record<string, string>;
        const loc = typeof headersAny?.get === 'function' ? headersAny.get('location') : headersAny?.['location'] ?? headersAny?.['Location'];
        if (loc) {
          const resolvedLoc = new URL(loc, currentUrl).toString();
          if (isSameOrigin(resolvedLoc, baseUrl)) {
            const pathname = new URL(resolvedLoc).pathname;
            if (FORBIDDEN_INFERENCE_PATH_PATTERN.test(pathname) || FORBIDDEN_INFERENCE_PATH_PATTERN.test(resolvedLoc)) {
              return {
                ok: false,
                status: res.status,
                entries: [],
                error: `redirect-blocked: refusing redirect to forbidden inference path ${resolvedLoc}`,
                latencyMs: Date.now() - started,
                bytes: 0,
              };
            }
            currentUrl = resolvedLoc;
            continue;
          }
        }
        return {
          ok: false,
          status: res.status,
          entries: [],
          error: `redirect-blocked: refusing redirect to ${loc ?? 'unknown'}`,
          latencyMs: Date.now() - started,
          bytes: 0,
        };
      }

      const headersAny = res.headers as unknown as { get?: (k: string) => string | null } & Record<string, string>;
      const clHeader = typeof headersAny?.get === 'function' ? headersAny.get('content-length') : headersAny?.['content-length'] ?? headersAny?.['Content-Length'];
      if (clHeader && Number(clHeader) > SCAN_MAX_BYTES_PER_PAGE) {
        return {
          ok: false,
          status: res.status,
          entries: [],
          error: `payload-too-large: response content-length (${clHeader}) exceeds ${SCAN_MAX_BYTES_PER_PAGE} bytes`,
          latencyMs: Date.now() - started,
          bytes: 0,
        };
      }

      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return { ok: false, status: res.status, entries: [], error: `HTTP ${res.status}`, latencyMs, bytes: 0 };
      }

      const bodyResult = await readBodyCapped(res, SCAN_MAX_BYTES_PER_PAGE);
      const byteLen = bodyResult.byteLen;
      if (!bodyResult.ok) {
        return {
          ok: false,
          status: res.status,
          entries: [],
          error: bodyResult.error,
          latencyMs,
          bytes: byteLen,
        };
      }
      const payload = bodyResult.payload;

      const entries = extractModelEntries(payload);
      const hasListShape =
        Array.isArray((payload as Record<string, unknown> | null)?.['data']) ||
        Array.isArray((payload as Record<string, unknown> | null)?.['models']);
      if (!hasListShape && entries.length === 0) {
        return {
          ok: false,
          status: res.status,
          entries: [],
          error: `bad-shape: response has no 'data' or 'models' array`,
          latencyMs,
          bytes: byteLen,
        };
      }
      return { ok: true, status: res.status, entries, latencyMs, bytes: byteLen };
    }
    return { ok: false, status: 0, entries: [], error: 'empty-url', latencyMs: Date.now() - started, bytes: 0 };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      entries: [],
      error: `bad-shape: ${err instanceof Error ? err.name : 'fetch-failed'}`,
      latencyMs: Date.now() - started,
      bytes: 0,
    };
  }
}

/** Control xác định theo host: bỏ tiền tố provider, sort, lấy đầu tiên. Cùng host + cùng danh sách => cùng id. */
export function pickDeterministicControlId(modelIds: readonly string[], providerPrefix: string): string | null {
  const pref = providerPrefix.toLowerCase();
  const stripped = modelIds
    .map((id) => (id.toLowerCase().startsWith(`${pref}/`) ? id.slice(pref.length + 1) : id))
    .filter((s) => s.length > 0)
    .sort((a, b) => a.localeCompare(b));
  return stripped[0] ?? null;
}
/** Host only — safe to print, never carries a key. */
export function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return '(none)';
  try {
    return new URL(baseUrl).host;
  } catch {
    return '(invalid)';
  }
}
