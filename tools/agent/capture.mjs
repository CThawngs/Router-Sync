#!/usr/bin/env node
/**
 * capture.mjs — run a command and record evidence with the metadata every
 * evidence record needs: sha256 of outputs, `masked` (private provider names
 * found in workspace paths), `sys` (runId/headSha/os/durationMs) and real
 * durations.
 *
 * Usage:
 *   node tools/agent/capture.mjs <dir> <name> -- <command...>
 *       Writes <dir>/<name>.out.txt and <dir>/<name>.err.txt (if non-empty),
 *       appends <dir>/<name>.record.json.
 *       Default: refuses when <name>.out.txt already exists (R1).
 *       Add --fresh to re-run (R1 re-capture).
 *   node tools/agent/capture.mjs --verify <dir>
 *       Runs verify-records.mjs on <dir>.
 *
 * Guards:
 *   - `command` must be from the allowlist (gh, node, pnpm) — no shell
 *     operators (`;`, `&`, `|`), no `execute:` prefixes, no absolute paths.
 *   - sha256 of the outputs is computed before truncation.
 *
 * C29 J4: records are created by this script and never edited afterwards.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = process.cwd();

const ALLOWED_VERBS = ['gh', 'node', 'pnpm'];
const SHA_HEX_RE = /^[0-9a-f]{64}$/;
const SHELL_RE = /[;&|`$<>]/;

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function checkCommand(argv) {
  const problems = [];
  if (!argv.length) return ['empty command'];
  if (!ALLOWED_VERBS.includes(argv[0])) problems.push(`verb ${argv[0]} not in allowlist`);
  if (SHELL_RE.test(argv.join(' '))) problems.push('shell operator found in command');
  if (argv.join(' ').includes('execute:')) problems.push('non-runnable command prefix');
  for (const a of argv) {
    if (path.isAbsolute(a)) problems.push(`absolute path in command: ${a}`);
  }
  return problems;
}

/** Names of private providers as they appear in workspace file paths. */
function collectPrivatePaths() {
  const rg = spawnSync('rg', ['-n', 'private', '--glob', '!evidence/**', '--glob', '!.agent/**', '--glob', '!node_modules/**'], { cwd: ROOT, encoding: 'utf8' });
  if (rg.status !== 0) return [];
  return [...new Set(rg.stdout.split('\n').map((l) => l.match(/^([^\s:]+)/)?.[1]).filter(Boolean))];
}

function readDbPrivateNames() {
  const names = collectPrivatePaths();
  return names.map((_, i) => `<pp${String(i + 1).padStart(2, '0')}>`);
}

function readRunSys() {
  let runId = 'local';
  try {
    const out = spawnSync('gh', ['run', 'list', '--repo', 'CThawngs/Router-Sync', '--workflow', 'ci-watch', '--json', 'databaseId,headSha', '--limit', '1'], { cwd: ROOT, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    const rows = JSON.parse(out.stdout ?? '[]');
    if (rows[0]) runId = `ghrun:${rows[0].databaseId}`;
  } catch { /* local mode */ }
  return {
    os: process.platform,
    runId,
    headSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'unknown',
    nodeVersion: process.version,
  };
}

function captureRun(dir, name, argv, extra) {
  if (extra.fresh) {
    const stale = path.join(dir, `${name}.record.json`);
    if (existsSync(stale)) unlinkSync(stale);
  }
  const outFile = path.join(dir, `${name}.out.txt`);
  if (existsSync(outFile) && !extra.fresh) {
    return { code: 3, problems: [`${name}.out.txt already exists in ${dir}; rerun with --fresh (R1 guard)`] };
  }
  const issues = checkCommand(argv);
  if (issues.length) return { code: 2, problems: issues.map((p) => `[guard] ${p}`) };
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const res = spawnSync(argv[0], argv.slice(1), { cwd: ROOT, encoding: 'utf8', maxBuffer: 200 * 1024 * 1024, timeout: 1200000 });
  const durationMs = Date.now() - t0;
  const outText = res.stdout ?? '';
  const errText = res.stderr ?? '';
  if (outText.length > 0) writeFileSync(outFile, outText);
  if (errText.length > 0) writeFileSync(path.join(dir, `${name}.err.txt`), errText);
  const record = {
    name,
    dir,
    command: argv,
    exitCode: res.status === null ? 1 : res.status,
    startedAt: new Date(t0 - durationMs).toISOString(),
    durationMs,
    sha256: { out: sha256(outText), err: sha256(errText) },
    stdout: { file: `${name}.out.txt` },
    masked: readDbPrivatePaths() ? collectPrivatePaths().map((f, i) => `<pp${String(i + 1).padStart(2, '0')}>`) : [],
    sys: readRunSys(),
  };
  const recordsPath = path.join(dir, 'records.jsonl');
  const prior = existsSync(recordsPath) ? readFileSync(recordsPath, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  writeFileSync(recordsPath, [...prior, JSON.stringify(record)].join('\n') + '\n', 'utf8');
  return { code: 0, problems: [] };
}

function readDbPrivatePaths() { return collectPrivatePaths(); }

/** verify-records.mjs semantics for capture-produced records. */
function verifyRecords(dir) {
  const recordsPath = path.join(dir, 'records.jsonl');
  if (!existsSync(recordsPath)) return ['missing records.jsonl'];
  const problems = [];
  const rows = readFileSync(recordsPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) {
    if (!SHA_HEX_RE.test(r.sha256?.out ?? '')) problems.push(`${r.name}: sha256.out not a full 64-hex digest`);
    if (!r.sha256 || !SHA_HEX_RE.test(r.sha256.err)) problems.push(`${r.name}: sha256.err missing`);
    if (typeof r.durationMs !== 'number' || r.durationMs < 0 || !Number.isFinite(r.durationMs)) problems.push(`${r.name}: durationMs not a real duration`);
    const m = /T(\d{2}):\d{2}:(\d{2})(\.\d+)?Z$/.exec(new Date(r.startedAt).toISOString());
    if (!m || parseInt(m[2], 10) === 0) problems.push(`${r.name}: startedAt looks hand-edited (round second)`);
    if (!Array.isArray(r.masked)) problems.push(`${r.name}: masked missing`);
    const s = r.sys;
    if (!s || typeof s.os !== 'string' || typeof s.runId !== 'string' || !/^[0-9a-f]{40,64}$/.test(s.headSha)) problems.push(`${r.name}: sys.os/runId/headSha missing`);
    if (!Array.isArray(r.command)) problems.push(`${r.name}: command missing`);
    else for (const p of checkCommand(r.command)) problems.push(`${r.name}: ${p}`);
  }
  return problems;
}

const argv = process.argv.slice(2);
const mode = argv[0];
if (mode === '--verify') {
  const problems = verifyRecords(argv[1] ?? '.');
  if (problems.length === 0) console.log('verify-records: OK, all capture records valid');
  else for (const p of problems) console.error(p);
  process.exit(problems.length === 0 ? 0 : 1);
}

const dash = argv.indexOf('--');
if (dash < 2 || argv.length < dash + 2) {
  console.error('usage: node capture.mjs <dir> <name> -- <command...>  |  node capture.mjs --verify <dir>');
  process.exit(2);
}
const dir = argv[0];
const name = argv[1];
const extra = argv.slice(2, dash).filter(Boolean);
const cmd = argv.slice(dash + 1);
const { code, problems } = captureRun(dir, name, cmd, { fresh: extra.includes('--fresh') });
for (const p of problems) console.error(p);
process.exit(code);
