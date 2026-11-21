#!/usr/bin/env node
/**
 * C22 Z3: point core.hooksPath at tools/hooks/ so the pre-push gate is used.
 * Deliberately NOT run automatically — the owner decides.
 *
 * Usage: pnpm hooks:install
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const hooksDir = path.resolve('tools/hooks');
if (!existsSync(path.join(hooksDir, 'pre-push'))) {
  console.error(`missing ${path.join(hooksDir, 'pre-push')}`);
  process.exit(1);
}
if (!existsSync(path.join(hooksDir, 'pre-commit'))) {
  console.error(`missing ${path.join(hooksDir, 'pre-commit')}`);
  process.exit(1);
}

const before = execFileSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
execFileSync('git', ['config', 'core.hooksPath', 'tools/hooks'], { stdio: 'inherit' });

console.log(`core.hooksPath: ${before || '(unset)'} -> tools/hooks`);
console.log('pre-commit will refuse direct commits on main.');
console.log('pre-push will run: pnpm lint, pnpm typecheck:changed, pnpm test:changed, validate-workflows');