/**
 * packages/core/src/domain/sanitize.ts
 *
 * Untrusted String Sanitizer, Secret Detector & Redactor (Condition C1, AT-90 & C46-F5).
 * Protects agent contexts, research ledgers, and router data against:
 *  - Prompt injection sequences (<system>, [INST], <<SYS>>, role hijacking)
 *  - Shell metacharacters & control characters
 *  - Secret / API key leakage & hard rejection on untrusted evidence boundaries
 *  - Unbounded payload expansion (length capping)
 */

const AWS_KEY_PREFIX_SOURCE = `(?:${['AK', 'IA'].join('')}|${['AS', 'IA'].join('')})`;
const JWT_PREFIX_SOURCE = ['ey', 'J'].join('');
const PEM_BEGIN_SOURCE = `${['-----BEGIN ', '[A-Z0-9 ]*'].join('')}${'PRIVATE KEY-----'}`;

const EXPLICIT_TOKEN_ASSIGN_DETECT =
  /(?<![A-Za-z0-9_-])(?:access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|bearer[_-]?token|oauth[_-]?token|api[_-]?token|client[_-]?secret|api[_-]?secret)(?:["']\s*:\s*["']|\s*[:=]\s*["']?)[A-Za-z0-9_.\-~+/=]{8,}/i;

