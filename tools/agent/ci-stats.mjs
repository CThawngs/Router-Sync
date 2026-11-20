#!/usr/bin/env node
/**
 * C22 Z5: first-attempt CI success rate over a window.
 *
 * Usage: node tools/agent/ci-stats.mjs [days] [sinceIso]
 *
 * Read-only. Prints one line per push sha with the conclusion of attempt 1, then
 * the aggregate. Never prints log content.
 */
import { execFileSync } from 'node:child_process';

const gh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });

const days = Number(process.argv[2] ?? 14);
const sinceArg = process.argv[3];
const since = sinceArg ?? new Date(Date.now() - days * 86400000).toISOString();

const runs = JSON.parse(gh(['api', '/repos/{owner}/{repo}/actions/runs', '-X', 'GET', '-f', 'per_page=100'])).workflow_runs;
const rows = runs
  .filter((r) => Date.parse(r.created_at) >= Date.parse(since))
  .filter((r) => r.event !== 'dynamic')
  .filter((r) => r.name !== 'Dependabot Updates')
  .map((r) => ({
    id: r.id,
    branch: r.head_branch,
    sha: r.head_sha.slice(0, 7),
    event: r.event,
    attempt: r.run_attempt,
    conclusion: r.conclusion,
    createdAt: r.created_at,
  }))
  .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

// One row per sha: the first run for that commit is the "first attempt" signal.
const seen = new Set();
const perSha = [];
for (const row of rows) {
  if (seen.has(row.sha)) continue;
  seen.add(row.sha);
  perSha.push(row);
}

const pushes = perSha.filter((r) => r.event === 'push');
const greenFirst = perSha.filter((r) => r.attempt === 1 && r.conclusion === 'success');
const pushed = perSha.filter((r) => r.event === 'push' || r.event === 'pull_request');

console.log(`window since ${since.slice(0, 10)}: runs=${rows.length} uniqueSha=${perSha.length}`);
console.log(`push sha green on attempt 1: ${greenFirst.filter((r) => r.event === 'push').length}/${pushes.length}`);
console.log(`all sha green on attempt 1: ${greenFirst.length}/${perSha.length}`);
console.log(`sha with attempt>1: ${perSha.filter((r) => r.attempt > 1).length}`);
console.log('\nsha | branch | event | attempt | conclusion');
for (const r of perSha) {
  console.log(`${r.sha} | ${r.branch} | ${r.event} | ${r.attempt} | ${r.conclusion}`);
}