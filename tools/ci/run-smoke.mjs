#!/usr/bin/env node
/**
 * Product smoke with perf budgets.
 *
 * Runs each smoke command with ROUTERSYNC_PERF=1, then checks its perf line
 * against budgets.json. Every command is attempted even after a failure, so one
 * report lists all breaches instead of stopping at the first.
 *
 * Why this is a script and not a bash function: the previous CI step called a
 * bash function from `if ! run_smoke; then`, where `set -e` is disabled inside
 * the function body. A failing `check-perf.mjs` in the middle of the loop was
 * therefore ignored and the step exited with the status of the LAST command.
 * Accumulating the exit code here makes that class of bug impossible to repeat.
 *
 * Exit code: 0 when every command is within budget (after the retry), 1 otherwise.
 *
 * Test hooks (all optional):
 *   RS_SMOKE_CLI         path to the CLI entry, default packages/cli/dist/index.js
 *   RS_CHECK_PERF        path to the perf checker, default tools/ci/check-perf.mjs
 *   RS_SMOKE_PERF_DIR    directory for the captured streams
 *   RS_SMOKE_ATTEMPTS    attempts before giving up, default 2
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI = process.env.RS_SMOKE_CLI ?? 'packages/cli/dist/index.js';
const CHECK_PERF = process.env.RS_CHECK_PERF ?? 'tools/ci/check-perf.mjs';
const PERF_DIR = process.env.RS_SMOKE_PERF_DIR ?? path.join(tmpdir(), 'rs-perf');
const ATTEMPTS = Math.max(1, Number(process.env.RS_SMOKE_ATTEMPTS ?? 2));

const COMMANDS = [
  { name: 'doctor', args: ['doctor'] },
  { name: 'plan', args: ['plan'] },
  { name: 'verify', args: ['verify'] },
  { name: 'scan', args: ['scan'] },
  { name: 'rank-json', args: ['rank', '--json'] },
];

function runCommand(entry) {
  const outFile = path.join(PERF_DIR, `${entry.name}.out`);
  const errFile = path.join(PERF_DIR, `${entry.name}.err`);

  const cli = spawnSync(process.execPath, [CLI, ...entry.args], {
    env: { ...process.env, ROUTERSYNC_PERF: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  writeFileSync(outFile, cli.stdout ?? '', 'utf8');
  writeFileSync(errFile, cli.stderr ?? '', 'utf8');

  if (cli.error) {
    console.error(`SMOKE FAIL ${entry.name}: ${cli.error.message}`);
    return 1;
  }
  if (cli.status !== 0) {
    console.error(`SMOKE FAIL ${entry.name}: command exited ${cli.status}`);
    return 1;
  }

  const check = spawnSync(process.execPath, [CHECK_PERF, errFile, entry.name], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (check.stdout) process.stdout.write(check.stdout);
  if (check.stderr) process.stderr.write(check.stderr);

  if (check.error) {
    console.error(`SMOKE FAIL ${entry.name}: ${check.error.message}`);
    return 1;
  }
  if (check.status !== 0) {
    console.error(`SMOKE FAIL ${entry.name}: over budget`);
    return 1;
  }
  return 0;
}

function attempt() {
  mkdirSync(PERF_DIR, { recursive: true });
  let failures = 0;
  for (const entry of COMMANDS) {
    if (runCommand(entry) !== 0) failures += 1;
  }
  if (failures > 0) console.error(`SMOKE SUMMARY: ${failures}/${COMMANDS.length} over budget`);
  else console.log(`SMOKE SUMMARY: ${COMMANDS.length}/${COMMANDS.length} within budget`);
  return failures === 0 ? 0 : 1;
}

let lastResult = 1;
for (let i = 1; i <= ATTEMPTS; i += 1) {
  if (i > 1) console.log(`RETRY: product smoke failed once; retrying once`);
  lastResult = attempt();
  if (lastResult === 0) break;
}
process.exit(lastResult);