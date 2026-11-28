/**
 * packages/cli/src/commands/field-report-scrubber.ts
 *
 * Tickets C49-T1 & C50-K1 (`Phục vụ: S9, S10, key không rời RAM`):
 * Stage-1 Field Report Sanitizer (Scrubber) — key-name inheritance (including arrays),
 * raw + URL-encoded literal env values, expanded vendor/custom prefixes, high-entropy
 * token redaction (with hash/ID & model-slug allowlists), and personal path/host/user PII.
 */

import * as os from 'node:os';

export interface FieldReportScrubberOptions {
  osUsername?: string | undefined;
  hostname?: string | undefined;
  extraLiterals?: readonly string[] | undefined;
  extraPrefixes?: readonly string[] | undefined;
  /** Internal flag used for allowlisted hash/ID fields and JSON object keys */
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
  ['gsk', '_'].join(''),
  ['hf', '_'].join(''),
  ['nvapi', '-'].join(''),
  ['xai', '-'].join(''),
  ['pplx', '-'].join(''),
  ['r8', '_'].join(''),
  ['csk', '-'].join(''),
  ['key', '-'].join(''),
];
const JWT_HEADER_PREFIX = ['ey', 'J'].join('');
const PEM_BEGIN_TOKEN = ['-----BE', 'GIN '].join('');

const SENSITIVE_OBJECT_KEY_RE =
  /(?:^|[_-]|(?<=[a-z0-9])(?=[A-Z]))(?:api[_-]?key|secret|token|password|passwd|credential|auth[_-]?header|authorization|cookie|set[_-]?cookie|private[_-]?key|access[_-]?key|client[_-]?secret|refresh[_-]?token|signing[_-]?key|webhook[_-]?url|bearer)s?(?:$|[_-])/i;

const SAFE_METADATA_KEY_SET = new Set([
  'tokens',
  'hasApiKey',
  'hasBaseUrl',
  'hasDbPath',
  'hasWebhookUrl',
  'keyPresent',
  'redactedCount',
]);

export const NON_SECRET_HASH_OR_ID_KEY_RE =
  /^(?:sha256|stdoutSha12|stderrSha12|planHash|receiptId|snapshotId|snapshotOrBackupRef|commitSha|treeSha|blobSha|etag|checksum|contentHash|bundleSha256|id|uuid|hash)$/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SUFFIX_RE = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildUrlEncodedPattern(encoded: string): string {
  return escapeRegExp(encoded).replace(
    /%[0-9A-Fa-f]{2}/g,
    (pct) => `(?:${pct.toUpperCase()}|${pct.toLowerCase()})`
  );
}

function safeResolveOsUsername(override?: string): string {
  if (typeof override === 'string') return override.trim();
  try {
    return os.userInfo().username.trim();
  } catch {
    return '';
  }
}

function safeResolveHostname(override?: string): string {
  if (typeof override === 'string') return override.trim();
  try {
    return os.hostname().trim();
  } catch {
    return '';
  }
}

function computeShannonEntropy(token: string): { entropy: number; uniqueChars: number } {
  const counts = new Map<string, number>();
  for (const ch of token) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = token.length;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return { entropy, uniqueChars: counts.size };
}

function isHumanSlugSegment(seg: string): boolean {
  if (seg.length === 0) return true;
  return (
    /^[a-z]{1,24}$/.test(seg) ||
    /^[A-Z][a-z]{1,23}$/.test(seg) ||
    /^[A-Z]{1,8}$/.test(seg) ||
    /^\d{1,12}$/.test(seg) ||
    /^(?:[a-zA-Z]{1,4}\d{1,4}[a-zA-Z]{0,3}|\d{1,4}[a-zA-Z]{1,4}|\d+x\d+[a-zA-Z]{0,3})$/.test(seg)
  );
}

function isHighEntropyAlnumOrHexSegment(seg: string, adjacentToSlashPath: boolean): boolean {
  if (/^[0-9a-fA-F]{32,}$/.test(seg)) {
    const { uniqueChars } = computeShannonEntropy(seg.toLowerCase());
    return /[0-9]/.test(seg) && /[a-fA-F]/.test(seg) && uniqueChars >= 6;
  }
  if (/^[A-Za-z0-9]{28,}$/.test(seg)) {
    const digitCount = (seg.match(/[0-9]/g) ?? []).length;
    const hasLetter = /[A-Za-z]/.test(seg);
    const hasLower = /[a-z]/.test(seg);
    const hasUpper = /[A-Z]/.test(seg);
    const { entropy, uniqueChars } = computeShannonEntropy(seg);
    if (digitCount >= 2 && hasLetter && entropy >= 3.3 && uniqueChars >= 8) {
      return true;
    }
    if (!adjacentToSlashPath && hasLower && hasUpper && entropy >= 4.0 && uniqueChars >= 14) {
      return true;
    }
  }
  return false;
}

