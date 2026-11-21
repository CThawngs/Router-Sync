#!/usr/bin/env node
// tools/guard/no-force-push.mjs
//
// C30 K2.4: refuse a non-fast-forward push.
//
// Git's pre-push hook feeds stdin one line per ref update:
//   <local ref> <local sha> <remote ref> <remote sha>
// A remote sha of 40 zeros means the remote ref does not exist yet (create).
// Anything else must have the remote sha as an ancestor of the local sha;
// otherwise the push would rewrite published history and is rejected.
//
// Exit 0 = every update is a fast-forward, 1 = at least one is not.
// Reads stdin and `git merge-base`; never writes.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ZERO = '0'.repeat(40);

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** True when `ancestor` is reachable from `descendant` in the given repo. */
export function isAncestor(ancestor, descendant, cwd = process.cwd()) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    stdio: 'ignore',
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  // Not a repo or an unknown object: fail closed rather than guess.
  return false;
}

export function checkPushLines(input, cwd = process.cwd()) {
  const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
  const problems = [];
  let checked = 0;
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) {
      problems.push('cannot parse a line shaped "<local ref> <local sha> <remote ref> <remote sha>"');
      continue;
    }
    const [, localSha, remoteRef, remoteSha] = parts;
    if (remoteSha === ZERO) continue; // create: nothing published to rewrite
    if (localSha === ZERO) continue; // delete: allowed, needs its own review
    checked += 1;
    if (localSha === remoteSha) continue; // no-op update
    if (!isAncestor(remoteSha, localSha, cwd)) {
      problems.push(
        `${remoteRef}: ${remoteSha.slice(0, 7)} is not an ancestor of ${localSha.slice(0, 7)} (non-fast-forward)`
      );
    }
  }
  return { problems, checked, total: lines.length };
}

function main() {
  const input = readStdin();
  if (input.trim() === '') {
    console.log('[no-force-push] no ref updates to check');
    return 0;
  }
  const { problems, checked, total } = checkPushLines(input);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[no-force-push] ${problem}`);
    console.error('[no-force-push] force-push is forbidden: push a new branch or merge instead');
    return 1;
  }
  console.log(`[no-force-push] OK, ${checked}/${total} ref update(s) checked, all fast-forward`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main());