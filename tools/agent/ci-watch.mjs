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
 *   12 timed out waiting, no run found, or an unknown failure (no job log)
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

/** Steps whose failures are, by default, code failures. */
const TEST_STEP_RE = /(Run Tests|End-to-end|Product smoke|Slow tests|UI tests|Memory report)/i;
/** Markers that prove a test actually failed on an assertion. */
const TEST_FAILURE_RE = /(AssertionError|\bFAIL\s|Test Files[^\n]*failed|Tests[^\n]*failed|\[31m\[1m\[7m FAIL)/i;

/**
 * Classify a failed step.
 *
 * C23 V3: RouterTest prints network-flavoured text on purpose (the
 * UPSTREAM-UNREACHABLE and verify tests), so a blanket "ECONNRESET in the log"
 * rule would call a red test an infrastructure problem and invite a rerun. A
 * test step with assertion evidence is a code failure, whatever else it printed.
 */
export function classifyStep(stepName, log) {
  const text = log ?? '';
  const isTestStep = TEST_STEP_RE.test(stepName ?? '');
  const hasTestFailure = TEST_FAILURE_RE.test(text);
  if (isTestStep) return hasTestFailure ? 'code' : classifyLog(text) ? 'infra' : 'code';
  return classifyLog(text) ? 'infra' : 'code';
}

/** First failing step name from a job's step list, or '' when there is none. */
export function failedStepNames(job) {
  return (job.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => s.name);
}

/** Error markers that anchor "the real error" inside a failed step's log. */
const FAILURE_MARKERS = ['Hook timed out', 'AssertionError', 'FAIL', '##[error]', 'Error:'];

/**
 * Context of the failing step itself: the step names from `job.steps`, plus up
 * to 20 masked lines around the first error marker. Returns '' when no marker
 * is found (e.g. the job died between steps).
 */
export function failingStepContext(log, job) {
  const stepNames = failedStepNames(job);
  const lines = (log ?? '').split('\n').map((l) => l.replace(/\[[0-9;]*m/g, ''));
  let idx = -1;
  // The most specific markers win over generic `Error:` (the log often starts
  // with unrelated `Error:` lines, e.g. the security-violation print).
  for (const marker of FAILURE_MARKERS) {
    const i = lines.findIndex((l) => l.includes(marker));
    if (i >= 0) { idx = i; break; }
  }
  let context = '';
  if (idx >= 0) {
    context = lines
      .slice(Math.max(0, idx - 5), idx + 15)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 20)
      .join('\n');
  }
  return { stepNames, context };
}

/** Extract the step name from the first column of a gh log line: job\tstep\ttimestamp. */
export function stepNameFromLog(text) {
  const line = (text ?? '').split('\n')[0] ?? '';
  return line.split('\t').slice(1, -1).join(' ').trim();
}

/** Jobs whose conclusion is neither success nor skipped but nothing ever ran. */
function noStepsRan(job) {
  const steps = job.steps ?? [];
  return steps.length === 0 || steps.every((s) => s.conclusion === 'skipped' || s.conclusion === 'never_executed');
}

export function classifyJob(name, conclusion, log, runConclusion) {
  if (conclusion === 'success') return { job: name, conclusion, kind: 'ok', evidence: null };
  if (conclusion === 'skipped') return { job: name, conclusion, kind: 'skipped', evidence: null };
  if (conclusion === 'cancelled') {
    return { job: name, conclusion, kind: 'infra', evidence: 'no steps ran (capacity or runner loss)', tail: maskText((log ?? '').split('\n').slice(-10).join('\n')) };
  }
  const kind = classifyStep(stepNameFromLog(log), log);
  return { job: name, conclusion, kind: kind === 'infra' ? 'infra' : 'code', evidence: kind === 'infra' ? classifyLog(log) : null, tail: maskText((log ?? '').split('\n').slice(-10).join('\n')) };
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

function jobLog(runId, jobId) {
  try {
    return gh(['run', 'view', String(runId), '--job', String(jobId), '--log']);
  } catch {
    return '';
  }
}

// The GitHub jobs API does not return the workflow's job-level
// `continue-on-error` flag, so the masked set is matched by the expanded job
// name: `.github/workflows/ci.yml` sets `continue-on-error:
// ${{ matrix.os == 'windows-11-arm' }}` on the `verify` job.
const MASKED_JOB_NAME_RE = /^verify \(windows-11-arm, node \d+\)$/;

function isMasked(job) {
  return Boolean(job.continue_on_error) || MASKED_JOB_NAME_RE.test(job.name ?? '');
}

export function summarize(jobs, logs) {
  return jobs.map((job) => {
    if (job.conclusion === 'success' || job.conclusion === 'skipped') {
      return { job: job.name, conclusion: job.conclusion, kind: job.conclusion === 'success' ? 'ok' : 'skipped', evidence: null };
    }
    const log = logs[job.id] ?? logs[job.database_id] ?? '';
    const stepName = failedStepNames(job)[0] ?? stepNameFromLog(log);
    let kind;
    let evidence;
    if (job.conclusion === 'cancelled' && noStepsRan(job)) {
      // A capacity or runner-loss cancel: the job never executed, that is infra.
      kind = 'infra';
      evidence = 'no steps ran (capacity or runner loss)';
    } else if (log === '' && !job.continue_on_error) {
      // No log of this exact job: the failure cannot be classified as code or infra.
      kind = 'unknown';
      evidence = 'no job log';
    } else {
      kind = classifyStep(stepName, log);
      if (kind === 'infra') evidence = classifyLog(log);
    }
    // continue-on-error jobs (windows-11-arm) do not fail the run: they are
    // reported as masked, not as code, whatever the run conclusion.
    if (isMasked(job)) kind = 'masked';
    const stepContext = failingStepContext(log, job);
    return {
      job: job.name,
      conclusion: job.conclusion,
      kind,
      evidence,
      stepNames: stepContext.stepNames,
      context: stepContext.context,
      tail: maskText(log.split('\n').slice(-10).join('\n')),
    };
  });
}

export function exitCodeFor(results) {
  if (results.some((r) => r.kind === 'unknown')) return 12;
  const failed = results.filter((r) => r.kind === 'code' || r.kind === 'infra');
  if (failed.some((r) => r.kind === 'code')) return 11;
  return failed.length > 0 ? 10 : 0;
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
      logs[job.id] = jobLog(run.id, job.id);
    }
  }

  const results = summarize(jobs, logs);
  const code = exitCodeFor(results);
  const infra = results.filter((r) => r.kind === 'infra');
  const masked = results.filter((r) => r.kind === 'masked');
  const failed = results.filter((r) => r.kind === 'code');

  log(`run=${run.id} attempt=${run.run_attempt} sha=${sha.slice(0, 7)} conclusion=${run.conclusion}`);
  for (const r of results) {
    log(`  ${r.conclusion.padEnd(9)} ${r.kind.padEnd(7)} ${r.job}${r.evidence ? ` [${r.evidence}]` : ''}`);
  }
  if (masked.length > 0) {
    log('');
    log(`MASKED (continue-on-error, not counted): ${masked.map((r) => r.job).join(', ')}`);
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
    for (const s of first.stepNames ?? []) log(`  failStep=${s}`);
    if (first.context) log(`--- context ${first.job} ---`);
    if (first.context) log(maskText(first.context));
    if (!first.context && first.tail) { log(`--- tail ${first.job} ---`); log(first.tail); }
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