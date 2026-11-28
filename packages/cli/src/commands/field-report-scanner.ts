/**
 * packages/cli/src/commands/field-report-scanner.ts
 * Tickets C49-T1 & C50-K1 (`Phục vụ: S9, S10, key không rời RAM`):
 * Stage-2 Independent Pre-Write Output Scanner (0 imports from Stage 1, 0 vendor prefixes).
 */

import * as os from 'node:os';

export interface FieldReportScannerOptions {
  osUsername?: string | undefined;
  hostname?: string | undefined;
  secretLiterals?: readonly string[] | undefined;
}

export type FieldReportScanRuleCode =
  | 'UNREDACTED_LITERAL_SECRET' | 'UNREDACTED_HIGH_ENTROPY_SECRET' | 'UNREDACTED_PEM_PRIVATE_KEY'
  | 'UNREDACTED_AUTH_BEARER' | 'UNREDACTED_PASSWORD_HASH' | 'UNREDACTED_URL_CREDENTIALS'
  | 'UNREDACTED_WINDOWS_USER_PATH' | 'UNREDACTED_POSIX_HOME_PATH' | 'UNREDACTED_OS_IDENTITY';

export interface FieldReportScanViolation {
  file: string;
  line: number;
  ruleCode: FieldReportScanRuleCode;
}

export interface FieldReportScanSummary {
  clean: boolean;
  violations: FieldReportScanViolation[];
}

const SAFE_SCANNER_KEYS = new Set([
  'hasApiKey', 'hasBaseUrl', 'hasDbPath', 'hasWebhookUrl', 'keyPresent', 'redactedCount',
]);
const SENSITIVE_FIELD_RE =
  /(?:^|[_-]|(?<=[a-z0-9])(?=[A-Z]))(?:api[_-]?keys?|secrets?|passwords?|passwd|tokens?|access[_-]?tokens?|refresh[_-]?tokens?|client[_-]?secrets?|private[_-]?keys?|access[_-]?keys?|authorization|cookies?|set[_-]?cookies?|bearer)(?:$|[_-])/i;
const ALLOWLISTED_HASH_ID_FIELD_RE =
  /^(?:sha256|stdoutSha12|stderrSha12|planHash|receiptId|snapshotId|snapshotOrBackupRef|commitSha|treeSha|blobSha|etag|checksum|contentHash|bundleSha256|id|uuid|hash|modelId|fullStep|providerId|blockedModels|inCombos|targetId|target)$/i;
const STANDARD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRAILING_UUID_RE = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMEL_PASCAL_CHAIN_RE = /^(?:[a-z]{2,}|[A-Z][a-z]{2,})(?:[A-Z][a-z]{2,})+$/;
const MODEL_SLUG_PART_RE =
  /^(?:[a-z]{1,24}|[A-Z][a-z]{1,23}|[A-Z]{1,8}|\d{1,12}|[A-Za-z][a-z]{1,15}\d{1,4}[A-Za-z]{0,2}|[A-Za-z]{1,3}\d{1,4}[A-Za-z]{0,2}|\d{1,4}[A-Za-z]{1,4}|\d+x\d+[A-Za-z]{0,2}|[A-Z][a-z]{2,12}[A-Z][a-z]{2,12})$/;

