#!/usr/bin/env node
/**
 * C25 B6.2 / C30 K1.2: reject fake records and personal identifiers in an
 * evidence package. This is the SECOND layer: the standard
 * `verify-records.mjs` (RouterSync-tools) owns integrity (sha256, bytes,
 * timing, privateNamesLoaded); this one adds the checks the standard tool does
 * not make: fake-record shapes, runnable commands, and a text scan for
 * personal paths, usernames, emails and private provider names.
 *
 * Usage: node tools/agent/verify-package.mjs <package-dir>
 *
 * Record shape (capture.mjs v3):
 *   { id, command, startedAt, endedAt, durationMs, exitCode,
 *     stdout: { file, sha256, lines, bytes }, stderr: {...},
 *     masked: { homePath, userName, privateName, email, privateNamesLoaded },
 *     sys: { cpus, totalMemMB, freeMemStartMB, freeMemMinMB } }
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, userInfo, tmpdir } from 'node:os';
import { floorIssues, effectivePrivateNames } from './private-names.mjs';
import { personalPatterns } from './scan-private-names.mjs';

const SAFE_VERBS = new Set(['node', 'gh', 'pnpm', 'git', 'npx']);

export function readRecords(dir) {
  const file = join(dir, 'records.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function requiredRecordIssues(rows) {
  const issues = [];
  for (const row of rows) {
    const id = row.id ?? '(unknown)';
    if (typeof row.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(row.id)) {
      issues.push(`${id}: id missing or malformed (capture.mjs must add it)`);
    }
    if (!row.masked || typeof row.masked !== 'object') {
      issues.push(`${id}: masked missing (capture.mjs must add it)`);
    } else {
      if (!(row.masked.privateNamesLoaded > 0)) {
        issues.push(`${id}: masked.privateNamesLoaded is 0 (capture.mjs loaded no private names)`);
      }
      for (const key of ['homePath', 'userName', 'privateName', 'email']) {
        if (typeof row.masked[key] !== 'number') issues.push(`${id}: masked.${key} missing`);
      }
    }
    if (!row.sys || typeof row.sys !== 'object') {
      issues.push(`${id}: sys missing (capture.mjs must add it)`);
    } else {
      for (const key of ['cpus', 'totalMemMB', 'freeMemStartMB', 'freeMemMinMB']) {
        if (typeof row.sys[key] !== 'number') issues.push(`${id}: sys.${key} missing`);
      }
      if (typeof row.sys.freeMemMinMB === 'number' && typeof row.sys.freeMemStartMB === 'number' && row.sys.freeMemMinMB > row.sys.freeMemStartMB) {
        issues.push(`${id}: sys.freeMemMinMB > sys.freeMemStartMB (hand-edited sample)`);
      }
    }
    if (typeof row.startedAt !== 'string' || Number.isNaN(Date.parse(row.startedAt))) {
      issues.push(`${id}: startedAt missing or unparseable`);
    }
  }
  return issues;
}

export function commandIssues(rows) {
  const issues = [];
  for (const row of rows) {
    const id = row.id ?? '(unknown)';
    // capture.mjs stores the command as one string; an array is accepted for
    // older records but the first token still has to be a known verb.
    const parts = Array.isArray(row.command) ? row.command : String(row.command ?? '').split(' ');
    const cmd = parts.join(' ');
    if (!cmd.trim()) {
      issues.push(`${id}: command is empty`);
      continue;
    }
    if (/^(execute:|sh -c|bash -c)/.test(cmd)) {
      issues.push(`${id}: command is not runnable as-is (${cmd.slice(0, 40)})`);
    }
    if (/[;|`$<>]/.test(cmd)) {
      issues.push(`${id}: command contains a shell operator (${cmd.slice(0, 40)})`);
    }
    if (!SAFE_VERBS.has(parts[0])) {
      issues.push(`${id}: command verb ${parts[0]} not in allowlist`);
    }
  }
  return issues;
}

export function fakeRecordIssues(rows) {
  const issues = [];
  for (const row of rows) {
    const id = row.id ?? '(unknown)';
    if (typeof row.durationMs !== 'number') {
      issues.push(`${id}: durationMs missing (capture.mjs must add it)`);
    } else if (row.durationMs < 50) {
      issues.push(`${id}: durationMs=${row.durationMs} < 50 (non-instant command)`);
    }
    for (const key of ['startedAt', 'endedAt']) {
      const value = row[key];
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value)) {
        issues.push(`${id}: ${key}=${value} is a round hour (hand-crafted)`);
      }
    }
    if (row.stdout?.file && row.stderr?.file === row.stdout?.file) {
      issues.push(`${id}: stdout and stderr share a file`);
    }
    if (row.stdout?.file && row.stdout.bytes === 0 && row.stderr?.bytes === 0) {
      issues.push(`${id}: stdout and stderr are both empty (command produced nothing)`);
    }
  }
  return issues;
}

/**
 * Text scan of the package. Scans records.jsonl plus every *.out.txt / *.err.txt
 * in the directory (C30 K1.2: the C29 leak was in .out.txt files, which the
 * earlier version of this scan never opened).
 */
