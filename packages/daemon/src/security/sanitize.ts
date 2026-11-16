/**
 * packages/daemon/src/security/sanitize.ts
 *
 * Canary token, credential, and injection sanitization for daemon responses (Condition C1 / AT-120).
 */

const SECRET_PATTERNS = [
  /CANARY_[a-zA-Z0-9_-]+/g,
  /sk-[a-zA-Z0-9_-]{10,}/g,
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
  /(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*['"]?([a-zA-Z0-9_-]{8,})['"]?/gi,
];

// Disallow dangerous control characters that could trigger terminal injection or log forging
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitizeString(val: string): string {
  let cleaned = val.replace(CONTROL_CHAR_PATTERN, '');
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, (match) => {
      if (match.startsWith('CANARY_')) return '[REDACTED_CANARY]';
      if (match.toLowerCase().startsWith('bearer')) return 'Bearer [REDACTED]';
      return '[REDACTED_SECRET]';
    });
  }
  return cleaned;
}

export function sanitizeObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return sanitizeString(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Never serialize raw credential fields
      if (/^(key_value|secret|password|raw_key|token)$/i.test(key)) {
        copy[key] = '[REDACTED]';
      } else {
        copy[key] = sanitizeObject(value);
      }
    }
    return copy as T;
  }
  return obj;
}