function isAlphaNum(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTokenChar(ch: string): boolean {
  return isAlphaNum(ch) || ch === '_' || ch === '-';
}

function countRun(text: string, start: number, pred: (ch: string) => boolean): number {
  let idx = start;
  while (idx < text.length && pred(text[idx]!)) idx += 1;
  return idx - start;
}

function shannonBitsPerChar(sample: string): { bits: number; distinct: number } {
  const freq = new Map<string, number>();
  for (let i = 0; i < sample.length; i += 1) freq.set(sample[i]!, (freq.get(sample[i]!) ?? 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const prob = count / sample.length;
    bits -= prob * Math.log2(prob);
  }
  return { bits, distinct: freq.size };
}

function isUnredactedHighEntropySubrun(sub: string): boolean {
  if (sub.length >= 32 && /^[0-9a-fA-F]+$/.test(sub)) {
    const { distinct } = shannonBitsPerChar(sub.toLowerCase());
    return /[0-9]/.test(sub) && /[a-fA-F]/.test(sub) && distinct >= 6;
  }
  if (sub.length >= 28 && /^[A-Za-z0-9]+$/.test(sub)) {
    let digits = 0;
    for (let i = 0; i < sub.length; i += 1) if (sub[i]! >= '0' && sub[i]! <= '9') digits += 1;
    const { bits, distinct } = shannonBitsPerChar(sub);
    if (digits >= 2 && sub.length - digits >= 4 && bits >= 3.3 && distinct >= 8) return true;
    if (/[a-z]/.test(sub) && /[A-Z]/.test(sub) && !CAMEL_PASCAL_CHAIN_RE.test(sub) && bits >= 4.1 && distinct >= 15) {
      return true;
    }
  }
  return false;
}

function textContainsHighEntropySecret(text: string): boolean {
  if (text.length < 28) return false;
  const candidateRe = /[A-Za-z0-9_-]{28,}/g;
  let m: RegExpExecArray | null;
  while ((m = candidateRe.exec(text)) !== null) {
    const tok = m[0];
    const offset = m.index;
    if (tok.startsWith('REDACTED') || STANDARD_UUID_RE.test(tok) || TRAILING_UUID_RE.test(tok)) continue;
    if (/(?:sha256:|commit\s+)$/i.test(text.slice(Math.max(0, offset - 12), offset))) continue;

    const prev = offset > 0 ? text[offset - 1]! : '';
    const next = offset + tok.length < text.length ? text[offset + tok.length]! : '';
    if (prev === '/' || next === '/') continue;

    const subRuns = tok.split(/[-_]+/).filter(Boolean);
    if (subRuns.some((sub) => sub.length >= 28 && isUnredactedHighEntropySubrun(sub))) return true;
    if (!subRuns.every((part) => MODEL_SLUG_PART_RE.test(part))) {
      let digits = 0;
      for (let i = 0; i < tok.length; i += 1) if (tok[i]! >= '0' && tok[i]! <= '9') digits += 1;
      const { bits, distinct } = shannonBitsPerChar(tok);
      if (digits >= 2 && /[a-z]/.test(tok) && /[A-Z]/.test(tok) && bits >= 3.5 && distinct >= 10) return true;
    }
  }
  return false;
}

function collectFlaggedStringsFromValue(node: unknown, fieldKey?: string): string[] {
  const hits: string[] = [];
  function walk(cur: unknown, key?: string): void {
    if (cur === null || cur === undefined) return;
    if (typeof cur === 'string') {
      const trimmed = cur.trim();
      if (!trimmed || trimmed.startsWith('[REDACTED')) return;
      if (key && !SAFE_SCANNER_KEYS.has(key) && SENSITIVE_FIELD_RE.test(key)) {
        hits.push(cur);
        return;
      }
      if (key && ALLOWLISTED_HASH_ID_FIELD_RE.test(key)) return;
      if (textContainsHighEntropySecret(cur)) hits.push(cur);
      return;
    }
    if (Array.isArray(cur)) {
      for (const item of cur) walk(item, key);
      return;
    }
    if (typeof cur === 'object') {
      for (const [k, v] of Object.entries(cur as Record<string, unknown>)) walk(v, k);
    }
  }
  walk(node, fieldKey);
  return hits;
}

function buildLiteralMatchers(rawLiterals: readonly string[] | undefined): RegExp[] {
  const clean = new Set((rawLiterals ?? []).map((s) => s.trim()).filter((s) => s.length >= 8 && !s.startsWith('[REDACTED')));
  return [...clean].map((lit) => {
    let pat = '';
    for (const ch of lit) {
      if (/^[A-Za-z0-9_.\-~]$/.test(ch)) pat += ch === '.' ? '\\.' : ch;
      else if (ch === ' ') pat += '(?:%20|\\+| )';
      else {
        const hexSeq = [...Buffer.from(ch, 'utf8')]
          .map((byte) => '%' + [...byte.toString(16).padStart(2, '0')].map((d) => (d >= 'a' && d <= 'f' ? `[${d.toUpperCase()}${d}]` : d)).join(''))
          .join('');
        pat += `(?:${hexSeq}|${ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`;
      }
    }
    return new RegExp(pat);
  });
}

function containsTokenBoundedCaseInsensitive(haystack: string, needle: string): boolean {
  if (needle.length < 2) return false;
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let pos = 0;
  while (pos <= lowerHay.length - lowerNeedle.length) {
    const found = lowerHay.indexOf(lowerNeedle, pos);
    if (found === -1) return false;
    const before = found > 0 ? lowerHay[found - 1]! : '';
    const after = found + lowerNeedle.length < lowerHay.length ? lowerHay[found + lowerNeedle.length]! : '';
    if ((!before || !isAlphaNum(before)) && (!after || !isAlphaNum(after))) return true;
    pos = found + 1;
  }
  return false;
}

function hasAuthBearerOrJwt(line: string): boolean {
  const lower = line.toLowerCase();
  for (const scheme of [['bea', 'rer '].join(''), ['ba', 'sic '].join('')]) {
    let pos = 0;
    while (pos < lower.length) {
      const idx = lower.indexOf(scheme, pos);
      if (idx === -1) break;
      const prev = idx > 0 ? lower[idx - 1]! : '';
      if (!prev || !isAlphaNum(prev)) {
        const rest = line.slice(idx + scheme.length).trimStart();
        if (!rest.startsWith('[REDACTED') && countRun(rest, 0, (c) => isTokenChar(c) || '.+/=~'.includes(c)) >= 8) {
          return true;
        }
      }
      pos = idx + scheme.length;
    }
  }
  const jwtStart = ['e', 'y', 'J'].join('');
  let jPos = 0;
  while (jPos < line.length) {
    const idx = line.indexOf(jwtStart, jPos);
    if (idx === -1) break;
    const dot1 = line.indexOf('.', idx + 8);
    if (dot1 !== -1 && dot1 - idx <= 256) {
      const seg2Len = countRun(line, dot1 + 1, isTokenChar);
      const dot2 = dot1 + 1 + seg2Len;
      if (seg2Len >= 8 && line[dot2] === '.' && countRun(line, dot2 + 1, isTokenChar) >= 8) return true;
    }
    jPos = idx + 3;
  }
  return false;
}

function hasPasswordHash(line: string): boolean {
  const markers = [['$', '2a$'].join(''), ['$', '2b$'].join(''), ['$', '2y$'].join(''), ['$', 'argon2'].join(''), ['$', 'scrypt$'].join('')];
  return markers.some((m) => {
    const idx = line.indexOf(m);
    return idx !== -1 && line.length - idx >= m.length + 18;
  });
}

function hasCredentialUrl(line: string): boolean {
  const secretQueryKeys = new Set(['api_key', 'apikey', 'token', 'access_token', 'auth_token', 'secret', 'password']);
  for (const scheme of ['http://', 'https://']) {
    let pos = 0;
    while (pos < line.length) {
      const idx = line.toLowerCase().indexOf(scheme, pos);
      if (idx === -1) break;
      let end = idx + scheme.length;
      while (end < line.length && !/[\s"'<>\\]/.test(line[end]!)) end += 1;
      const urlBody = line.slice(idx + scheme.length, end);
      const slashIdx = urlBody.indexOf('/');
      const authority = slashIdx === -1 ? urlBody : urlBody.slice(0, slashIdx);
      const atIdx = authority.indexOf('@');
      if (atIdx > 0 && authority.slice(0, atIdx).includes(':') && !authority.slice(0, atIdx).includes('[REDACTED')) return true;
      const qIdx = urlBody.indexOf('?');
      if (qIdx !== -1) {
        for (const pair of urlBody.slice(qIdx + 1).split('&')) {
          const eq = pair.indexOf('=');
          if (eq > 0 && secretQueryKeys.has(pair.slice(0, eq).toLowerCase())) {
            const v = pair.slice(eq + 1);
            if (v.length > 0 && !v.startsWith('[REDACTED')) return true;
          }
        }
      }
      pos = end;
    }
  }
  return false;
}

function hasWindowsPersonalPath(line: string): boolean {
  const lower = line.toLowerCase();
  if (lower.includes(['one', 'drive'].join('')) || lower.includes('%userprofile%')) return true;
  for (let i = 0; i <= lower.length - 9; i += 1) {
    if (lower[i]! >= 'a' && lower[i]! <= 'z' && lower[i + 1] === ':') {
      const rest = lower.slice(i + 2);
      if (rest.startsWith('\\users\\') || rest.startsWith('\\\\users\\\\') || rest.startsWith('/users/')) return true;
    }
  }
  return false;
}

function hasPosixPersonalPath(line: string): boolean {
  for (const prefix of ['/home/', '/Users/']) {
    let pos = 0;
    while (pos < line.length) {
      const idx = line.indexOf(prefix, pos);
      if (idx === -1) break;
      const prev = idx > 0 ? line[idx - 1]! : '';
      if ((!prev || /[\s"'=|:;(,]/.test(prev)) && line.indexOf('/', idx + prefix.length) > idx + prefix.length) return true;
      pos = idx + prefix.length;
    }
  }
  return false;
}

export function scanSerializedFieldReportOutputs(
  files: Readonly<Record<string, string>>,
  options: FieldReportScannerOptions = {}
): FieldReportScanSummary {
  let osUser = '';
  let host = '';
  try { osUser = (options.osUsername ?? os.userInfo().username).trim(); } catch { osUser = ''; }
  try { host = (options.hostname ?? os.hostname()).trim(); } catch { host = ''; }

  const pemBegin = ['-----BE', 'GIN '].join('');
  const literalMatchers = buildLiteralMatchers(options.secretLiterals);
  const violations: FieldReportScanViolation[] = [];

  for (const [fileName, content] of Object.entries(files)) {
    const lines = content.split(/\r?\n/);
    if (fileName.endsWith('.jsonl')) {
      lines.forEach((rawLine, idx) => {
        const trimmed = rawLine.trim();
        if (!trimmed) return;
        let hit = false;
        try { hit = collectFlaggedStringsFromValue(JSON.parse(trimmed) as unknown).length > 0; } catch { hit = textContainsHighEntropySecret(trimmed); }
        if (hit) violations.push({ file: fileName, line: idx + 1, ruleCode: 'UNREDACTED_HIGH_ENTROPY_SECRET' });
      });
    } else if (fileName.endsWith('.json')) {
      try {
        const matchedLines = new Set<number>();
        for (const val of collectFlaggedStringsFromValue(JSON.parse(content) as unknown)) {
          const foundIdx = lines.findIndex((l) => l.includes(JSON.stringify(val).slice(1, -1)));
          matchedLines.add(foundIdx >= 0 ? foundIdx + 1 : 1);
        }
        for (const lineNo of matchedLines) violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_HIGH_ENTROPY_SECRET' });
      } catch {
        lines.forEach((l, idx) => { if (textContainsHighEntropySecret(l)) violations.push({ file: fileName, line: idx + 1, ruleCode: 'UNREDACTED_HIGH_ENTROPY_SECRET' }); });
      }
    } else {
      lines.forEach((l, idx) => { if (textContainsHighEntropySecret(l)) violations.push({ file: fileName, line: idx + 1, ruleCode: 'UNREDACTED_HIGH_ENTROPY_SECRET' }); });
    }

    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx]!;
      const lineNo = idx + 1;
      if (literalMatchers.some((re) => re.test(line))) violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_LITERAL_SECRET' });
      if (line.includes(pemBegin) && line.includes('PRIVATE KEY')) violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_PEM_PRIVATE_KEY' });
      if (hasAuthBearerOrJwt(line)) violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_AUTH_BEARER' });
      if (hasPasswordHash(line)) violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_PASSWORD_HASH' });
      if (hasCredentialUrl(line)) violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_URL_CREDENTIALS' });
      if (hasWindowsPersonalPath(line)) violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_WINDOWS_USER_PATH' });
      if (hasPosixPersonalPath(line)) violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_POSIX_HOME_PATH' });
      if ((osUser.length >= 2 && containsTokenBoundedCaseInsensitive(line, osUser)) || (host.length >= 2 && containsTokenBoundedCaseInsensitive(line, host))) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_OS_IDENTITY' });
      }
    }
  }
  return { clean: violations.length === 0, violations };
}

export const scanFieldReportBundleFiles = scanSerializedFieldReportOutputs;
