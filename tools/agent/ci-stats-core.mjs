/**
 * C25 B2: pure CI statistics over a list of GitHub workflow runs.
 *
 * No network, no clock: the caller passes the runs and the evidence (failed
 * step logs) so the rules can be tested with fake data. `ci-stats.mjs` is the
 * thin CLI wrapper around this module.
 *
 * Rules (C25 B2.1–B2.4):
 *  1. Dependabot is separated by BOTH `event === 'dynamic'` and the
 *     `dependabot/*` branch prefix. It never enters our numerator/denominator
 *     or the red-run list.
 *  2. Per commit, the `CI` workflow wins over a run of another workflow (e.g.
 *     `dynamic`); a push commit with no CI run is reported as such, not dropped.
 *  3. Runs with `conclusion === null` are pending: counted separately, never in
 *     the green/red sample.
 *  4. A red step named `UNKNOWN STEP` (or with no log) is `unknown`, not
 *     `infra`. `infra` needs a real signal from the log or a cancelled job that
 *     never ran a step. A cancel caused by `concurrency` is not a red run.
 *  5. (M1-01) A log with `daemon health failed; exited=` is `code`, with the
 *     `[E2E-DAEMON-HEALTH-SIGNAL]` marker, whatever else the log shows.
 *  6. (M1-01) `pushMainStreak` is the current run of consecutive `push`
 *     commits on `main` whose CI run succeeded on attempt 1.
 */
import {
  classifyLog,
  classifyStep,
  detectDaemonHealthSignal,
  DAEMON_HEALTH_SIGNAL_MARKER,
} from './ci-watch.mjs';

const DEPENDABOT_BRANCH_RE = /^dependabot\//;

export function isDependabot(run) {
  return run.event === 'dynamic' || DEPENDABOT_BRANCH_RE.test(run.head_branch ?? '');
}

export function isPending(run) {
  return run.conclusion === null || run.conclusion === undefined;
}

export function isRed(run) {
  return ['failure', 'cancelled', 'timed_out'].includes(run.conclusion);
}

export function isConcurrencyCancel(run, log = '') {
  return run.conclusion === 'cancelled' && /cancel-in-progress|concurrency|superseded/i.test(log);
}

/** Pick one run per commit: the CI workflow for push/main, else the newest run. */
export function pickPerCommit(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = run.head_sha;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const picked = [];
  for (const list of groups.values()) {
    const ciRun = list.find((r) => r.name === 'CI');
    if (ciRun) {
      picked.push(ciRun);
      continue;
    }
    const pushMain = list.find((r) => r.event === 'push' && r.head_branch === 'main');
    picked.push(pushMain ?? list[0]);
  }
  return picked;
}

/** Classify one red run from its failed-job log. */
export function classifyRed(run, log = '') {
  if (isConcurrencyCancel(run, log)) return { kind: 'not-red', evidence: 'concurrency cancel (superseded)' };
  const clean = (log ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  const step = (clean.split('\n')[0] ?? '').split('\t').slice(1, -1).join(' ').trim();
  if (detectDaemonHealthSignal(clean)) {
    const knownStep = step && !/unknown step/i.test(step) ? ` ${step}` : '';
    return { kind: 'code', evidence: `${DAEMON_HEALTH_SIGNAL_MARKER}${knownStep}` };
  }
  if (clean.trim() === '') {
    return { kind: 'infra', evidence: 'no steps ran (capacity or runner loss)' };
  }
  if (!step || /unknown step/i.test(step)) {
    return { kind: 'unknown', evidence: step || 'UNKNOWN STEP' };
  }
  const signal = classifyLog(clean);
  if (signal) return { kind: 'infra', evidence: `${step} (${signal})` };
  return { kind: classifyStep(step, clean), evidence: step };
}

const isFirstAttemptGreen = (run) => run.run_attempt === 1 && run.conclusion === 'success';
const shortSha = (run) => run.head_sha?.slice(0, 7) ?? null;

/**
 * M1-01 (C43 §3.2): the current streak of consecutive `push` commits on
 * `main` whose `CI` run succeeded on attempt 1, counted from the newest one
 * backward. A red run, a rerun (attempt > 1) or a commit without a `CI` run
 * ends the streak. Pending runs are not in the sample, so they neither extend
 * nor end it. `firstSha` is the oldest commit in the streak, `lastSha` the
 * newest; both are null when `count` is 0.
 */
export function computePushMainStreak(pushMainRuns) {
  const newestFirst = [...pushMainRuns].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (b.id ?? 0) - (a.id ?? 0)
  );
  const streak = [];
  for (const run of newestFirst) {
    if (run.name !== 'CI' || !isFirstAttemptGreen(run)) break;
    streak.push(run);
  }
  if (streak.length === 0) return { count: 0, firstSha: null, lastSha: null };
  return { count: streak.length, firstSha: shortSha(streak[streak.length - 1]), lastSha: shortSha(streak[0]) };
}

