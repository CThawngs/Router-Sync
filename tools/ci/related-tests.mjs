#!/usr/bin/env node
/**
 * V0: pick and run the tests that can actually catch a regression for the
 * current branch, instead of `vitest run --changed` (which only looks at the
 * uncommitted working tree and therefore selects nothing after a commit).
 *
 * Usage: node tools/ci/related-tests.mjs [--base origin/main] [--list]
 *
 * Steps:
 *  1. `git diff --name-only <base>...HEAD` for changed files.
 *  2. Separate test files from source files.
 *  3. `vitest related --run <files>` with the changed source files (vitest maps a
 *     source module to the tests that import it) plus the changed test files.
 *  4. If nothing is selected but `packages/` source changed, say so loudly and
 *     run that package's own tests instead.
 *
 * Exit code: vitest's, or 0 when there is nothing to run.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const baseIx = args.indexOf('--base');
const base = baseIx >= 0 ? args[baseIx + 1] : 'origin/main';
const listOnly = args.includes('--list');

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || `git exited ${r.status}`);
  return (r.stdout || '').trim();
}

let changed = [];
try {
  changed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
} catch (error) {
  console.error(`related-tests: cannot diff against ${base}: ${error.message}`);
  process.exit(0);
}

const TEST_RE = /(^|\/)(test|tests)\/.*\.(test|spec)\.(ts|tsx|js|mjs)$/;
const tests = changed.filter((f) => TEST_RE.test(f));
const sources = changed.filter((f) => !TEST_RE.test(f) && /\.(ts|tsx|js|mjs)$/.test(f));
const packagedSources = sources.filter((f) => f.startsWith('packages/'));

// Vitest `related` accepts source modules and reports the tests that import them.
const inputs = [...sources, ...tests];

if (listOnly) {
  process.stdout.write(`${JSON.stringify({ changed: changed.length, sources: sources.length, tests: tests.length, inputs })}\n`);
  process.exit(0);
}

if (inputs.length === 0) {
  console.log('related-tests: no changed source or test files; nothing to run.');
  process.exit(0);
}

const vitest = spawnSync('pnpm', ['exec', 'vitest', 'related', '--run', ...inputs], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (vitest.status === 0) {
  // `vitest related` prints "No test files found" when nothing matched; that is
  // not evidence that the branch is sound.
  const pkgRoots = [...new Set(packagedSources.map((f) => f.split('/')[1]))];
  if (tests.length === 0 && pkgRoots.length > 0) {
    console.error(`related-tests: WARNING 0 tests selected although packages changed (${pkgRoots.join(', ')}).`);
    console.error('related-tests: this is NOT evidence that the change is sound; CI will run the full suite.');
  }
}
process.exit(vitest.status ?? 1);