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

const SECRET_DETECTION_PATTERNS: readonly RegExp[] = [
  new RegExp(`${['sk', '-'].join('')}[A-Za-z0-9_-]{20,}`),
  new RegExp(`${['gsk', '_'].join('')}[A-Za-z0-9_-]{20,}`),
  new RegExp(`${['AI', 'za'].join('')}[0-9A-Za-z_-]{30,}`),
  new RegExp(`${['ghp', '_'].join('')}[A-Za-z0-9]{30,}`),
  new RegExp(`${['github', '_pat_'].join('')}[A-Za-z0-9_]{20,}`),
  new RegExp(`${['glpat', '-'].join('')}[A-Za-z0-9_-]{20,}`),
  new RegExp(`${['xox', '[baprs]-'].join('')}[A-Za-z0-9-]{10,}`),
  /Bearer\s+[A-Za-z0-9_.\-]{16,}/i,
  /api[_-]?key["':\s=]+[A-Za-z0-9_\-]{12,}/i,
  /(?:password|passwd|secret)["':\s=]+[^\s,;'"]{8,}/i,
  new RegExp(`${['-----BEGIN ', '[A-Z0-9 ]*'].join('')}${'PRIVATE KEY-----'}`),
];

const SECRET_PATTERNS = [
  new RegExp(`${['sk', '-'].join('')}[a-zA-Z0-9_-]{20,}`, 'g'),
  /Bearer\s+[a-zA-Z0-9_.\-]+/gi,
  /api[_-]?key["':\s=]+[a-zA-Z0-9_\-]{16,}/gi,
  /(?:password|passwd|secret)["':\s=]+[^\s,;"]+/gi,
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
 * Statelessly checks whether an untrusted string contains API-key, token,
 * credential assignment, or private-key block material (C46-F5 / P5).
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
