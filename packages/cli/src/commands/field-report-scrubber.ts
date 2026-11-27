/**
 * packages/cli/src/commands/field-report-scrubber.ts
 *
 * Ticket C49-T1 (`Phục vụ: S9, S10`): Stage-1 Field Report Sanitizer (Scrubber).
 *
 * Redacts credentials, API tokens, JWTs, password hashes, credentialed URLs,
 * query-string secrets, Windows/POSIX personal home paths, cloud-sync folder names,
 * OS login username, and machine hostname from structured values and strings.
 */

import * as os from 'node:os';

export interface FieldReportScrubberOptions {
  osUsername?: string | undefined;
  hostname?: string | undefined;
  extraLiterals?: readonly string[] | undefined;
}

export interface ScrubResult<T> {
  value: T;
  redactedCount: number;
}

const CLOUD_SYNC_TOKEN = ['One', 'Drive'].join('');
const BEARER_WORD = ['Bea', 'rer'].join('');
const BASIC_WORD = ['Ba', 'sic'].join('');
const OPENAI_PREFIX = ['s', 'k-'].join('');
const GOOGLE_PREFIX = ['AI', 'za'].join('');
const GH_CLASSIC_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];
const GH_FINE_PREFIX = ['github', '_pat_'].join('');
const JWT_HEADER_PREFIX = ['ey', 'J'].join('');
const PEM_BEGIN_TOKEN = ['-----BE', 'GIN '].join('');

const SENSITIVE_OBJECT_KEY_RE =
  /(?:^|[_-])(?:api[_-]?key|secret|token|password|passwd|credential|auth[_-]?header|authorization|private[_-]?key|access[_-]?key|client[_-]?secret|signing[_-]?key|webhook[_-]?url)(?:$|[_-])/i;

const SAFE_METADATA_KEY_SET = new Set([
  'tokens',
  'hasApiKey',
  'hasBaseUrl',
  'hasDbPath',
  'hasWebhookUrl',
  'keyPresent',
  'redactedCount',
]);

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

interface StringRule {
  regex: RegExp;
  replacement: string | ((...args: string[]) => string);
}

function buildStage1StringRules(options: FieldReportScrubberOptions = {}): StringRule[] {
  const rules: StringRule[] = [];

  // 1. PEM blocks
  rules.push({
    regex: new RegExp(
      `${escapeRegExp(PEM_BEGIN_TOKEN)}[A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----`,
      'g'
    ),
    replacement: '[REDACTED_SECRET]',
  });

  // 2. Credentialed URLs (`https://user:pass@host`)
  rules.push({
    regex: /\b(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replacement: '$1[REDACTED_CREDENTIAL]@',
  });

  // 3. Query-parameter secrets (`?api_key=...`, `&token=...`)
  rules.push({
    regex:
      /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|key|sig|signature)=)(?!\[REDACTED)([^&#\s"']+)/gi,
    replacement: '$1[REDACTED_QUERY_SECRET]',
  });

  // 4. Bearer / Basic auth headers (including JWTs)
  rules.push({
    regex: new RegExp(
      `\\b(?:${escapeRegExp(BEARER_WORD)}|${escapeRegExp(BASIC_WORD)})\\s+(?!\\[REDACTED)[A-Za-z0-9._~+/=-]{8,}`,
      'gi'
    ),
    replacement: `${BEARER_WORD} [REDACTED_SECRET]`,
  });

  // 5. Standalone 3-segment JWTs
  rules.push({
    regex: new RegExp(
      `\\b${escapeRegExp(JWT_HEADER_PREFIX)}[A-Za-z0-9_-]{6,}\\.${escapeRegExp(JWT_HEADER_PREFIX)}[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\b`,
      'g'
    ),
    replacement: '[REDACTED_SECRET]',
  });

  // 6. Password hashes (bcrypt $2a$/$2b$/$2y$, argon2, scrypt, pbkdf2)
  rules.push({
    regex: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED_HASH]',
  });
  rules.push({
    regex: /\$(?:argon2(?:id|i|d)?|scrypt|pbkdf2[a-z0-9-]*)?\$[A-Za-z0-9$,=_./+-]{16,}/gi,
    replacement: '[REDACTED_HASH]',
  });

  // 7. Vendor & platform API keys (OpenAI, Anthropic, Google, GitHub, Slack, AWS)
  rules.push({
    regex: new RegExp(`\\b${escapeRegExp(OPENAI_PREFIX)}[A-Za-z0-9_-]{12,}\\b`, 'g'),
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
  rules.push({
    regex: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g,
    replacement: '[REDACTED_SECRET]',
  });
  rules.push({
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_SECRET]',
  });

  // 8. Inline key=value secret assignments in free text
  rules.push({
    regex:
      /\b((?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"',;}{]{6,})/gi,
    replacement: '$1[REDACTED_SECRET]',
  });

  // 9. Windows & POSIX personal home directories + cloud sync directories
  rules.push({
    regex: /[A-Za-z]:[\\/]Users[\\/][^\\/\s"',;)]+(?:[\\/][^\s"',;)]*)?/gi,
    replacement: '[REDACTED_PERSONAL_PATH]',
  });
  rules.push({
    regex: /%USERPROFILE%(?:[\\/][^\s"',;)]*)?/gi,
    replacement: '[REDACTED_PERSONAL_PATH]',
  });
  rules.push({
    regex: new RegExp(escapeRegExp(CLOUD_SYNC_TOKEN), 'gi'),
    replacement: '[REDACTED_CLOUD_DIR]',
  });
  rules.push({
    regex: /\/(?:Users|home)\/[^/\s"',;)]+(?:\/[^\s"',;)]*)?/g,
    replacement: '[REDACTED_PERSONAL_PATH]',
  });

  // 10. Current machine hostname & OS login username (token-bounded so camelCase keys stay intact)
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

  for (const extra of options.extraLiterals ?? []) {
    const clean = extra.trim();
    if (clean.length >= 3) {
      rules.push({
        regex: new RegExp(escapeRegExp(clean), 'gi'),
        replacement: '[REDACTED_PRIVATE]',
      });
    }
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
      if (typeof rule.replacement === 'function') {
        return rule.replacement(...(args as string[]));
      }
      const match = args[0] as string;
      // Preserve capture-group replacements ($1, $2) safely
      return rule.replacement.replace(/\$(\d)/g, (_m, idxStr) => {
        const groupIdx = Number(idxStr);
        return typeof args[groupIdx] === 'string' ? (args[groupIdx] as string) : '';
      }) || match;
    });
    redactedCount += localHits;
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
      const res = scrubFieldReportString(node, options);
      totalRedacted += res.redactedCount;
      return res.value;
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((item) => visit(item));
    }
    if (typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [rawKey, rawVal] of Object.entries(node as Record<string, unknown>)) {
        const keyScrub = scrubFieldReportString(rawKey, options);
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
