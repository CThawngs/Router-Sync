#!/usr/bin/env node
/**
 * C23 V4: first-attempt CI success rate over a window.
 *
 * Usage: node tools/agent/ci-stats.mjs [--days 14] [--since Iso] [--paginate]
 *
 * Read-only. Reports two numbers, because they answer different questions:
 *   - push runs on main   ("is a merged commit safe?")
 *   - every commit        ("does the branch work cause red runs and mail?")
 * Dependabot update runs (event == "dynamic") are separated out.
 * Red runs are classified as code or infra from the attempt-1 failed log, using
 * the same step-aware rule as ci-watch.
 */
import { execFileSync } from 'node:child_process';
import { classifyStep } from './ci-watch.mjs';

const gh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, shell: process.platform === 'win32' });

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const days = Number(opt('days', '14'));
const since = opt('since', new Date(Date.now() - days * 86400000).toISOString());
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

const runs = allRuns().filter((r) => Date.parse(r.created_at) >= Date.parse(since));

// Newest run per commit is the "first attempt" signal.
const perSha = new Map();
for (const r of runs) {
  const key = r.head_sha;
  if (!perSha.has(key)) perSha.set(key, r);
}

const rows = [...perSha.values()].map((r) => ({
  id: r.id,
  sha: r.head_sha.slice(0, 7),
  branch: r.head_branch,
  event: r.event,
  attempt: r.run_attempt,
  conclusion: r.conclusion,
  name: r.name,
}));

const ours = rows.filter((r) => r.event !== 'dynamic');
const dependabot = rows.filter((r) => r.event === 'dynamic');
const pushes = ours.filter((r) => r.event === 'push');
const greenFirst = ours.filter((r) => r.attempt === 1 && r.conclusion === 'success');
const greenFirstPush = pushes.filter((r) => r.attempt === 1 && r.conclusion === 'success');

// Classify red runs (bounded, to keep the tool quick).
const red = ours.filter((r) => ['failure', 'cancelled', 'timed_out'].includes(r.conclusion));
const classified = { code: 0, infra: 0, unknown: 0 };
for (const r of red.slice(0, 40)) {
  let log = '';
  try {
    log = gh(['run', 'view', r.id, '--attempt', '1', '--log-failed']);
  } catch {
    classified.unknown += 1;
    continue;
  }
  const clean = log.replace(/\u001b\[[0-9;]*m/g, '');
  const step = (clean.split('\n')[0] ?? '').split('\t').slice(1, -1).join(' ');
  const kind = classifyStep(step, clean);
  if (kind === 'infra') classified.infra += 1;
  else classified.code += 1;
}

console.log(`window since ${since.slice(0, 10)}: runs=${runs.length} uniqueSha=${rows.length}`);
console.log(`push on main green first attempt: ${greenFirstPush.length}/${pushes.length}`);
console.log(`all non-dependabot commits green first attempt: ${greenFirst.length}/${ours.length}`);
console.log(`commits needing attempt>1: ${ours.filter((r) => r.attempt > 1).length}`);
console.log(`dependabot update runs: ${dependabot.length}`);
console.log(`red runs (non-dependabot): ${red.length} -> code=${classified.code} infra=${classified.infra} unknown=${classified.unknown}`);
console.log('\nsha | branch | event | attempt | conclusion');
for (const r of rows) console.log(`${r.sha} | ${r.branch} | ${r.event} | ${r.attempt} | ${r.conclusion}`);