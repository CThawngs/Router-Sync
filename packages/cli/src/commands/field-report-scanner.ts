/**
 * packages/cli/src/commands/field-report-scanner.ts
 *
 * Tickets C49-T1 & C50-K1 (`Phục vụ: S9, S10, key không rời RAM`):
 * Stage-2 Independent Pre-Write Output Scanner (All-or-Nothing Gate).
 *
 * Architectural Invariants:
 *  - Strictly independent of Stage 1: zero imports from Stage 1 and zero vendor
 *    API-key prefix lists.
 *  - Enforces literal env-secret refusal (`UNREDACTED_LITERAL_SECRET`), independent
 *    information-entropy refusal (`UNREDACTED_HIGH_ENTROPY_SECRET`), and structural
 *    PEM / Bearer / JWT / hash / URL / personal-path / OS-identity checks in RAM
 *    BEFORE any directory or file is created in `--out`.
 *  - Violation objects record `{ file, line, ruleCode }` ONLY (zero secret echo).
 */

import * as os from 'node:os';

export interface FieldReportScannerOptions {
  osUsername?: string | undefined;
  hostname?: string | undefined;
  secretLiterals?: readonly string[] | undefined;
}

export type FieldReportScanRuleCode =
  | 'UNREDACTED_LITERAL_SECRET'
  | 'UNREDACTED_HIGH_ENTROPY_SECRET'
  | 'UNREDACTED_PEM_PRIVATE_KEY'
  | 'UNREDACTED_AUTH_BEARER'
  | 'UNREDACTED_PASSWORD_HASH'
  | 'UNREDACTED_URL_CREDENTIALS'
  | 'UNREDACTED_WINDOWS_USER_PATH'
  | 'UNREDACTED_POSIX_HOME_PATH'
  | 'UNREDACTED_OS_IDENTITY';

export interface FieldReportScanViolation {
  file: string;
  line: number;
  ruleCode: FieldReportScanRuleCode;
}

export interface FieldReportScanSummary {
  clean: boolean;
  violations: FieldReportScanViolation[];
}

const ALLOWLISTED_HASH_ID_FIELD_RE =
  /^(?:sha256|stdoutSha12|stderrSha12|planHash|receiptId|snapshotId|snapshotOrBackupRef|commitSha|treeSha|blobSha|etag|checksum|contentHash|bundleSha256|id|uuid|hash)$/i;

