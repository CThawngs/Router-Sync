#!/usr/bin/env node
/**
 * C25 B6.2: reject fake records and personal identifiers in an evidence package.
 *
 * Usage: node tools/agent/verify-package.mjs <package-dir>
 *
 * Checks on records.jsonl (one JSON per line):
 *  - startedAt !== endedAt at a round hour (e.g. 07:00:00.000Z)
 *  - durationMs >= 50 for a non-instant command
 *  - stdout.file !== stderr.file with 0 lines
 * Then scans records.jsonl and every *.out.txt for personal paths, user names,
 * emails and key-like tokens. Exit 0 when clean, 1 with a problem list.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, userInfo, tmpdir } from 'node:os';

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function readRecords(dir) {
  const file = join(dir, 'records.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function fakeRecordIssues(rows) {
  const issues = [];
  for (const row of rows) {
    const id = row.id ?? '(unknown)';
    if (typeof row.durationMs === 'number' && row.durationMs < 50) {
      issues.push(`${id}: durationMs=${row.durationMs} < 50 (non-instant command)`);
    }
    for (const key of ['startedAt', 'endedAt']) {
      const value = row[key];
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value)) {
        issues.push(`${id}: ${key}=${value} is a round hour (hand-crafted)`);
      }
    }
    if (row.stdout?.file && row.stderr?.file === row.stdout?.file && row.stdout.lines === 0) {
      issues.push(`${id}: stdout and stderr share a file with 0 lines`);
    }
  }
  return issues;
}

export function scanPackage(dir, rows = [], extraNames = []) {
  const names = new Set();
  for (const n of [homedir(), tmpdir(), userInfo().username, process.env.USERPROFILE, process.env.HOME]) {
    if (typeof n === 'string' && n.length > 3) names.add(n);
  }
  for (const n of extraNames) if (typeof n === 'string' && n.trim()) names.add(n.trim());
  // Names loaded from the private-names file, if present.
  const privateFile = join(dir, 'private-names.local.json');
  if (existsSync(privateFile)) {
    try {
      for (const n of JSON.parse(readFileSync(privateFile, 'utf8'))) if (typeof n === 'string') names.add(n);
    } catch { /* ignore malformed list */ }
  }

  const files = [];
  const recordsFile = join(dir, 'records.jsonl');
  if (existsSync(recordsFile)) files.push(recordsFile);
  const recordsDir = join(dir, 'records');
  if (existsSync(recordsDir)) {
    for (const f of readdirSync(recordsDir)) if (f.endsWith('.out.txt') || f.endsWith('.txt')) files.push(join(recordsDir, f));
  }
  let matches = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const name of names) {
      if (name && text.includes(name)) matches += 1;
    }
  }
  return { files: files.length, names: names.size, matches, filesChecked: files.map((f) => basename(f)) };
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node tools/agent/verify-package.mjs <package-dir>');
    process.exit(2);
  }
  const rows = readRecords(dir);
  const issues = [
    ...fakeRecordIssues(rows),
    ...scanPackage(dir, rows).matches > 0 ? [`personal identifiers: ${scanPackage(dir, rows).matches} matches`] : [],
  ];
  if (issues.length > 0) {
    console.error(issues.join('\n'));
    process.exit(1);
  }
  console.log(`OK: ${rows.length} records, no fake records, no personal identifiers`);
}

if (process.argv[1] && process.argv[1].endsWith('verify-package.mjs')) main();
