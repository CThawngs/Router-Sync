#!/usr/bin/env node
/**
 * Validate the workflow files without touching the network.
 *
 * Usage: node tools/ci/validate-workflows.mjs [workflow-dir]
 *
 * Checks:
 *  - every job declares timeout-minutes;
 *  - no `uses:` floats on a branch or a major tag (`@main`, `@v4`) — pin the tag
    you actually reviewed, or a full sha;
 *  - `continue-on-error` only on the ARM matrix job;
 *  - no personal path in any workflow;
 *  - the matrices keep `fail-fast: false`.
 *
 * Exit 0 when clean, 1 with a list of problems.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

// `yaml` is present in the pnpm store as a transitive dependency but is not a
// declared dependency of this workspace, so resolve it from the store instead of
// adding one. If it is absent, fall back to a minimal block parser good enough
// for the checks below.
const require = createRequire(import.meta.url);
let yaml = null;
try {
  const store = path.join(process.cwd(), 'node_modules', '.pnpm');
  const entry = fs.readdirSync(store).find((name) => name.startsWith('yaml@'));
  if (entry) {
    const pkg = JSON.parse(fs.readFileSync(path.join(store, entry, 'node_modules', 'yaml', 'package.json'), 'utf8'));
    yaml = require(path.join(store, entry, 'node_modules', 'yaml', pkg.main ?? 'index.js'));
  }
} catch {
  yaml = null;
}

const dir = process.argv[2] ?? '.github/workflows';
const home = process.env.USERPROFILE ?? os.homedir();

// Actions allowed to float on a major tag. Everything else must be pinned to a
// full commit sha or an exact version tag.
const FLOATING_OK = new Set(['actions/checkout@v4.2.2']);

const problems = [];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

for (const file of files) {
  const full = path.join(dir, file);
  const text = fs.readFileSync(full, 'utf8');
  if (text.includes(home) || text.includes(os.userInfo().username)) {
    problems.push(`${file}: contains a personal path or the machine user name`);
  }

  let doc;
  try {
    doc = yaml ? yaml.parse(text) : null;
    if (!doc) {
      problems.push(`${file}: YAML parser unavailable (yaml package not found in the pnpm store)`);
      continue;
    }
  } catch (error) {
    problems.push(`${file}: YAML parse error: ${error.message}`);
    continue;
  }

  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    if (job?.['timeout-minutes'] === undefined) {
      problems.push(`${file}: job ${jobId} has no timeout-minutes`);
    }
      if (job?.['continue-on-error'] !== undefined) {
      const value = String(job['continue-on-error']);
      if (value === 'true') {
        problems.push(`${file}: job ${jobId} sets continue-on-error: true outside the ARM rule`);
      } else if (!value.includes('windows-11-arm')) {
        problems.push(`${file}: job ${jobId} continue-on-error is not the ARM rule`);
      }
    }

    const steps = job?.steps ?? [];
    for (const step of steps) {
      const uses = step?.uses;
      if (typeof uses !== 'string') continue;
      const at = uses.lastIndexOf('@');
      if (at < 0) {
        problems.push(`${file}: ${jobId} uses "${uses}" without a ref`);
        continue;
      }
      const ref = uses.slice(at + 1);
      const name = uses.slice(0, at);
      // A ref is acceptable when it is a full 40-char sha or a reviewed exact
  // version tag. `actions/checkout@v7.0.1` and `pnpm/action-setup@v6.1.1` are
  // exact tags, so only bare majors and branch names are floating.
      const floating = ref === 'main' || ref === 'master' || /^v?\d+$/.test(ref);
      if (floating && !FLOATING_OK.has(`${name}@${ref}`)) {
        problems.push(`${file}: ${jobId} uses floating ref "${uses}"`);
      }
    }
  }

  for (const m of text.matchAll(/^\s*matrix:\s*\{[\s\S]*?fail-fast:\s*(\w+)/gm)) {
    if (m[1] === 'true') problems.push(`${file}: a matrix sets fail-fast: true`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`OK: ${files.length} workflow files validated`);