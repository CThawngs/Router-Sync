/**
 * packages/core/src/research/domain-registry.ts
 *
 * C45-WP3 Part 1.1: Official Provider Domain Registry & Anti-Spoofing URL Verifier
 * (Serves: S1, S3, S7).
 *
 * Enforces:
 *  - Canonical provider alias resolution across 20+ vendor families
 *  - Strict HTTPS-only scheme, <= 2048 length, no credentials, no custom ports,
 *    no localhost/.local/.internal, and no IPv4/IPv6/integer literals
 *  - Exact host boundary match (host === d || host.endsWith('.' + d))
 *  - Server-computed sourceTier ('official' | 'secondary') with SPOOFED_OFFICIAL_DOMAIN
 *    hard rejection when caller claims 'official' on a non-official host
 */

export type ResearchSourceTier = 'official' | 'secondary';

export type ResearchValidationErrorCode =
  | 'INVALID_URL'
  | 'INSECURE_URL_SCHEME'
  | 'DISALLOWED_URL_AUTHORITY'
  | 'SPOOFED_OFFICIAL_DOMAIN'
  | 'SECRET_DETECTED_IN_EVIDENCE'
  | 'SCHEMA_VALIDATION_ERROR';

export class ResearchValidationError extends Error {
  readonly code: ResearchValidationErrorCode;

  constructor(code: ResearchValidationErrorCode, message: string) {
    super(message);
    this.name = 'ResearchValidationError';
    this.code = code;
  }
}

export const RESEARCH_PROVIDER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  oai: 'openai',
  claude: 'anthropic',
  google: 'gemini',
  grok: 'xai',
  or: 'openrouter',
  hf: 'huggingface',
  togetherai: 'together',
  'fireworks-ai': 'fireworks',
  nv: 'nvidia',
  alibaba: 'qwen',
  dashscope: 'qwen',
  kimi: 'moonshot',
  glm: 'zhipu',
});

export const OFFICIAL_PROVIDER_DOMAINS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  openai: ['openai.com'],
  anthropic: ['anthropic.com', 'claude.com'],
  gemini: ['ai.google.dev', 'cloud.google.com', 'developers.googleblog.com', 'blog.google'],
  deepseek: ['deepseek.com'],
  xai: ['x.ai'],
  mistral: ['mistral.ai'],
  groq: ['groq.com'],
  openrouter: ['openrouter.ai'],
  huggingface: ['huggingface.co'],
  nvidia: ['nvidia.com'],
  cohere: ['cohere.com'],
  cerebras: ['cerebras.ai'],
  sambanova: ['sambanova.ai'],
  fireworks: ['fireworks.ai'],
  together: ['together.ai', 'together.xyz'],
  perplexity: ['perplexity.ai'],
  qwen: ['aliyun.com', 'alibabacloud.com', 'qwenlm.github.io'],
  alibaba: ['aliyun.com', 'alibabacloud.com', 'qwenlm.github.io'],
  dashscope: ['aliyun.com', 'alibabacloud.com', 'qwenlm.github.io'],
  minimax: ['minimax.io', 'minimaxi.com'],
  moonshot: ['moonshot.ai', 'moonshot.cn'],
  kimi: ['moonshot.ai', 'moonshot.cn'],
  zhipu: ['bigmodel.cn', 'z.ai'],
  glm: ['bigmodel.cn', 'z.ai'],
});

export function canonicalizeResearchProvider(rawProvider: string): string {
  const cleaned = rawProvider.trim().toLowerCase();
  return RESEARCH_PROVIDER_ALIASES[cleaned] ?? cleaned;
}

export interface DomainVerificationResult {
  canonicalProvider: string;
  normalizedUrl: string;
  host: string;
  isOfficial: boolean;
  domainVerified: boolean;
  matchedOfficialDomain: string | null;
  sourceTier: ResearchSourceTier;
}

function isIpOrDisallowedHost(host: string): boolean {
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  // IPv6 literal (e.g. [::1])
  if (host.startsWith('[') || host.endsWith(']') || host.includes(':')) {
    return true;
  }
  // IPv4 dotted-quad or numeric/hex integer host
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return true;
  }
  return false;
}

export function verifyProviderSourceDomain(
  provider: string,
  rawUrl: string,
  claimedSourceTier?: ResearchSourceTier
): DomainVerificationResult {
  if (typeof provider !== 'string' || provider.trim().length === 0) {
    throw new ResearchValidationError('SCHEMA_VALIDATION_ERROR', 'Provider must be a non-empty string.');
  }
  if (typeof rawUrl !== 'string') {
    throw new ResearchValidationError('INVALID_URL', 'URL must be a string.');
  }
  const trimmedUrl = rawUrl.trim();
  if (trimmedUrl.length === 0 || trimmedUrl.length > 2048) {
    throw new ResearchValidationError(
      'INVALID_URL',
      `URL length must be between 1 and 2048 characters (received ${trimmedUrl.length}).`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    throw new ResearchValidationError('INVALID_URL', `Malformed URL: "${trimmedUrl}".`);
  }

  if (parsed.protocol !== 'https:') {
    throw new ResearchValidationError(
      'INSECURE_URL_SCHEME',
      `Disallowed URL protocol "${parsed.protocol}"; only "https:" is permitted.`
    );
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new ResearchValidationError(
      'DISALLOWED_URL_AUTHORITY',
      'URL must not contain embedded credentials (username/password).'
    );
  }

  if (parsed.port !== '' && parsed.port !== '443') {
    throw new ResearchValidationError(
      'DISALLOWED_URL_AUTHORITY',
      `URL port "${parsed.port}" is disallowed; only default HTTPS port 443 is permitted.`
    );
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (isIpOrDisallowedHost(host)) {
    throw new ResearchValidationError(
      'DISALLOWED_URL_AUTHORITY',
      `Disallowed URL host "${host}" (localhost, private suffix, or IP literal).`
    );
  }

  const canonicalProvider = canonicalizeResearchProvider(provider);
  const allowedDomains = OFFICIAL_PROVIDER_DOMAINS[canonicalProvider] ?? [];
  const matchedOfficialDomain =
    allowedDomains.find((domain) => host === domain || host.endsWith(`.${domain}`)) ?? null;
  const isOfficial = matchedOfficialDomain !== null;

  if (claimedSourceTier === 'official' && !isOfficial) {
    throw new ResearchValidationError(
      'SPOOFED_OFFICIAL_DOMAIN',
      `Host "${host}" is not a registered official domain for provider "${canonicalProvider}".`
    );
  }

  const sourceTier: ResearchSourceTier = isOfficial ? 'official' : 'secondary';

  return {
    canonicalProvider,
    normalizedUrl: parsed.toString(),
    host,
    isOfficial,
    domainVerified: isOfficial,
    matchedOfficialDomain,
    sourceTier,
  };
}
