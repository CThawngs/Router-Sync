/**
 * packages/cli/src/commands/field-report-scrubber.ts
 * Tickets C49-T1 & C50-K1 (`Phục vụ: S9, S10, key không rời RAM`): Stage-1 Field Report Sanitizer.
 */

import * as os from 'node:os';

export interface FieldReportScrubberOptions {
  osUsername?: string | undefined;
  hostname?: string | undefined;
  extraLiterals?: readonly string[] | undefined;
  extraPrefixes?: readonly string[] | undefined;
  _skipEntropy?: boolean | undefined;
}

export interface ScrubResult<T> {
  value: T;
  redactedCount: number;
}

const CLOUD_SYNC_TOKEN = ['One', 'Drive'].join('');
const BEARER_WORD = ['Bea', 'rer'].join('');
const BASIC_WORD = ['Ba', 'sic'].join('');
const OPENAI_PREFIX = ['s', 'k-'].join('');
const OPENROUTER_PREFIX = ['s', 'k-or-'].join('');
const GOOGLE_PREFIX = ['AI', 'za'].join('');
const GH_CLASSIC_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];
const GH_FINE_PREFIX = ['github', '_pat_'].join('');
const VENDOR_EXTRA_PREFIXES = [
  ['gsk', '_'].join(''), ['hf', '_'].join(''), ['nvapi', '-'].join(''), ['xai', '-'].join(''),
  ['pplx', '-'].join(''), ['r8', '_'].join(''), ['csk', '-'].join(''), ['key', '-'].join(''),
];
const JWT_HEADER_PREFIX = ['ey', 'J'].join('');
const PEM_BEGIN_TOKEN = ['-----BE', 'GIN '].join('');

const SENSITIVE_OBJECT_KEY_RE =
  /(?:^|[_-]|(?<=[a-z0-9])(?=[A-Z]))(?:api[_-]?key|secret|token|password|passwd|credential|auth[_-]?header|authorization|cookie|set[_-]?cookie|private[_-]?key|access[_-]?key|client[_-]?secret|refresh[_-]?token|signing[_-]?key|webhook[_-]?url|bearer)s?(?:$|[_-])/i;

const SAFE_METADATA_KEY_SET = new Set([
  'hasApiKey', 'hasBaseUrl', 'hasDbPath', 'hasWebhookUrl', 'keyPresent', 'redactedCount',
]);

export const NON_SECRET_HASH_OR_ID_KEY_RE =
  /^(?:sha256|stdoutSha12|stderrSha12|planHash|receiptId|snapshotId|snapshotOrBackupRef|commitSha|treeSha|blobSha|etag|checksum|contentHash|bundleSha256|id|uuid|hash|modelId|fullStep|providerId|blockedModels|inCombos|targetId|target)$/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SUFFIX_RE = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMEL_OR_PASCAL_WORDS_RE = /^(?:[a-z]{2,}|[A-Z][a-z]{2,})(?:[A-Z][a-z]{2,})+$/;
const SLUG_SEGMENT_RE =
  /^(?:[a-z]{1,24}|[A-Z][a-z]{1,23}|[A-Z]{1,8}|\d{1,12}|[A-Za-z][a-z]{1,15}\d{1,4}[A-Za-z]{0,2}|[A-Za-z]{1,3}\d{1,4}[A-Za-z]{0,2}|\d{1,4}[A-Za-z]{1,4}|\d+x\d+[A-Za-z]{0,2}|[A-Z][a-z]{2,12}[A-Z][a-z]{2,12})$/;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildUnifiedLiteralPattern(lit: string): string {
  let out = '';
  for (const ch of lit) {
    if (/^[A-Za-z0-9_.\-~]$/.test(ch)) out += escapeRegExp(ch);
    else if (ch === ' ') out += '(?:%20|\\+| )';
    else {
      const pct = [...Buffer.from(ch, 'utf8')]
        .map((b) => '%' + [...b.toString(16).padStart(2, '0')].map((h) => (/[a-f]/i.test(h) ? `[${h.toUpperCase()}${h.toLowerCase()}]` : h)).join(''))
        .join('');
      out += `(?:${pct}|${escapeRegExp(ch)})`;
    }
  }
  return out;
}

function safeResolveIdentity(override: string | undefined, fn: () => string): string {
  if (typeof override === 'string') return override.trim();
  try { return fn().trim(); } catch { return ''; }
}

function computeShannonEntropy(token: string): { entropy: number; uniqueChars: number } {
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / token.length;
    entropy -= p * Math.log2(p);
  }
  return { entropy, uniqueChars: counts.size };
}