const STANDARD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRAILING_UUID_RE = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAlphaNum(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isTokenChar(ch: string): boolean {
  return isAlphaNum(ch) || ch === '_' || ch === '-';
}

function countRun(text: string, start: number, pred: (ch: string) => boolean): number {
  let idx = start;
  while (idx < text.length && pred(text[idx]!)) {
    idx += 1;
  }
  return idx - start;
}

function shannonBitsPerChar(sample: string): { bits: number; distinct: number } {
  const freq = new Map<string, number>();
  for (let i = 0; i < sample.length; i += 1) {
    const ch = sample[i]!;
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of freq.values()) {
    const prob = count / sample.length;
    bits -= prob * Math.log2(prob);
  }
  return { bits, distinct: freq.size };
}

function isSlugWordPart(part: string): boolean {
  if (!part) return true;
  return (
    /^[a-z]{1,24}$/.test(part) ||
    /^[A-Z][a-z]{1,23}$/.test(part) ||
    /^[A-Z]{1,8}$/.test(part) ||
    /^\d{1,12}$/.test(part) ||
    /^(?:[a-zA-Z]{1,4}\d{1,4}[a-zA-Z]{0,3}|\d{1,4}[a-zA-Z]{1,4}|\d+x\d+[a-zA-Z]{0,3})$/.test(part)
  );
}

function isUnredactedHighEntropySubrun(sub: string): boolean {
  if (sub.length >= 32 && /^[0-9a-fA-F]+$/.test(sub)) {
    const { distinct } = shannonBitsPerChar(sub.toLowerCase());
    return /[0-9]/.test(sub) && /[a-fA-F]/.test(sub) && distinct >= 6;
  }
  if (sub.length >= 28 && /^[A-Za-z0-9]+$/.test(sub)) {
    let digits = 0;
    let letters = 0;
    for (let i = 0; i < sub.length; i += 1) {
      const c = sub[i]!;
      if (c >= '0' && c <= '9') digits += 1;
      else letters += 1;
    }
    const { bits, distinct } = shannonBitsPerChar(sub);
    if (digits >= 2 && letters >= 4 && bits >= 3.3 && distinct >= 8) {
      return true;
    }
    if (/[a-z]/.test(sub) && /[A-Z]/.test(sub) && bits >= 4.1 && distinct >= 15) {
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
    if (tok.startsWith('REDACTED')) continue;
    if (STANDARD_UUID_RE.test(tok) || TRAILING_UUID_RE.test(tok)) continue;

    const prefixCtx = text.slice(Math.max(0, offset - 12), offset);
    if (/(?:sha256:|commit\s+)$/i.test(prefixCtx)) continue;

    const prev = offset > 0 ? text[offset - 1]! : '';
    const next = offset + tok.length < text.length ? text[offset + tok.length]! : '';
    const slashBounded = prev === '/' || next === '/';

    // Inspect contiguous alphanumeric sub-runs >= 28 chars (catches prefixed & prefixless keys)
    const subRuns = tok.split(/[-_]+/);
    if (!slashBounded && subRuns.some((sub) => sub.length >= 28 && isUnredactedHighEntropySubrun(sub))) {
      return true;
    }

    // Inspect whole punctuated token >= 28 chars when not a human model/identifier slug
    if (!slashBounded && !subRuns.every(isSlugWordPart)) {
      let digits = 0;
      for (let i = 0; i < tok.length; i += 1) {
        const c = tok[i]!;
        if (c >= '0' && c <= '9') digits += 1;
      }
      const { bits, distinct } = shannonBitsPerChar(tok);
      if (digits >= 2 && /[a-z]/.test(tok) && /[A-Z]/.test(tok) && bits >= 3.5 && distinct >= 10) {
        return true;
      }
    }
  }
  return false;
}

function collectHighEntropyStringsFromValue(node: unknown, fieldKey?: string): string[] {
  const hits: string[] = [];
  function walk(cur: unknown, key?: string): void {
    if (cur === null || cur === undefined) return;
    if (typeof cur === 'string') {
      if (key && ALLOWLISTED_HASH_ID_FIELD_RE.test(key)) return;
      if (textContainsHighEntropySecret(cur)) {
        hits.push(cur);
      }
      return;
    }
    if (Array.isArray(cur)) {
      for (const item of cur) walk(item, key);
      return;
    }
    if (typeof cur === 'object') {
      for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
        walk(v, k);
      }
    }
  }
  walk(node, fieldKey);
  return hits;
}

function buildLiteralForms(rawLiterals: readonly string[] | undefined): RegExp[] {
  const clean = Array.from(
    new Set(
      (rawLiterals ?? [])
        .map((s) => s.trim())
        .filter((s) => s.length >= 8 && !s.startsWith('[REDACTED'))
    )
  );
  const matchers: RegExp[] = [];
  for (const lit of clean) {
    const escRaw = lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matchers.push(new RegExp(escRaw));
    const encoded = encodeURIComponent(lit);
    if (encoded !== lit) {
      const escEnc = encoded
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/%[0-9A-Fa-f]{2}/g, (p) => `(?:${p.toUpperCase()}|${p.toLowerCase()})`);
      matchers.push(new RegExp(escEnc));
    }
  }
  return matchers;
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
    const afterIdx = found + lowerNeedle.length;
    const after = afterIdx < lowerHay.length ? lowerHay[afterIdx]! : '';
    if ((!before || !isAlphaNum(before)) && (!after || !isAlphaNum(after))) {
      return true;
    }
    pos = found + 1;
  }
  return false;
}

function hasPemPrivateKey(line: string): boolean {
  const pemBegin = ['-----BE', 'GIN '].join('');
  return line.includes(pemBegin) && line.includes('PRIVATE KEY');
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
        if (!rest.startsWith('[REDACTED')) {
          const runLen = countRun(
            rest,
            0,
            (c) => isTokenChar(c) || c === '.' || c === '+' || c === '/' || c === '=' || c === '~'
          );
          if (runLen >= 8) return true;
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
      if (seg2Len >= 8 && line[dot2] === '.') {
        const sigLen = countRun(line, dot2 + 1, isTokenChar);
        if (sigLen >= 8) return true;
      }
    }
    jPos = idx + 3;
  }
  return false;
}

function hasPasswordHash(line: string): boolean {
  const markers = [
    ['$', '2a', '$'].join(''),
    ['$', '2b', '$'].join(''),
    ['$', '2y', '$'].join(''),
    ['$', 'argon2'].join(''),
    ['$', 'scrypt', '$'].join(''),
  ];
  return markers.some((m) => {
    const idx = line.indexOf(m);
    return idx !== -1 && line.length - idx >= m.length + 18;
  });
}

