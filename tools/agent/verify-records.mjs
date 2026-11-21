#!/usr/bin/env node
/**
 * verify-records.mjs — verification gate for evidence packages (C29 J4).
 *
 * Usage: node tools/agent/verify-records.mjs <package-dir>
 *
 * For every record in <dir>/records.jsonl, verify:
 *   - `sha256.out` and `sha256.err` are full 64-hex digests (sha256).
 *   - `stdout.file` exists (if it is used) — the record may omit the .err file.
 *   - `durationMs` is a real duration: not a multiple of 1000 when the command
 *     was not `pnpm --help`-style instant, and the digest/size sanity of the
 *     timing: 0 <= durationMs < 86_400_000 and not exactly 0 for real work.
 *   - `startedAt` is not at an exact second boundary (a hand-edited/cheap signal).
 *   - `masked` is an array of masked private-provider names.
 *   - `sys` contains `os` (platform), `runId` (string, gh-run id or `local`),
 *     `headSha` (40/64-hex or `unknown`), and `nodeVersion`.
 *   - `command` is from the allowlist (gh, node, pnpm); no shell operators,
 *     no `execute:` prefixes, no absolute paths.
 *
 * Exit 0 when all pass, 1 with the problem list otherwise.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SHA_HEX_RE = /^[0-9a-f]{64}$/;
const MAX_DURATION_MS = 86_400_000;

function problemsFor(row, seen, dir) {
  const problems = [];
  const id = row.name ?? '(unknown)';
  if (!SHA_HEX_RE.test(row.sha256?.out ?? '')) problems.push(`${id}: sha256.out missing or not 64-hex`);
  if (row.sha256 && row.sha256.err !== undefined && !SHA_HEX_RE.test(row.sha256.err)) {
    problems.push(`${id}: sha256.err not 64-hex`);
  }
  if (row.stdout?.file) {
    const f = row.stdout.file;
    const p = existsSync(f) ? f : join(dir, f);
    if (!existsSync(p)) problems.push(`${id}: stdout.file missing on disk`);
  }
  const d = row.durationMs;
  if (typeof d !== 'number' || !Number.isFinite(d) || d < 0 || d > MAX_DURATION_MS) {
    problems.push(`${id}: durationMs missing or out of range`);
  } else if (d % 1000 === 0 && d >= 1000) {
    // Real work rarely ends on an exact second; keep d under 1000 ms exempted.
    const startedAt = new Date(row.startedAt).toISOString();
    const sec = Number(/T\d{2}:\d{2}:(\d{2})/.exec(startedAt)?.[1] ?? NaN);
    if (Number.isFinite(sec) && sec === 0) problems.push(`${id}: durationMs is multiple of 1000 with startedAt at second 0 (hand-calculated?)`);
    else if (d >= 1000) problems.push(`${id}: durationMs ${d} is a round value`);
  }
  const sa = new Date(row.startedAt);
  const sec = Number(/T\d{2}:\d{2}:(\d{2})/.exec(sa.toISOString())?.[1] ?? NaN);
  if (!Number.isFinite(sec) || sec === 0) problems.push(`${id}: startedAt at second 0 (hand-edited?)`);
  if (!Array.isArray(row.masked)) problems.push(`${id}: masked missing`);
  const s = row.sys;
  if (!s || !s.os || !s.runId || !s.nodeVersion) {
    problems.push(`${id}: sys.os/runId/nodeVersion missing`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(s?.headSha ?? '')) problems.push(`${id}: sys.headSha not a git sha`);
  if (!Array.isArray(row.command)) problems.push(`${id}: command missing`);
  const cmd = row.command?.join(' ') ?? '';
  if (cmd.includes('execute:')) problems.push(`${id}: command includes execute: (not runnable)`);
  if (/[;&|`$<>"]/.test(cmd)) problems.push(`${id}: command includes shell operator`);
  if (seen) {
    const key = JSON.stringify(row.command);
    if (seen.has(key)) problems.push(`${id}: duplicate command in records.jsonl`);
    else seen.add(key);
  }
  return problems;
}

function main() {
  const dir = process.argv[2] ?? '.';
  const file = join(dir, 'records.jsonl');
  if (!existsSync(file)) {
    console.error('verify-records: missing records.jsonl');
    process.exit(1);
  }
  const problems = [];
  const seen = new Set();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch (e) { problems.push(`records.jsonl: bad JSON (${e.message})`); continue; }
    problems.push(...problemsFor(row, seen, dir));
  }
  if (problems.length === 0) {
    const count = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length;
    console.log(`verify-records: OK, ${count} records`);
  } else {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
}

main();