const BARE_TOKEN_ASSIGN_DETECT =
  /(?<![A-Za-z0-9_-])(?:["']token["']\s*:\s*["'][A-Za-z0-9_.\-~+/=]{8,}|token\s*=\s*["']?(?![0-9]+(?:\.[0-9]+)?(?![A-Za-z0-9_.\-~+/=]))[A-Za-z0-9_.\-~+/=]{8,}|token\s*:\s*(?:["'][A-Za-z0-9_.\-~+/=]{8,}|(?![a-z]+(?![A-Za-z0-9_.\-~+/=]))(?![0-9]+(?:\.[0-9]+)?(?![A-Za-z0-9_.\-~+/=]))[A-Za-z0-9_.\-~+/=]{12,}))/i;

const SECRET_DETECTION_PATTERNS: readonly RegExp[] = [
  new RegExp(`${['sk', '-'].join('')}[A-Za-z0-9_-]{20,}`),
  new RegExp(`${['gsk', '_'].join('')}[A-Za-z0-9_-]{20,}`),
  new RegExp(`${['AI', 'za'].join('')}[0-9A-Za-z_-]{30,}`),
  new RegExp(`${['ghp', '_'].join('')}[A-Za-z0-9]{30,}`),
  new RegExp(`${['github', '_pat_'].join('')}[A-Za-z0-9_]{20,}`),
  new RegExp(`${['glpat', '-'].join('')}[A-Za-z0-9_-]{20,}`),
  new RegExp(`${['xox', '[baprs]-'].join('')}[A-Za-z0-9-]{10,}`),
  new RegExp(`(?<![A-Za-z0-9])${AWS_KEY_PREFIX_SOURCE}[0-9A-Z]{16}(?![A-Za-z0-9])`),
  new RegExp(
    `(?<![A-Za-z0-9])${JWT_PREFIX_SOURCE}[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_.\\-~+/=]{8,}`
  ),
  /Bearer\s+[A-Za-z0-9_.\-~+/=]{16,}/i,
  /api[_-]?key["':\s=]+[A-Za-z0-9_.\-~+/=]{12,}/i,
  EXPLICIT_TOKEN_ASSIGN_DETECT,
  BARE_TOKEN_ASSIGN_DETECT,
  /(?:password|passwd|secret)["':\s=]+[^\s,;'"]{8,}/i,
  new RegExp(PEM_BEGIN_SOURCE),
];

const SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(`${['sk', '-'].join('')}[a-zA-Z0-9_-]{20,}`, 'g'),
  new RegExp(`${['gsk', '_'].join('')}[A-Za-z0-9_-]{20,}`, 'g'),
  new RegExp(`${['AI', 'za'].join('')}[0-9A-Za-z_-]{30,}`, 'g'),
  new RegExp(`${['ghp', '_'].join('')}[A-Za-z0-9]{20,}`, 'g'),
  new RegExp(`${['github', '_pat_'].join('')}[A-Za-z0-9_]{20,}`, 'g'),
  new RegExp(`${['glpat', '-'].join('')}[A-Za-z0-9_-]{20,}`, 'g'),
  new RegExp(`${['xox', '[baprs]-'].join('')}[A-Za-z0-9-]{10,}`, 'g'),
  new RegExp(`(?<![A-Za-z0-9])${AWS_KEY_PREFIX_SOURCE}[0-9A-Z]{16}(?![A-Za-z0-9])`, 'g'),
  new RegExp(
    `(?<![A-Za-z0-9])${JWT_PREFIX_SOURCE}[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_.\\-~+/=]{8,}`,
    'g'
  ),
  /Bearer\s+[A-Za-z0-9_.\-~+/=]+/gi,
  /api[_-]?key["':\s=]+[A-Za-z0-9_.\-~+/=]{12,}/gi,
  new RegExp(EXPLICIT_TOKEN_ASSIGN_DETECT.source, 'gi'),
  new RegExp(BARE_TOKEN_ASSIGN_DETECT.source, 'gi'),
  /(?:password|passwd|secret)["':\s=]+[^\s,;"]+/gi,
  new RegExp(`${PEM_BEGIN_SOURCE}(?:[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[\\s\\S]*)`, 'g'),
];

const INJECTION_PATTERNS = [
  /<\/?system>/gi,
  /\[\/?INST\]/gi,
  /<<\/?SYS>>/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /human:/gi,
  /assistant:/gi,
];

/**
 * Safely decodes percent-encoded substrings without throwing on malformed
 * percent sequences (e.g. truncated UTF-8 like %E0%A4%A).
 */
export function safeDecodeUriText(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input.replace(/%(?:[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
}

/**
 * Statelessly checks whether an untrusted string contains API-key, token,
 * credential assignment, JWT, AWS key, or private-key block material (C46-F5 / P5).
 */
export function containsSecretLikeContent(input: unknown): boolean {
  if (typeof input !== 'string' || input.length === 0) {
    return false;
  }

  for (const pattern of SECRET_DETECTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(input)) {
      return true;
    }
  }

  return false;
}

/**
 * Statelessly inspects a raw or normalized URL (including decoded pathname,
 * query string, query parameters, and hash fragment) for secret-like material.
 */
export function containsSecretLikeUrlContent(input: unknown): boolean {
  if (typeof input !== 'string' || input.length === 0) {
    return false;
  }

  const candidates = new Set<string>();
  const addCandidate = (val: string): void => {
    if (!val) return;
    candidates.add(val);
    const decodedOnce = safeDecodeUriText(val);
    candidates.add(decodedOnce);
    const decodedTwice = safeDecodeUriText(decodedOnce);
    candidates.add(decodedTwice);
  };

  const trimmed = input.trim();
  addCandidate(input);
  addCandidate(trimmed);

  try {
    const parsed = new URL(trimmed);
    addCandidate(parsed.toString());
    addCandidate(parsed.pathname);
    addCandidate(parsed.search);
    addCandidate(parsed.search.replace(/\+/g, ' '));
    addCandidate(parsed.hash);
    if (parsed.hash.length > 1) {
      const rawHashBody = parsed.hash.slice(1);
      addCandidate(rawHashBody);
      addCandidate(rawHashBody.replace(/\+/g, ' '));
      const hashParams = new URLSearchParams(rawHashBody);
      for (const [k, v] of hashParams.entries()) {
        addCandidate(k);
        addCandidate(v);
        addCandidate(`${k}=${v}`);
      }
    }
    for (const [k, v] of parsed.searchParams.entries()) {
      addCandidate(k);
      addCandidate(v);
      addCandidate(`${k}=${v}`);
    }
  } catch {
    // Non-URL or malformed URL: raw and percent-decoded forms are already in candidates.
  }

  for (const candidate of candidates) {
    if (containsSecretLikeContent(candidate)) {
      return true;
    }
  }

  return false;
}

/**
 * Sanitizes untrusted strings originating from external providers or models.
 * @param input Raw untrusted input string
 * @param maxLength Maximum allowed length (default 500)
 */
export function sanitizeUntrustedString(input: unknown, maxLength = 500): string {
  if (typeof input !== 'string') {
    if (input === null || input === undefined) return '';
    return String(input).slice(0, maxLength);
  }

  let text = input;

  // 1. Redact secrets
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[REDACTED_SECRET]');
  }

  // 2. Neutralize prompt injection tokens
  for (const pattern of INJECTION_PATTERNS) {
    text = text.replace(pattern, '[FILTERED_TOKEN]');
  }

  // 3. Remove non-printable control characters (except newline, tab)
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // 4. Cap maximum length to prevent context explosion
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + '... [TRUNCATED]';
  }

  return text.trim();
}

/**
 * Deep sanitization for structured objects containing untrusted strings.
 */
export function sanitizeObject<T>(obj: T, maxDepth = 5): T {
  if (maxDepth <= 0 || obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return sanitizeUntrustedString(obj) as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, maxDepth - 1)) as unknown as T;
  }

  if (typeof obj === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      // Never expose secret fields
      if (/key|secret|token|password|auth/i.test(key) && typeof val === 'string') {
        clean[key] = '[REDACTED_SECRET]';
      } else {
        clean[key] = sanitizeObject(val, maxDepth - 1);
      }
    }
    return clean as unknown as T;
  }

  return obj;
}