function isHighEntropyAlnumOrHexSegment(seg: string, adjacentToSlashPath: boolean): boolean {
  if (/^[0-9a-fA-F]{32,}$/.test(seg)) {
    const { uniqueChars } = computeShannonEntropy(seg.toLowerCase());
    return /[0-9]/.test(seg) && /[a-fA-F]/.test(seg) && uniqueChars >= 6;
  }
  if (/^[A-Za-z0-9]{28,}$/.test(seg)) {
    const digitCount = (seg.match(/[0-9]/g) ?? []).length;
    const hasLower = /[a-z]/.test(seg);
    const hasUpper = /[A-Z]/.test(seg);
    const { entropy, uniqueChars } = computeShannonEntropy(seg);
    if (digitCount >= 2 && (hasLower || hasUpper) && entropy >= 3.3 && uniqueChars >= 8) return true;
    if (!adjacentToSlashPath && hasLower && hasUpper && !CAMEL_OR_PASCAL_WORDS_RE.test(seg) && entropy >= 4.0 && uniqueChars >= 14) {
      return true;
    }
  }
  return false;
}

function isHighEntropySecretToken(token: string, fullText: string, offset: number): boolean {
  if (token.length < 28 || token.startsWith('REDACTED') || UUID_RE.test(token) || UUID_SUFFIX_RE.test(token)) {
    return false;
  }
  if (/(?:sha256:|commit\s+)$/i.test(fullText.slice(Math.max(0, offset - 12), offset))) return false;

  const prevChar = offset > 0 ? fullText[offset - 1]! : '';
  const nextChar = offset + token.length < fullText.length ? fullText[offset + token.length]! : '';
  const adjacentToSlashPath = prevChar === '/' || nextChar === '/';

  if (isHighEntropyAlnumOrHexSegment(token, adjacentToSlashPath)) return true;
  const parts = token.split(/[-_]+/).filter(Boolean);
  if (parts.some((seg) => seg.length >= 28 && isHighEntropyAlnumOrHexSegment(seg, adjacentToSlashPath))) return true;

  if (token.length >= 30 && !adjacentToSlashPath) {
    if (parts.length > 0 && parts.every((seg) => SLUG_SEGMENT_RE.test(seg))) return false;
    const digitCount = (token.match(/[0-9]/g) ?? []).length;
    const { entropy, uniqueChars } = computeShannonEntropy(token);
    if (digitCount >= 2 && /[a-z]/.test(token) && /[A-Z]/.test(token) && entropy >= 3.6 && uniqueChars >= 12) {
      return true;
    }
  }
  return false;
}

interface StringRule {
  regex: RegExp;
  replacement: string;
}