function hasCredentialUrl(line: string): boolean {
  for (const scheme of ['http://', 'https://']) {
    let pos = 0;
    while (pos < line.length) {
      const idx = line.toLowerCase().indexOf(scheme, pos);
      if (idx === -1) break;
      const urlStart = idx + scheme.length;
      let end = urlStart;
      while (end < line.length && !/[\s"'<>\\]/.test(line[end]!)) end += 1;
      const urlBody = line.slice(urlStart, end);
      const slashIdx = urlBody.indexOf('/');
      const authority = slashIdx === -1 ? urlBody : urlBody.slice(0, slashIdx);
      const atIdx = authority.indexOf('@');
      if (atIdx > 0) {
        const userInfo = authority.slice(0, atIdx);
        if (userInfo.includes(':') && !userInfo.includes('[REDACTED')) return true;
      }
      const qIdx = urlBody.indexOf('?');
      if (qIdx !== -1) {
        for (const pair of urlBody.slice(qIdx + 1).split('&')) {
          const eq = pair.indexOf('=');
          if (eq <= 0) continue;
          const k = pair.slice(0, eq).toLowerCase();
          const v = pair.slice(eq + 1);
          if (
            (k === 'api_key' ||
              k === 'apikey' ||
              k === 'token' ||
              k === 'access_token' ||
              k === 'auth_token' ||
              k === 'secret' ||
              k === 'password') &&
            v.length > 0 &&
            !v.startsWith('[REDACTED')
          ) {
            return true;
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
  const cloudFolder = ['one', 'drive'].join('');
  if (lower.includes(cloudFolder) || lower.includes('%userprofile%')) return true;
  for (let i = 0; i <= lower.length - 9; i += 1) {
    const ch = lower[i]!;
    if (ch >= 'a' && ch <= 'z' && lower[i + 1] === ':') {
      const rest = lower.slice(i + 2);
      if (rest.startsWith('\\users\\') || rest.startsWith('\\\\users\\\\') || rest.startsWith('/users/')) {
        return true;
      }
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
      if (!prev || /[\s"'=|:;(,]/.test(prev)) {
        const acctStart = idx + prefix.length;
        const acctEnd = line.indexOf('/', acctStart);
        if (acctEnd > acctStart) return true;
      }
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
  try {
    osUser = (options.osUsername ?? os.userInfo().username).trim();
  } catch {
    osUser = '';
  }
  try {
    host = (options.hostname ?? os.hostname()).trim();
  } catch {
    host = '';
  }

  const literalMatchers = buildLiteralForms(options.secretLiterals);
  const violations: FieldReportScanViolation[] = [];

  for (const [fileName, content] of Object.entries(files)) {
    const lines = content.split(/\r?\n/);

    // Independent structured JSON / JSONL entropy inspection (respects allowlisted hash/ID fields)
    if (fileName.endsWith('.jsonl')) {
      lines.forEach((rawLine, idx) => {
        const trimmed = rawLine.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (collectHighEntropyStringsFromValue(parsed).length > 0) {
            violations.push({ file: fileName, line: idx + 1, ruleCode: 'UNREDACTED_HIGH_ENTROPY_SECRET' });
          }
        } catch {
          if (textContainsHighEntropySecret(trimmed)) {
            violations.push({ file: fileName, line: idx + 1, ruleCode: 'UNREDACTED_HIGH_ENTROPY_SECRET' });
          }
        }
      });
    } else if (fileName.endsWith('.json')) {
      try {
        const parsed = JSON.parse(content) as unknown;
        const badValues = collectHighEntropyStringsFromValue(parsed);
        if (badValues.length > 0) {
          const matchedLines = new Set<number>();
          for (const val of badValues) {
            const snippet = JSON.stringify(val).slice(1, -1);
            const foundIdx = lines.findIndex((l) => l.includes(snippet));
            matchedLines.add(foundIdx >= 0 ? foundIdx + 1 : 1);
          }
          for (const lineNo of matchedLines) {
            violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_HIGH_ENTROPY_SECRET' });
          }
        }
      } catch {
        lines.forEach((l, idx) => {
          if (textContainsHighEntropySecret(l)) {
            violations.push({ file: fileName, line: idx + 1, ruleCode: 'UNREDACTED_HIGH_ENTROPY_SECRET' });
          }
        });
      }
    } else {
      lines.forEach((l, idx) => {
        if (textContainsHighEntropySecret(l)) {
          violations.push({ file: fileName, line: idx + 1, ruleCode: 'UNREDACTED_HIGH_ENTROPY_SECRET' });
        }
      });
    }

    // Line-by-line literal secret + structural secret/PII checks
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx]!;
      const lineNo = idx + 1;

      if (literalMatchers.some((re) => re.test(line))) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_LITERAL_SECRET' });
      }
      if (hasPemPrivateKey(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_PEM_PRIVATE_KEY' });
      }
      if (hasAuthBearerOrJwt(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_AUTH_BEARER' });
      }
      if (hasPasswordHash(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_PASSWORD_HASH' });
      }
      if (hasCredentialUrl(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_URL_CREDENTIALS' });
      }
      if (hasWindowsPersonalPath(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_WINDOWS_USER_PATH' });
      }
      if (hasPosixPersonalPath(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_POSIX_HOME_PATH' });
      }
      if (
        (osUser.length >= 2 && containsTokenBoundedCaseInsensitive(line, osUser)) ||
        (host.length >= 2 && containsTokenBoundedCaseInsensitive(line, host))
      ) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_OS_IDENTITY' });
      }
    }
  }

  return {
    clean: violations.length === 0,
    violations,
  };
}

export const scanFieldReportBundleFiles = scanSerializedFieldReportOutputs;
