/**
 * packages/core/src/cost/outbound-guard.ts
 *
 * C45-WP8 (`Phục vụ: S7`): Runtime Zero-LLM Endpoint Guard & Canonical Registry
 * Outbound Domain Allowlist (`registry/sources.yaml` + `registry/providers.yaml`).
 *
 * Guarantees:
 *  1. Every automated HTTP request is checked BEFORE `fetch` executes.
 *  2. Any LLM inference endpoint (`/v1/chat/completions`, `/chat/completions`,
 *     `/v1/messages`, `:generateContent`, `:streamGenerateContent`, `/v1/responses`,
 *     `/v1/completions`, `/v1/embeddings`) throws `OutboundGuardError('FORBIDDEN_LLM_ENDPOINT')`
 *     even when targeting an allowed upstream domain or `localhost`.
 *  3. Any unlisted remote domain throws `OutboundGuardError('UNLISTED_OUTBOUND_DOMAIN')`.
 *  4. `createAccountingFetch` records per-hostname request counts for `cost-ledger.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type FetchInput = Parameters<typeof globalThis.fetch>[0];

export const FORBIDDEN_LLM_PATH_PATTERNS: readonly RegExp[] = Object.freeze([
  /\/v1\/chat\/completions\b/i,
  /\/chat\/completions\b/i,
  /\/v1\/messages\b/i,
  /:generateContent\b/i,
  /:streamGenerateContent\b/i,
  /\/v1\/responses\b/i,
  /\/v1\/completions\b/i,
  /\/v1\/embeddings\b/i,
]);

/**
 * Embedded baseline extracted from `registry/sources.yaml`, `registry/providers.yaml`,
 * and documented official vendor catalog endpoints in `@routersync/sources` so standalone
 * installed npm tarballs work identically even when `registry/` is not in `process.cwd()`.
 */
const BASELINE_REGISTRY_HOSTS: readonly string[] = Object.freeze([
  'ai.google.dev',
  'anthropic.com',
  'api-docs.deepseek.com',
  'api.anthropic.com',
  'api.cerebras.ai',
  'api.cohere.com',
  'api.deepseek.com',
  'api.fireworks.ai',
  'api.groq.com',
  'api.kilo.ai',
  'api.mistral.ai',
  'api.novita.ai',
  'api.openai.com',
  'api.sambanova.ai',
  'api.siliconflow.com',
  'build.nvidia.com',
  'console.groq.com',
  'docs.anthropic.com',
  'docs.mistral.ai',
  'docs.sambanova.ai',
  'docs.siliconflow.cn',
  'fireworks.ai',
  'generativelanguage.googleapis.com',
  'huggingface.co',
  'inference-docs.cerebras.ai',
  'integrate.api.nvidia.com',
  'models.dev',
  'openai.com',
  'openrouter.ai',
  'platform.openai.com',
  'raw.githubusercontent.com',
  'router.huggingface.co',
]);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

const ALLOWED_LOOPBACK_PATH_RE =
  /^\/(?:v1\/models|models|api\/tags|api\/version|api\/health|health)(?:\/|$)/i;

export type OutboundGuardErrorCode =
  | 'INVALID_OUTBOUND_URL'
  | 'DISALLOWED_OUTBOUND_SCHEME'
  | 'EMBEDDED_CREDENTIALS_FORBIDDEN'
  | 'FORBIDDEN_LLM_ENDPOINT'
  | 'UNLISTED_OUTBOUND_DOMAIN';

export class OutboundGuardError extends Error {
  readonly code: OutboundGuardErrorCode;
  readonly url: string;

  constructor(code: OutboundGuardErrorCode, url: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'OutboundGuardError';
    this.code = code;
    this.url = url;
  }
}

export interface OutboundGuardOptions {
  repoRoot?: string | undefined;
  allowedDomains?: ReadonlySet<string> | undefined;
  extraAllowedHosts?: Iterable<string> | undefined;
  allowLoopback?: boolean | undefined;
  allowInsecureExtraHosts?: boolean | undefined;
}

