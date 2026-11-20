#!/usr/bin/env node
/**
 * CI watch: wait for a run and classify its failures.
 *
 * Usage: node tools/agent/ci-watch.mjs [--sha <sha>] [--timeout <minutes>]
 *
 * Exit codes:
 *   0  green
 *   10 only infrastructure failures (rerun the failed jobs once)
 *   11 at least one code failure (fix it; do not rerun)
 *   12 timed out waiting, or no run found
 *
 * The tool never reruns a run and never merges.
 */
import { spawnSync } from 'node:child_process';
import { hostname, userInfo } from 'node:os';

const INFRA_PATTERNS = [
  { key: 'cache-service', re: /Failed to (restore|save)/i },
  { key: 'services-down', re: /services aren't available right now/i },
  { key: 'runner-shutdown', re: /The runner has received a shutdown signal/i },
  { key: 'artifact-create', re: /Failed to CreateArtifact/i },
  { key: 'capacity', re: /capacity constraints/i },
  { key: 'network-reset', re: /ECONNRESET|ETIMEDOUT|socket hang up/i },
  { key: 'operation-canceled', re: /The operation was canceled/i },
];

/** Mask the same literals capture.mjs masks, so a shared log is safe to show. */
export function maskText(text, extraNames = []) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  let out = text;
  const replaceAll = (from, to) => {
    if (!from || from.length < 3) return;
    out = out.split(from).join(to);
  };
  replaceAll(home, '<HOME>');
  replaceAll(home.replace(/\\/g, '/'), '<HOME>');
  replaceAll(userInfo().username, '<USER>');
  replaceAll(hostname(), '<HOST>');
  for (const name of extraNames) replaceAll(name, '<PRIVATE>');
  return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) =>
    /@users\.noreply\.github\.com$/i.test(m) ? m : '<EMAIL>'
  );
}

/** Classify one log blob: returns the first matching infra key, or null. */
export function classifyLog(text) {
  for (const pattern of INFRA_PATTERNS) {
    if (pattern.re.test(text)) return pattern.key;
  }
  return null;
}

export function classifyJob(name, conclusion, log) {
  if (conclusion === 'success') return { job: name, conclusion, kind: 'ok', evidence: null };
  if (conclusion === 'skipped') return { job: name, conclusion, kind: 'skipped', evidence: null };
  const infra = classifyLog(log ?? '');
  return {
    job: name,
    conclusion,
    kind: infra ? 'infra' : 'code',
    evidence: infra,
    tail: maskText((log ?? '').split('\n').slice(-12).join('\n')),
  };
}

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || `gh exited ${r.status}`);
  return (r.stdout ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

function parseArgs(argv) {
  const options = { sha: undefined, timeoutMinutes: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sha') options.sha = argv[++i];
    else if (argv[i] === '--timeout') options.timeoutMinutes = Number(argv[++i]);
  }
  return options;
}

function currentSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

function findRun(sha) {
  const list = JSON.parse(gh(['api', `/repos/{owner}/{repo}/actions/runs`, '-X', 'GET', '-f', `head_sha=${sha}`, '-f', 'per_page=10']));
  if (!list.workflow_runs?.length) return null;
  return list.workflow_runs[0];
}

function runJobs(runId) {
  return JSON.parse(gh(['api', `/repos/{owner}/{repo}/actions/runs/${runId}/jobs`, '-X', 'GET', '-f', 'per_page=100'])).jobs ?? [];
}

function failedStepLog(runId, attempt) {
  try {
    return gh(['run', 'view', String(runId), '--attempt', String(attempt ?? 1), '--log-failed']);
  } catch {
    return '';
  }
}

export function summarize(jobs, logs) {
  return jobs.map((job) => {
    if (job.conclusion === 'success' || job.conclusion === 'skipped') {
      return { job: job.name, conclusion: job.conclusion, kind: job.conclusion === 'success' ? 'ok' : 'skipped', evidence: null };
    }
    const log = logs[job.database_id] ?? '';
    const infra = classifyLog(log);
    return {
      job: job.name,
      conclusion: job.conclusion,
      kind: infra ? 'infra' : 'code',
      evidence: infra,
      tail: maskText(log.split('\n').slice(-10).join('\n')),
    };
  });
}

export function exitCodeFor(results) {
  const failed = results.filter((r) => r.kind === 'code' || r.kind === 'infra');
  if (failed.length === 0) return 0;
  return failed.some((r) => r.kind === 'code') ? 11 : 10;
}

export async function watch(options = {}) {
  const sha = options.sha ?? currentSha();
  const timeoutMinutes = options.timeoutMinutes ?? 30;
  const log = options.log ?? ((message) => console.log(message));

  let run = findRun(sha);
  if (!run) {
    log(`NO-RUN sha=${sha.slice(0, 7)}`);
    return 12;
  }

  const deadline = Date.now() + timeoutMinutes * 60000;
  while (run.status !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 20000));
    run = findRun(sha) ?? run;
  }

  if (run.status !== 'completed') {
    log(`TIMEOUT run=${run.id} status=${run.status} sha=${sha.slice(0, 7)}`);
    return 12;
  }

  const jobs = runJobs(run.id);
  const logs = {};
  for (const job of jobs) {
    if (job.conclusion === 'failure' || job.conclusion === 'cancelled') {
      logs[job.database_id] = failedStepLog(run.id, run.run_attempt);
    }
  }

  const results = summarize(jobs, logs);
  const code = exitCodeFor(results);
  const infra = results.filter((r) => r.kind === 'infra');
  const failed = results.filter((r) => r.kind === 'code');

  log(`run=${run.id} attempt=${run.run_attempt} sha=${sha.slice(0, 7)} conclusion=${run.conclusion}`);
  for (const r of results) {
    log(`  ${r.conclusion.padEnd(9)} ${r.kind.padEnd(7)} ${r.job}${r.evidence ? ` [${r.evidence}]` : ''}`);
  }
  if (infra.length > 0) {
    log('');
    log(`INFRA: ${infra.map((r) => `${r.job} (${r.evidence})`).join(', ')}`);
    log(`suggest: gh run rerun ${run.id} --failed  (once per head)`);
  }
  if (failed.length > 0) {
    log('');
    log(`CODE: ${failed.map((r) => r.job).join(', ')}`);
    const first = failed[0];
    if (first.tail) log(`--- tail ${first.job} ---`);
    if (first.tail) log(first.tail);
  }
  return code;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  watch({ sha: options.sha, timeoutMinutes: options.timeoutMinutes })
    .then((exit) => process.exit(exit))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(12);
    });
}

if (process.argv[1] && process.argv[1].endsWith('ci-watch.mjs')) main();