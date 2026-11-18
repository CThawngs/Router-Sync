#!/usr/bin/env node
/**
 * tools/agent/typecheck-changed.mjs
 *
 * typecheck:changed — run typecheck only for packages with changed files
 * relative to origin/main. Files outside packages/ trigger root tsc.
 *
 * NOTE: This does NOT replace `pnpm typecheck` before opening a PR.
 *       Run `pnpm typecheck` for a full check before merging.
 */
import { execSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';

console.error('[typecheck:changed] NOTE: Does NOT replace `pnpm typecheck` before opening a PR.');

let changedFiles;
try {
  const out = execSync('git diff --name-only origin/main...HEAD', { encoding: 'utf8' });
  changedFiles = out.trim().split('\n').filter(Boolean);
} catch {
  console.error('[typecheck:changed] Could not diff against origin/main — running full typecheck');
  const r = spawnSync('pnpm', ['typecheck'], { stdio: 'inherit', shell: true });
  process.exit(r.status ?? 1);
}

if (changedFiles.length === 0) {
  console.error('[typecheck:changed] No changed files. Nothing to check.');
  process.exit(0);
}

// Find changed packages
const changedPackages = new Set();
let rootChanged = false;

for (const f of changedFiles) {
  const m = f.match(/^packages\/([^/]+)\//);
  if (m) {
    changedPackages.add(m[1]);
  } else {
    rootChanged = true;
  }
}

let failed = false;

if (rootChanged) {
  console.error('[typecheck:changed] Root files changed — running root tsc');
  const r = spawnSync('pnpm', ['exec', 'tsc', '--noEmit'], { stdio: 'inherit', shell: true });
  if (r.status !== 0) failed = true;
}

for (const pkg of changedPackages) {
  const pkgDir = path.join('packages', pkg);
  // Check if package has a typecheck script
  let hasTc = false;
  try {
    const pkgJson = JSON.parse(
      new TextDecoder().decode(await import('node:fs').then((fs) => fs.promises.readFile(path.join(pkgDir, 'package.json'))))
    );
    hasTc = Boolean(pkgJson?.scripts?.typecheck);
  } catch {
    // no package.json or no typecheck script — skip
  }
  if (!hasTc) {
    console.error(`[typecheck:changed] packages/${pkg}: no typecheck script, skipping`);
    continue;
  }
  console.error(`[typecheck:changed] packages/${pkg}: running typecheck`);
  const r = spawnSync('pnpm', ['--filter', `@routersync/${pkg}`, 'typecheck'], {
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