export function scanPackage(dir, extraNames = []) {
  const names = new Set();
  for (const n of [homedir(), tmpdir(), userInfo().username, process.env.USERPROFILE, process.env.HOME]) {
    if (typeof n === 'string' && n.length > 3) names.add(n);
  }
  for (const n of extraNames) if (typeof n === 'string' && n.trim()) names.add(n.trim());

  const files = [];
  const recordsFile = join(dir, 'records.jsonl');
  if (existsSync(recordsFile)) files.push(recordsFile);
  for (const entry of readdirSync(dir)) {
    if (/\.(out|err)\.txt$/.test(entry)) files.push(join(dir, entry));
  }

  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const name of names) {
      if (!name) continue;
      const matches = text.split(name).length - 1;
      if (matches > 0) hits.push({ file: basename(file), name: '<private>', matches });
    }
    for (const p of personalPatterns()) {
      const re = new RegExp(p.regex.source, 'gi');
      const matches = (text.match(re) ?? []).length;
      if (matches > 0) hits.push({ file: basename(file), name: p.name, matches });
    }
  }
  return {
    files: files.length,
    names: names.size,
    matches: hits.reduce((sum, h) => sum + h.matches, 0),
    filesChecked: files.map((f) => basename(f)),
    hits,
  };
}

function loadPrivateNames() {
  const candidates = [
    process.env.RS_PRIVATE_NAMES ? null : null,
    '.agent/private-names.local.json',
  ].filter(Boolean);
  const names = [];
  for (const n of (process.env.RS_PRIVATE_NAMES || '').split(',')) if (n.trim()) names.push(n.trim());
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      for (const n of JSON.parse(readFileSync(file, 'utf8'))) if (typeof n === 'string' && n.trim()) names.push(n.trim());
    } catch {
      /* danh sách hỏng: bỏ qua, floor check vẫn bắt privateNamesLoaded */
    }
  }
  return names;
}

/**
 * Floor theo danh sách hiện hành. Một gói mà mọi bản ghi nạp 4 tên trong khi
 * guard báo 7 là gói của một phiên bản danh sách cũ — từ chối, đừng đẩy.
 */
export function nameFloorIssues(rows, expected) {
  return floorIssues(rows, expected);
}

function main() {
  const dir = process.argv[2];
  if (!dir || dir.startsWith('--')) {
    console.error('Usage: node tools/agent/verify-package.mjs <package-dir> [--min-private-names <n>]');
    process.exit(2);
  }
  const flagIndex = process.argv.indexOf('--min-private-names');
  const expected = flagIndex >= 0 ? Number(process.argv[flagIndex + 1]) : effectivePrivateNames().length;
  const rows = readRecords(dir);
  const scan = scanPackage(dir, loadPrivateNames());
  const issues = [
    ...requiredRecordIssues(rows),
    ...commandIssues(rows),
    ...fakeRecordIssues(rows),
    ...nameFloorIssues(rows, expected),
    ...(scan.matches > 0 ? [`personal identifiers: ${scan.matches} match(es) in ${scan.filesChecked.join(', ')}`] : []),
  ];
  if (issues.length > 0) {
    for (const issue of issues) console.error(issue);
    process.exit(1);
  }
  console.log(
    `OK: ${rows.length} records, no fake records, ${scan.files} file(s) scanned, no personal identifiers, privateNamesLoaded >= ${expected}`
  );
}

if (process.argv[1] && process.argv[1].endsWith('verify-package.mjs')) main();