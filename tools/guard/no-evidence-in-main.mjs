#!/usr/bin/env node
/**
 * tools/guard/no-evidence-in-main.mjs
 *
 * PURPOSE: the evidence/ tree is capture output for evidence branches only.
 * Branch `evidence/*` is pushed with [skip ci] and never merged; main CI must
 * reject any commit that tracks evidence/ files. Keeps the main history clean
 * and keeps capture output (which can name private providers) out of PRs.
 *
 * READ-ONLY: inspects git index only.
 */
import { execSync } from 'node:child_process';

let tracked = '';
try {
  tracked = execSync('git ls-files evidence', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch {
  tracked = '';
}

if (tracked) {
  console.error('evidence/ files are tracked; they belong on an evidence/* branch only:');
  for (const line of tracked.split('\n')) console.error(`  ${line}`);
  process.exit(1);
}
console.log('no-evidence-in-main: OK, evidence/ is not tracked');