/** The exact line `ci-stats.mjs` prints for the streak (`-` when there is no SHA). */
export function formatStreakLine({ count, firstSha, lastSha }) {
  return `push on main consecutive green first attempt: ${count} (firstSha=${firstSha ?? '-'} lastSha=${lastSha ?? '-'})`;
}

/**
 * Compute the report. `evidence` maps run.id to a failed-job log string.
 * `since` and `sinceC20` are ISO date strings for the two windows.
 */
export function computeStats(runs, { since, sinceC20, evidence = {} } = {}) {
  const inWindow = (r) => !since || Date.parse(r.created_at) >= Date.parse(since);
  const ours = runs.filter((r) => inWindow(r) && !isDependabot(r));
  const dependabot = runs.filter((r) => inWindow(r) && isDependabot(r));
  const pending = ours.filter(isPending);
  const sample = pickPerCommit(ours.filter((r) => !isPending(r)));
  const greenFirst = sample.filter((r) => r.run_attempt === 1 && r.conclusion === 'success');
  const pushMain = sample.filter((r) => r.event === 'push' && r.head_branch === 'main');
  const pushGreen = pushMain.filter((r) => r.run_attempt === 1 && r.conclusion === 'success');
  const missingCIPush = sample.filter(
    (r) => r.event === 'push' && r.head_branch === 'main' && r.name !== 'CI'
  );

  const red = sample.filter(isRed);
  const classified = { code: 0, infra: 0, unknown: 0 };
  const redLines = [];
  for (const run of red) {
    const { kind, evidence: detail } = classifyRed(run, evidence[run.id] ?? '');
    if (kind === 'not-red') {
      redLines.push(`run ${run.id} sha=${run.head_sha?.slice(0, 7)} sha-branch=${run.head_branch} ${detail}`);
      continue;
    }
    classified[kind] += 1;
    redLines.push(
      `red run ${run.id} sha=${run.head_sha?.slice(0, 7)} branch=${run.head_branch} event=${run.event} conclusion=${run.conclusion} kind=${kind} evidence=${detail}`
    );
  }

  let sinceC20Stats = null;
  if (sinceC20) {
    const c20Runs = runs.filter((r) => Date.parse(r.created_at) >= Date.parse(sinceC20) && !isDependabot(r) && !isPending(r));
    const c20Sample = pickPerCommit(c20Runs);
    sinceC20Stats = {
      commits: c20Sample.length,
      greenFirst: c20Sample.filter((r) => r.run_attempt === 1 && r.conclusion === 'success').length,
    };
  }

  return {
    runs: runs.length,
    uniqueSha: sample.length,
    dependabot: dependabot.length,
    pending: pending.length,
    greenFirst: greenFirst.length,
    pushGreen: pushGreen.length,
    pushTotal: pushMain.length,
    pushMainStreak: computePushMainStreak(pushMain),
    missingCIPush: missingCIPush.map((r) => r.head_sha?.slice(0, 7)),
    classified,
    redLines,
    sinceC20Stats,
  };
}