function findRegistryDir(hint?: string): string | null {
  const candidates: string[] = [];
  if (hint) {
    candidates.push(hint, path.join(hint, 'registry'));
  }
  candidates.push(
    path.join(process.cwd(), 'registry'),
    path.resolve(process.cwd(), '..', '..', 'registry')
  );
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(
      path.resolve(here, '..', '..', '..', '..', 'registry'),
      path.resolve(here, '..', '..', '..', 'registry')
    );
  } catch {
    // ignore
  }
  for (const dir of candidates) {
    try {
      if (
        fs.existsSync(path.join(dir, 'sources.yaml')) &&
        fs.existsSync(path.join(dir, 'providers.yaml'))
      ) {
        return dir;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Loads the canonical set of allowed outbound hostnames from `registry/sources.yaml`
 * and `registry/providers.yaml` merged with official catalog endpoints.
 */
let defaultAllowedDomainsCache: ReadonlySet<string> | null = null;

export function loadCanonicalAllowedDomains(repoRootOrRegistryDir?: string): ReadonlySet<string> {
  if (!repoRootOrRegistryDir && defaultAllowedDomainsCache) {
    return defaultAllowedDomainsCache;
  }
  const hosts = new Set<string>(BASELINE_REGISTRY_HOSTS);
  const regDir = findRegistryDir(repoRootOrRegistryDir);
  if (regDir) {
    for (const filename of ['sources.yaml', 'providers.yaml']) {
      try {
        const text = fs.readFileSync(path.join(regDir, filename), 'utf8');
        for (const match of text.matchAll(/https:\/\/[^\s"'#]+/g)) {
          try {
            const parsed = new URL(match[0]);
            hosts.add(parsed.hostname.toLowerCase().replace(/\.$/, ''));
          } catch {
            // ignore malformed token
          }
        }
      } catch {
        // ignore unreadable file
      }
    }
  }
  if (!repoRootOrRegistryDir) {
    defaultAllowedDomainsCache = hosts;
  }
  return hosts;
}

function extractRequestUrlString(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === 'object' && 'url' in input && typeof input.url === 'string') {
    return input.url;
  }
  return String(input);
}

/**
 * Validates that `rawUrl` is a safe, zero-LLM, allowlisted catalog/health URL.
 * Returns normalized lowercase hostname on success; throws `OutboundGuardError` otherwise.
 */
export function assertAllowedOutboundUrl(
  rawUrl: string,
  options: OutboundGuardOptions = {}
): { parsed: URL; host: string } {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new OutboundGuardError('INVALID_OUTBOUND_URL', String(rawUrl), 'Outbound URL must be a non-empty string.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new OutboundGuardError('INVALID_OUTBOUND_URL', rawUrl, `Malformed outbound URL: "${rawUrl}".`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new OutboundGuardError(
      'DISALLOWED_OUTBOUND_SCHEME',
      rawUrl,
      `Outbound protocol "${parsed.protocol}" is forbidden; only http(s) is permitted.`
    );
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new OutboundGuardError(
      'EMBEDDED_CREDENTIALS_FORBIDDEN',
      rawUrl,
      'Outbound URL must not contain embedded credentials.'
    );
  }

  // 1. Unconditional Zero-LLM path check (runs BEFORE hostname/loopback checks — kills M5)
  const pathAndQuery = `${parsed.pathname}${parsed.search}`;
  for (const pattern of FORBIDDEN_LLM_PATH_PATTERNS) {
    if (pattern.test(parsed.pathname) || pattern.test(pathAndQuery)) {
      throw new OutboundGuardError(
        'FORBIDDEN_LLM_ENDPOINT',
        rawUrl,
        `Blocked LLM inference endpoint "${parsed.pathname}" (matched ${pattern}). Product runtime is strictly zero-LLM.`
      );
    }
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const extraHosts = new Set<string>();
  if (options.extraAllowedHosts) {
    for (const h of options.extraAllowedHosts) {
      if (typeof h === 'string' && h.trim()) {
        extraHosts.add(h.trim().toLowerCase().replace(/\.$/, ''));
      }
    }
  }

  // 2. Local loopback handling (strictly limited to local router/ollama model-list & health reads)
  if (LOOPBACK_HOSTS.has(host)) {
    if (options.allowLoopback === false) {
      throw new OutboundGuardError(
        'UNLISTED_OUTBOUND_DOMAIN',
        rawUrl,
        `Loopback host "${host}" is disabled for this outbound guard.`
      );
    }
    if (!extraHosts.has(host) && !ALLOWED_LOOPBACK_PATH_RE.test(parsed.pathname)) {
      throw new OutboundGuardError(
        'UNLISTED_OUTBOUND_DOMAIN',
        rawUrl,
        `Loopback path "${parsed.pathname}" on "${host}" is outside allowed /v1/models and /health endpoints.`
      );
    }
    return { parsed, host };
  }

  // 3. Remote domain allowlist check (kills M5)
  const allowedDomains = options.allowedDomains ?? loadCanonicalAllowedDomains(options.repoRoot);
  const isExtraHost = extraHosts.has(host);
  if (!allowedDomains.has(host) && !isExtraHost) {
    throw new OutboundGuardError(
      'UNLISTED_OUTBOUND_DOMAIN',
      rawUrl,
      `Outbound domain "${host}" is not listed in registry/sources.yaml or registry/providers.yaml.`
    );
  }

  if (parsed.protocol === 'http:' && !(isExtraHost && options.allowInsecureExtraHosts)) {
    throw new OutboundGuardError(
      'DISALLOWED_OUTBOUND_SCHEME',
      rawUrl,
      `Remote outbound domain "${host}" requires https://.`
    );
  }

  return { parsed, host };
}

export function createGuardedFetch(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  options: OutboundGuardOptions = {}
): typeof globalThis.fetch {
  const cachedAllowed = options.allowedDomains ?? loadCanonicalAllowedDomains(options.repoRoot);
  return ((input: FetchInput, init?: RequestInit): Promise<Response> => {
    try {
      const rawUrl = extractRequestUrlString(input);
      assertAllowedOutboundUrl(rawUrl, { ...options, allowedDomains: cachedAllowed });
    } catch (err) {
      return Promise.reject(err);
    }
    return fetchImpl(input, init);
  }) as typeof globalThis.fetch;
}

export interface AccountingFetchSnapshot {
  totalHttpRequests: number;
  domainRequests: Record<string, number>;
}

export function createAccountingFetch(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  options: OutboundGuardOptions = {}
): {
  fetchFn: typeof globalThis.fetch;
  recordHostRequest: (rawUrlOrHost: string) => void;
  snapshot: () => AccountingFetchSnapshot;
} {
  const cachedAllowed = options.allowedDomains ?? loadCanonicalAllowedDomains(options.repoRoot);
  const domainCounts = new Map<string, number>();
  let totalHttpRequests = 0;

  function recordHost(host: string): void {
    const clean = host.trim().toLowerCase().replace(/\.$/, '');
    if (!clean) return;
    totalHttpRequests += 1;
    domainCounts.set(clean, (domainCounts.get(clean) ?? 0) + 1);
  }

  const guardedFetch = ((input: FetchInput, init?: RequestInit): Promise<Response> => {
    try {
      const rawUrl = extractRequestUrlString(input);
      const { host } = assertAllowedOutboundUrl(rawUrl, {
        ...options,
        allowedDomains: cachedAllowed,
      });
      recordHost(host);
    } catch (err) {
      return Promise.reject(err);
    }
    return fetchImpl(input, init);
  }) as typeof globalThis.fetch;

  return {
    fetchFn: guardedFetch,
    recordHostRequest(rawUrlOrHost: string) {
      try {
        const u = new URL(rawUrlOrHost);
        recordHost(u.hostname);
      } catch {
        recordHost(rawUrlOrHost);
      }
    },
    snapshot(): AccountingFetchSnapshot {
      return {
        totalHttpRequests,
        domainRequests: Object.fromEntries(
          [...domainCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        ),
      };
    },
  };
}
