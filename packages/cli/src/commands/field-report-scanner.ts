/**
 * packages/cli/src/commands/field-report-scanner.ts
 *
 * Ticket C49-T1 (`Phục vụ: S9, S10`): Stage-2 Independent Pre-Write Output Scanner.
 *
 * Architectural Invariant:
 *  - Zero shared code or regexes with `field-report-scrubber.ts`.
 *  - Inspects serialized file buffers in memory BEFORE any directory or file is
 *    created in `--out`.
 *  - Never echoes matched secret substrings in violation records.
 */

import * as os from 'node:os';

export interface FieldReportScannerOptions {
  osUsername?: string | undefined;
  hostname?: string | undefined;
}

export interface FieldReportScanViolation {
  file: string;
  line: number;
  ruleCode:
    | 'UNREDACTED_SK_API_KEY'
    | 'UNREDACTED_GOOGLE_API_KEY'
    | 'UNREDACTED_GITHUB_PAT'
    | 'UNREDACTED_BEARER_OR_JWT'
    | 'UNREDACTED_PASSWORD_HASH'
    | 'UNREDACTED_CREDENTIAL_URL'
    | 'UNREDACTED_WIN_PERSONAL_PATH'
    | 'UNREDACTED_POSIX_PERSONAL_PATH'
    | 'UNREDACTED_OS_IDENTITY'
    | 'UNREDACTED_PLATFORM_TOKEN';
}

export interface FieldReportScanSummary {
  clean: boolean;
  violations: FieldReportScanViolation[];
}

function isTokenChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    ch === '_' ||
    ch === '-'
  );
}

