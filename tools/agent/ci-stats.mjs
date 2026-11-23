#!/usr/bin/env node
/**
 * C25 B2: first-attempt CI success rate over a fixed window.
 *
 * Usage: node tools/agent/ci-stats.mjs [--since ISO] [--paginate]
 *
 * Read-only. Reports separate numbers for our commits, Dependabot updates,
 * pending runs and red-run classification. The pure rules live in
 * `ci-stats-core.mjs` and are covered by `test/agent/ci-stats.node.test.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { computeStats, formatStreakLine } from './ci-stats-core.mjs';
import { ghExecutable, ghSpawnOptions } from './ci-watch.mjs';

// M1-01: no shell. `gh.exe` is found on PATH directly, so Node 24 prints no
// DEP0190 warning and the argument array reaches gh unparsed.
const gh = (args) => execFileSync(ghExecutable(), args, ghSpawnOptions(128 * 1024 * 1024));

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const since = opt('since', '2026-11-17T00:00:00Z'); // fixed window (C22)
const sinceC20 = '2026-11-19T00:00:00Z'; // from C20 (d8233ba) onward
const paginate = args.includes('--paginate');

function allRuns() {
  const out = [];
  let page = 1;
  for (;;) {
    const query = [`/repos/{owner}/{repo}/actions/runs`, '-X', 'GET', '-f', 'per_page=100', '-f', `page=${page}`];
    const list = JSON.parse(gh(['api', ...query])).workflow_runs ?? [];
    out.push(...list);
    if (!paginate || list.length < 100) break;
    page += 1;
  }
  return out;
}

const runs = allRuns();
const evidence = {};
for (const run of runs) {
  if (!['failure', 'cancelled', 'timed_out'].includes(run.conclusion)) continue;
  try {
    evidence[run.id] = gh(['run', 'view', String(run.id), '--attempt', '1', '--log-failed']);
  } catch {
    evidence[run.id] = '';
  }
}

const stats = computeStats(runs, { since, sinceC20, evidence });

console.log(`window since ${since.slice(0, 10)}: runs=${stats.runs} uniqueSha=${stats.uniqueSha}`);
console.log(`push on main (CI workflow) green first attempt: ${stats.pushGreen}/${stats.pushTotal}`);
console.log(formatStreakLine(stats.pushMainStreak));
if (stats.missingCIPush.length > 0) {
  console.log(`no CI push run for commit(s): ${stats.missingCIPush.join(', ')}`);
}
console.log(`our commits green first attempt: ${stats.greenFirst}/${stats.uniqueSha} (${Math.round((100 * stats.greenFirst) / Math.max(1, stats.uniqueSha))}%)`);
console.log(`pending runs (conclusion=null, excluded from sample): ${stats.pending}`);
console.log(`dependabot update runs (separated): ${stats.dependabot}`);
console.log(`red runs (ours): classified code=${stats.classified.code} infra=${stats.classified.infra} unknown=${stats.classified.unknown}`);
if (stats.sinceC20Stats) {
  console.log(`from C20 (d8233ba) since ${sinceC20.slice(0, 10)}: green=${stats.sinceC20Stats.greenFirst}/${stats.sinceC20Stats.commits}`);
}
for (const line of stats.redLines) console.log(line);
