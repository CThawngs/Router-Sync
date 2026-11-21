import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HOOK = join(process.cwd(), 'tools/hooks/pre-commit');

function gitBash() {
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', '/usr/bin/bash', '/bin/bash']) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Convert a Windows path (C:\a\b) to the MSYS form (/c/a/b) Git Bash uses. */
function msys(p) {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}

/** Run the hook with a fake `git` on PATH so `git rev-parse --abbrev-ref HEAD`
 *  returns the branch we want. */
function runHook(branch) {
  const bash = gitBash();
  assert.ok(bash, 'Git Bash must be available to run the hook');
  const dir = join(tmpdir(), `c27-hook-${branch.replace(/\W/g, '_')}`);
  mkdirSync(dir, { recursive: true });
  const gitPath = join(dir, 'git');
  // LF line endings; Git Bash executes it fine.
  writeFileSync(gitPath, `#!/bin/sh\necho ${branch}\n`);
  chmodSync(gitPath, 0o755);
  const res = spawnSync(bash, ['-c', `PATH="${msys(dir)}:$PATH" "${msys(HOOK)}"`], {
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('C27 G1.3: pre-commit hook refuses direct commits on main', () => {
  before(() => chmodSync(HOOK, 0o755));

  it('is a bash script that reads the current branch', () => {
    const text = readFileSync(HOOK, 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env bash'), 'shebang');
    assert.ok(text.includes('git rev-parse --abbrev-ref HEAD'), 'reads the current branch');
    assert.ok(text.includes('"main"') && text.includes('"master"'), 'blocks main and master');
    assert.ok(text.includes('exit 1'), 'exits 1 when blocked');
  });

  it('blocks a commit when HEAD is main', () => {
    const res = runHook('main');
    assert.equal(res.status, 1, 'must fail on main');
    assert.ok(res.stderr.includes('[precommit] FAIL'), `prints the refusal: ${res.stderr}`);
  });

  it('blocks a commit when HEAD is master', () => {
    const res = runHook('master');
    assert.equal(res.status, 1, 'must fail on master');
  });

  it('allows a commit on a feature branch', () => {
    const res = runHook('fix/c27-closeout');
    assert.equal(res.status, 0, `must pass on a feature branch: ${res.stderr}`);
  });
});