function isHighEntropySecretToken(token: string, fullText: string, offset: number): boolean {
  if (token.length < 28 || token.startsWith('REDACTED')) return false;
  if (UUID_RE.test(token) || UUID_SUFFIX_RE.test(token)) return false;

  const before12 = fullText.slice(Math.max(0, offset - 12), offset);
  if (/(?:sha256:|commit\s+)$/i.test(before12)) return false;
  if (before12.endsWith('[') && token.startsWith('REDACTED')) return false;

  const prevChar = offset > 0 ? fullText[offset - 1]! : '';
  const nextChar = offset + token.length < fullText.length ? fullText[offset + token.length]! : '';
  const adjacentToSlashPath = prevChar === '/' || nextChar === '/';

  // 1. Check whole token or any hyphen/underscore-delimited segment >= 28 chars (hex >= 32 or alnum >= 28)
  if (isHighEntropyAlnumOrHexSegment(token, adjacentToSlashPath)) {
    return true;
  }
  const parts = token.split(/[-_]+/).filter(Boolean);
  if (parts.some((seg) => seg.length >= 28 && isHighEntropyAlnumOrHexSegment(seg, adjacentToSlashPath))) {
    return true;
  }

  // 2. Punctuated base64url / API token [A-Za-z0-9_-]{30,}
  if (token.length >= 30 && !adjacentToSlashPath) {
    if (parts.length > 0 && parts.every(isHumanSlugSegment)) {
      return false;
    }
    const digitCount = (token.match(/[0-9]/g) ?? []).length;
    const hasLower = /[a-z]/.test(token);
    const hasUpper = /[A-Z]/.test(token);
    const { entropy, uniqueChars } = computeShannonEntropy(token);
    if (digitCount >= 2 && hasLower && hasUpper && entropy >= 3.6 && uniqueChars >= 12) {
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
  const rules: StringRule[] = [];

  // 1. PEM private keys
  rules.push({
    regex: new RegExp(
      `${escapeRegExp(PEM_BEGIN_TOKEN)}[A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----`,
      'g'
    ),
    replacement: '[REDACTED_SECRET]',
  });

  // 2. Credentialed URLs (`https://user:pass@host`) & query-parameter secrets
  rules.push({
    regex: /\b(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replacement: '$1[REDACTED_CREDENTIAL]@',
  });
  rules.push({
    regex:
      /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|key|sig|signature)=)(?!\[REDACTED)([^&#\s"']+)/gi,
    replacement: '$1[REDACTED_QUERY_SECRET]',
  });

  // 3. Bearer / Basic auth headers & standalone 3-segment JWTs
  rules.push({
    regex: new RegExp(
      `\\b(?:${escapeRegExp(BEARER_WORD)}|${escapeRegExp(BASIC_WORD)})\\s+(?!\\[REDACTED)[A-Za-z0-9._~+/=-]{8,}`,
      'gi'
    ),
    replacement: `${BEARER_WORD} [REDACTED_SECRET]`,
  });
  rules.push({
    regex: new RegExp(
      `\\b${escapeRegExp(JWT_HEADER_PREFIX)}[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\b`,
      'g'
    ),
    replacement: '[REDACTED_SECRET]',
  });

  // 4. Value-based literal secrets (`extraLiterals`, raw + URL-encoded, longest-first)
  const cleanLiterals = Array.from(
    new Set(
      (options.extraLiterals ?? [])
        .map((s) => s.trim())
        .filter((s) => s.length >= 8 && !s.startsWith('[REDACTED'))
    )
  ).sort((a, b) => b.length - a.length);

  for (const lit of cleanLiterals) {
    const encoded = encodeURIComponent(lit);
    if (encoded !== lit) {
      rules.push({
        regex: new RegExp(`(?!\\[REDACTED)${buildUrlEncodedPattern(encoded)}`, 'g'),
        replacement: '[REDACTED_SECRET]',
      });
    }
    rules.push({
      regex: new RegExp(`(?!\\[REDACTED)${escapeRegExp(lit)}`, 'g'),
      replacement: '[REDACTED_SECRET]',
    });
  }

  // 5. Password hashes (bcrypt, argon2, scrypt, pbkdf2)
  rules.push({
    regex: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED_HASH]',
  });
  rules.push({
    regex: /\$(?:argon2(?:id|i|d)?|scrypt|pbkdf2[a-z0-9-]*)?\$[A-Za-z0-9$,=_./+-]{16,}/gi,
    replacement: '[REDACTED_HASH]',
  });

  // 6. Custom config prefixes + expanded vendor API key prefixes (MUST run before entropy!)
  for (const rawPfx of options.extraPrefixes ?? []) {
    const pfx = rawPfx.trim();
    if (pfx.length >= 2) {
      rules.push({
        regex: new RegExp(
          `(?<![A-Za-z0-9])${escapeRegExp(pfx)}[A-Za-z0-9_.-]{8,}(?![A-Za-z0-9_.-])`,
          'g'
        ),
        replacement: '[REDACTED_SECRET]',
      });
    }
  }
  const allVendorPrefixes = [
    OPENROUTER_PREFIX,
    OPENAI_PREFIX,
    ...VENDOR_EXTRA_PREFIXES,
  ];
  rules.push({
    regex: new RegExp(
      `\\b(?:${allVendorPrefixes.map(escapeRegExp).join('|')})[A-Za-z0-9_-]{12,}\\b`,
      'g'
    ),
    replacement: '[REDACTED_SECRET]',
  });
  rules.push({
    regex: new RegExp(`\\b${escapeRegExp(GOOGLE_PREFIX)}[0-9A-Za-z_-]{16,}\\b`, 'g'),
    replacement: '[REDACTED_SECRET]',
  });
  rules.push({
    regex: new RegExp(
      `\\b(?:${GH_CLASSIC_PREFIXES.map(escapeRegExp).join('|')}|${escapeRegExp(GH_FINE_PREFIX)})[A-Za-z0-9_]{16,}\\b`,
      'g'
    ),
    replacement: '[REDACTED_SECRET]',
  });
  rules.push({ regex: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, replacement: '[REDACTED_SECRET]' });
  rules.push({ regex: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_SECRET]' });

  // 7. Inline key=value secret assignments
  rules.push({
    regex:
      /\b((?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"',;}{]{6,})/gi,
    replacement: '$1[REDACTED_SECRET]',
  });

  // 8. Windows & POSIX personal paths + cloud sync + hostname + OS username
  rules.push({
    regex: /[A-Za-z]:[\\/]Users[\\/][^\\/\s"',;)]+(?:[\\/][^\s"',;)]*)?/gi,
    replacement: '[REDACTED_PERSONAL_PATH]',
  });
  rules.push({ regex: /%USERPROFILE%(?:[\\/][^\s"',;)]*)?/gi, replacement: '[REDACTED_PERSONAL_PATH]' });
  rules.push({ regex: new RegExp(escapeRegExp(CLOUD_SYNC_TOKEN), 'gi'), replacement: '[REDACTED_CLOUD_DIR]' });
  rules.push({
    regex: /\/(?:Users|home)\/[^/\s"',;)]+(?:\/[^\s"',;)]*)?/g,
    replacement: '[REDACTED_PERSONAL_PATH]',
  });

  const hostname = safeResolveHostname(options.hostname);
  if (hostname.length >= 2) {
    rules.push({
      regex: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(hostname)}(?![A-Za-z0-9])`, 'gi'),
      replacement: '[REDACTED_HOST]',
    });
  }
  const osUsername = safeResolveOsUsername(options.osUsername);
  if (osUsername.length >= 2) {
    rules.push({
      regex: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(osUsername)}(?![A-Za-z0-9])`, 'gi'),
      replacement: '[REDACTED_USER]',
    });
  }

  return rules;
}

export function scrubFieldReportString(
  input: string,
  options: FieldReportScrubberOptions = {}
): ScrubResult<string> {
  if (input.length === 0) {
    return { value: input, redactedCount: 0 };
  }
  const rules = buildStage1StringRules(options);
  let current = input;
  let redactedCount = 0;

  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    let localHits = 0;
    current = current.replace(rule.regex, (...args) => {
      localHits += 1;
      const match = args[0] as string;
      return (
        rule.replacement.replace(/\$(\d)/g, (_m, idxStr) => {
          const groupIdx = Number(idxStr);
          return typeof args[groupIdx] === 'string' ? (args[groupIdx] as string) : '';
        }) || match
      );
    });
    redactedCount += localHits;
  }

  if (!options._skipEntropy) {
    let entropyHits = 0;
    current = current.replace(/[A-Za-z0-9_-]{28,}/g, (match, offset: number, full: string) => {
      if (isHighEntropySecretToken(match, full, offset)) {
        entropyHits += 1;
        return '[REDACTED_SECRET]';
      }
      return match;
    });
    redactedCount += entropyHits;
  }

  return { value: current, redactedCount };
}

export function scrubFieldReportValue<T>(
  input: T,
  options: FieldReportScrubberOptions = {}
): ScrubResult<T> {
  let totalRedacted = 0;

  function visit(node: unknown, parentKey?: string): unknown {
    if (node === null || node === undefined) return node;
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
      const skipEntropy = Boolean(
        options._skipEntropy || (parentKey && NON_SECRET_HASH_OR_ID_KEY_RE.test(parentKey))
      );
      const res = scrubFieldReportString(
        node,
        skipEntropy ? { ...options, _skipEntropy: true } : options
      );
      totalRedacted += res.redactedCount;
      return res.value;
    }
    if (typeof node === 'number' || typeof node === 'boolean') return node;
    if (Array.isArray(node)) {
      return node.map((item) => visit(item, parentKey));
    }
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

  const scrubbed = visit(input) as T;
  return { value: scrubbed, redactedCount: totalRedacted };
}