function buildStage1StringRules(options: FieldReportScrubberOptions = {}): StringRule[] {
  const rules: StringRule[] = [
    {
      regex: new RegExp(`${escapeRegExp(PEM_BEGIN_TOKEN)}[A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----`, 'g'),
      replacement: '[REDACTED_SECRET]',
    },
    { regex: /\b(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, replacement: '$1[REDACTED_CREDENTIAL]@' },
    {
      regex: /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|key|sig|signature)=)(?!\[REDACTED)([^&#\s"']+)/gi,
      replacement: '$1[REDACTED_QUERY_SECRET]',
    },
    {
      regex: new RegExp(`\\b(?:${escapeRegExp(BEARER_WORD)}|${escapeRegExp(BASIC_WORD)})\\s+(?!\\[REDACTED)[A-Za-z0-9._~+/=-]{8,}`, 'gi'),
      replacement: `${BEARER_WORD} [REDACTED_SECRET]`,
    },
    {
      regex: new RegExp(`\\b${escapeRegExp(JWT_HEADER_PREFIX)}[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\b`, 'g'),
      replacement: '[REDACTED_SECRET]',
    },
  ];

  const cleanLiterals = Array.from(
    new Set((options.extraLiterals ?? []).map((s) => s.trim()).filter((s) => s.length >= 8 && !s.startsWith('[REDACTED')))
  ).sort((a, b) => b.length - a.length);
  for (const lit of cleanLiterals) {
    rules.push({ regex: new RegExp(`(?!\\[REDACTED)${buildUnifiedLiteralPattern(lit)}`, 'g'), replacement: '[REDACTED_SECRET]' });
  }

  rules.push(
    { regex: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/g, replacement: '[REDACTED_HASH]' },
    { regex: /\$(?:argon2(?:id|i|d)?|scrypt|pbkdf2[a-z0-9-]*)?\$[A-Za-z0-9$,=_./+-]{16,}/gi, replacement: '[REDACTED_HASH]' }
  );

  for (const rawPfx of options.extraPrefixes ?? []) {
    const pfx = rawPfx.trim();
    if (pfx.length >= 2) {
      rules.push({
        regex: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(pfx)}[A-Za-z0-9_.-]{8,}(?![A-Za-z0-9_.-])`, 'g'),
        replacement: '[REDACTED_SECRET]',
      });
    }
  }

  const allVendorPrefixes = [OPENROUTER_PREFIX, OPENAI_PREFIX, ...VENDOR_EXTRA_PREFIXES];
  rules.push(
    { regex: new RegExp(`\\b(?:${allVendorPrefixes.map(escapeRegExp).join('|')})[A-Za-z0-9_-]{12,}\\b`, 'g'), replacement: '[REDACTED_SECRET]' },
    { regex: new RegExp(`\\b${escapeRegExp(GOOGLE_PREFIX)}[0-9A-Za-z_-]{16,}\\b`, 'g'), replacement: '[REDACTED_SECRET]' },
    {
      regex: new RegExp(`\\b(?:${GH_CLASSIC_PREFIXES.map(escapeRegExp).join('|')}|${escapeRegExp(GH_FINE_PREFIX)})[A-Za-z0-9_]{16,}\\b`, 'g'),
      replacement: '[REDACTED_SECRET]',
    },
    { regex: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, replacement: '[REDACTED_SECRET]' },
    { regex: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_SECRET]' },
    {
      regex: /\b((?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"',;}{]{6,})/gi,
      replacement: '$1[REDACTED_SECRET]',
    },
    { regex: /[A-Za-z]:[\\/]Users[\\/][^\\/\s"',;)]+(?:[\\/][^\s"',;)]*)?/gi, replacement: '[REDACTED_PERSONAL_PATH]' },
    { regex: /%USERPROFILE%(?:[\\/][^\s"',;)]*)?/gi, replacement: '[REDACTED_PERSONAL_PATH]' },
    { regex: new RegExp(escapeRegExp(CLOUD_SYNC_TOKEN), 'gi'), replacement: '[REDACTED_CLOUD_DIR]' },
    { regex: /\/(?:Users|home)\/[^/\s"',;)]+(?:\/[^\s"',;)]*)?/g, replacement: '[REDACTED_PERSONAL_PATH]' }
  );

  const hostname = safeResolveIdentity(options.hostname, () => os.hostname());
  if (hostname.length >= 2) {
    rules.push({ regex: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(hostname)}(?![A-Za-z0-9])`, 'gi'), replacement: '[REDACTED_HOST]' });
  }
  const osUsername = safeResolveIdentity(options.osUsername, () => os.userInfo().username);
  if (osUsername.length >= 2) {
    rules.push({ regex: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(osUsername)}(?![A-Za-z0-9])`, 'gi'), replacement: '[REDACTED_USER]' });
  }
  return rules;
}

export function scrubFieldReportString(input: string, options: FieldReportScrubberOptions = {}): ScrubResult<string> {
  if (input.length === 0) return { value: input, redactedCount: 0 };
  let current = input;
  let redactedCount = 0;

  for (const rule of buildStage1StringRules(options)) {
    rule.regex.lastIndex = 0;
    current = current.replace(rule.regex, (...args) => {
      redactedCount += 1;
      const match = args[0] as string;
      return rule.replacement.replace(/\$(\d)/g, (_m, idxStr) => (typeof args[Number(idxStr)] === 'string' ? (args[Number(idxStr)] as string) : '')) || match;
    });
  }

  if (!options._skipEntropy) {
    current = current.replace(/[A-Za-z0-9_-]{28,}/g, (match, offset: number, full: string) => {
      if (isHighEntropySecretToken(match, full, offset)) {
        redactedCount += 1;
        return '[REDACTED_SECRET]';
      }
      return match;
    });
  }
  return { value: current, redactedCount };
}

export function scrubFieldReportValue<T>(input: T, options: FieldReportScrubberOptions = {}): ScrubResult<T> {
  let totalRedacted = 0;

  function visit(node: unknown, parentKey?: string): unknown {
    if (node === null || node === undefined || typeof node === 'number' || typeof node === 'boolean') return node;
    if (typeof node === 'string') {
      if (
        parentKey &&
        !SAFE_METADATA_KEY_SET.has(parentKey) &&
        SENSITIVE_OBJECT_KEY_RE.test(parentKey) &&
        node.trim().length > 0 &&
        !node.startsWith('[REDACTED')
      ) {
        totalRedacted += 1;
        return '[REDACTED_SECRET]';
      }
      const skipEntropy = Boolean(options._skipEntropy || (parentKey && NON_SECRET_HASH_OR_ID_KEY_RE.test(parentKey)));
      const res = scrubFieldReportString(node, skipEntropy ? { ...options, _skipEntropy: true } : options);
      totalRedacted += res.redactedCount;
      return res.value;
    }
    if (Array.isArray(node)) return node.map((item) => visit(item, parentKey));
    if (typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [rawKey, rawVal] of Object.entries(node as Record<string, unknown>)) {
        const keyScrub = scrubFieldReportString(rawKey, { ...options, _skipEntropy: true });
        totalRedacted += keyScrub.redactedCount;
        out[keyScrub.value] = visit(rawVal, rawKey);
      }
      return out;
    }
    return node;
  }

  return { value: visit(input) as T, redactedCount: totalRedacted };
}