function isAlphaNum(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function countRun(text: string, start: number, pred: (ch: string) => boolean): number {
  let idx = start;
  while (idx < text.length && pred(text[idx]!)) {
    idx += 1;
  }
  return idx - start;
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

function hasSkKey(line: string): boolean {
  const prefix = ['s', 'k', '-'].join('');
  let pos = 0;
  while (pos < line.length) {
    const idx = line.indexOf(prefix, pos);
    if (idx === -1) return false;
    const prev = idx > 0 ? line[idx - 1]! : '';
    if (!prev || !isAlphaNum(prev)) {
      const tailLen = countRun(line, idx + prefix.length, isTokenChar);
      if (tailLen >= 12) return true;
    }
    pos = idx + prefix.length;
  }
  return false;
}

function hasGoogleKey(line: string): boolean {
  const prefix = ['A', 'I', 'z', 'a'].join('');
  let pos = 0;
  while (pos < line.length) {
    const idx = line.indexOf(prefix, pos);
    if (idx === -1) return false;
    const prev = idx > 0 ? line[idx - 1]! : '';
    if (!prev || !isAlphaNum(prev)) {
      const tailLen = countRun(line, idx + prefix.length, isTokenChar);
      if (tailLen >= 16) return true;
    }
    pos = idx + prefix.length;
  }
  return false;
}

function hasGithubPat(line: string): boolean {
  const prefixes = [
    ['g', 'h', 'p', '_'].join(''),
    ['g', 'h', 'o', '_'].join(''),
    ['g', 'h', 'u', '_'].join(''),
    ['g', 'h', 's', '_'].join(''),
    ['g', 'h', 'r', '_'].join(''),
    ['github', 'pat', ''].join('_'),
  ];
  for (const pfx of prefixes) {
    let pos = 0;
    while (pos < line.length) {
      const idx = line.indexOf(pfx, pos);
      if (idx === -1) break;
      const prev = idx > 0 ? line[idx - 1]! : '';
      if (!prev || !isAlphaNum(prev)) {
        const tailLen = countRun(line, idx + pfx.length, isTokenChar);
        if (tailLen >= 16) return true;
      }
      pos = idx + pfx.length;
    }
  }
  return false;
}

function hasBearerOrJwt(line: string): boolean {
  const lower = line.toLowerCase();
  const bearerToken = ['bea', 'rer '].join('');
  let pos = 0;
  while (pos < lower.length) {
    const idx = lower.indexOf(bearerToken, pos);
    if (idx === -1) break;
    const prev = idx > 0 ? lower[idx - 1]! : '';
    if (!prev || !isAlphaNum(prev)) {
      const rest = line.slice(idx + bearerToken.length).trimStart();
      if (!rest.startsWith('[REDACTED')) {
        const tokenLen = countRun(
          rest,
          0,
          (c) => isTokenChar(c) || c === '.' || c === '+' || c === '/' || c === '=' || c === '~'
        );
        if (tokenLen >= 12) {
          return true;
        }
      }
    }
    pos = idx + bearerToken.length;
  }

  // Independent 3-dot JWT structural check (`eyJ... . eyJ... . sig`)
  const jwtStart = ['e', 'y', 'J'].join('');
  let jPos = 0;
  while (jPos < line.length) {
    const idx = line.indexOf(jwtStart, jPos);
    if (idx === -1) break;
    const dot1 = line.indexOf('.', idx + 8);
    if (dot1 !== -1 && dot1 - idx <= 256 && line.slice(dot1 + 1, dot1 + 4) === jwtStart) {
      const dot2 = line.indexOf('.', dot1 + 8);
      if (dot2 !== -1 && dot2 - dot1 <= 512) {
        const sigLen = countRun(line, dot2 + 1, isTokenChar);
        if (sigLen >= 8) return true;
      }
    }
    jPos = idx + 3;
  }
  return false;
}

function hasPasswordHash(line: string): boolean {
  const bcryptMarkers = [
    ['$', '2a', '$'].join(''),
    ['$', '2b', '$'].join(''),
    ['$', '2y', '$'].join(''),
    ['$', 'argon2'].join(''),
    ['$', 'scrypt', '$'].join(''),
  ];
  for (const marker of bcryptMarkers) {
    const idx = line.indexOf(marker);
    if (idx !== -1 && line.length - idx >= marker.length + 18) {
      return true;
    }
  }
  return false;
}

function hasCredentialUrl(line: string): boolean {
  for (const scheme of ['http://', 'https://']) {
    let pos = 0;
    while (pos < line.length) {
      const idx = line.toLowerCase().indexOf(scheme, pos);
      if (idx === -1) break;
      const urlStart = idx + scheme.length;
      let end = urlStart;
      while (end < line.length && !/[\s"'<>\\]/.test(line[end]!)) {
        end += 1;
      }
      const urlBody = line.slice(urlStart, end);
      const slashIdx = urlBody.indexOf('/');
      const authority = slashIdx === -1 ? urlBody : urlBody.slice(0, slashIdx);
      const atIdx = authority.indexOf('@');
      if (atIdx > 0) {
        const userInfoPart = authority.slice(0, atIdx);
        if (userInfoPart.includes(':') && !userInfoPart.includes('[REDACTED')) {
          return true;
        }
      }
      const qIdx = urlBody.indexOf('?');
      if (qIdx !== -1) {
        const query = urlBody.slice(qIdx + 1);
        for (const pair of query.split('&')) {
          const eq = pair.indexOf('=');
          if (eq <= 0) continue;
          const k = pair.slice(0, eq).toLowerCase();
          const v = pair.slice(eq + 1);
          if (
            (k === 'api_key' ||
              k === 'apikey' ||
              k === 'token' ||
              k === 'access_token' ||
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
  if (lower.includes(cloudFolder) || lower.includes('%userprofile%')) {
    return true;
  }
  for (let i = 0; i <= lower.length - 9; i += 1) {
    const ch = lower[i]!;
    if (ch >= 'a' && ch <= 'z' && lower[i + 1] === ':') {
      const rest = lower.slice(i + 2);
      if (
        rest.startsWith('\\users\\') ||
        rest.startsWith('\\\\users\\\\') ||
        rest.startsWith('/users/')
      ) {
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
      // Ensure it is a root path token, not a URL segment like `https://example.com/Users/`
      if (!prev || prev === ' ' || prev === '"' || prev === "'" || prev === '=' || prev === '|') {
        const acctStart = idx + prefix.length;
        const acctEnd = line.indexOf('/', acctStart);
        if (acctEnd > acctStart) {
          return true;
        }
      }
      pos = idx + prefix.length;
    }
  }
  return false;
}

function hasPlatformToken(line: string): boolean {
  const pemBegin = ['-----BE', 'GIN '].join('');
  if (line.includes(pemBegin) && line.includes('PRIVATE KEY')) return true;
  if (line.includes('xoxb-') || line.includes('xoxp-')) return true;
  const akiaIdx = line.indexOf('AKIA');
  if (akiaIdx !== -1) {
    const run = countRun(line, akiaIdx + 4, (c) => (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z'));
    if (run >= 16) return true;
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

  const violations: FieldReportScanViolation[] = [];

  for (const [fileName, content] of Object.entries(files)) {
    const lines = content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx]!;
      const lineNo = idx + 1;

      if (hasSkKey(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_SK_API_KEY' });
      }
      if (hasGoogleKey(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_GOOGLE_API_KEY' });
      }
      if (hasGithubPat(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_GITHUB_PAT' });
      }
      if (hasBearerOrJwt(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_BEARER_OR_JWT' });
      }
      if (hasPasswordHash(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_PASSWORD_HASH' });
      }
      if (hasCredentialUrl(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_CREDENTIAL_URL' });
      }
      if (hasWindowsPersonalPath(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_WIN_PERSONAL_PATH' });
      }
      if (hasPosixPersonalPath(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_POSIX_PERSONAL_PATH' });
      }
      if (hasPlatformToken(line)) {
        violations.push({ file: fileName, line: lineNo, ruleCode: 'UNREDACTED_PLATFORM_TOKEN' });
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
