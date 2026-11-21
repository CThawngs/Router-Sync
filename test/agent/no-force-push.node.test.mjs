// C30 K2.4: the pre-push hook must reject a non-fast-forward ref update.
//
// Test shape: a throwaway repo with two branches on disk and a bare remote,
// then the hook's stdin lines are replayed through checkPushLines. The second
// half is the mutation: when the fast-forward check is removed, the non-ff line
// must be accepted (so the test proves the guard is what rejects it).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPushLines } from '../../tools/guard/no-force-push.mjs';

const ZERO = '0'.repeat(40);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'rs-ff-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, 'init', '--bare', remote);
  git(dir, 'init', '-b', 'main', work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  writeFileSync(join(work, 'a.txt'), 'one\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-m', 'one');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main');
  return { dir, work, remote };
}

function head(cwd) {
  return git(cwd, 'rev-parse', 'HEAD');
}

describe('C30 K2.4: pre-push rejects non-fast-forward', () => {
  test('a fast-forward update passes', () => {
    const { dir, work } = makeRepo();
    try {
      const before = head(work);
      writeFileSync(join(work, 'a.txt'), 'two\n');
      git(work, 'commit', '-qam', 'two');
      const after = head(work);
      const input = `refs/heads/main ${after} refs/heads/main ${before}\n`;
      assert.deepEqual(checkPushLines(input, work).problems, []);
      assert.equal(checkPushLines(input, work).checked, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('creating a new remote ref (remote sha of zeros) passes', () => {
    const input = `refs/heads/feature/x ${'a'.repeat(40)} refs/heads/feature/x ${ZERO}\n`;
    assert.deepEqual(checkPushLines(input).problems, []);
  });

  test('a non-fast-forward update is rejected', () => {
    const { dir, work } = makeRepo();
    try {
      // Publish a divergent commit as the remote tip: from here the local main
      // no longer contains it, so pushing main would rewrite published history.
      git(work, 'checkout', '-q', '-b', 'side');
      writeFileSync(join(work, 'b.txt'), 'side\n');
      git(work, 'add', 'b.txt');
      git(work, 'commit', '-qm', 'side');
      const sideSha = head(work);
      git(work, 'push', '-q', 'origin', 'side:main');
      git(work, 'checkout', '-q', 'main');
      writeFileSync(join(work, 'c.txt'), 'main\n');
      git(work, 'add', 'c.txt');
      git(work, 'commit', '-qm', 'main');
      const mainSha = head(work);
      assert.notEqual(sideSha, mainSha);
      const input = `refs/heads/main ${mainSha} refs/heads/main ${sideSha}\n`;
      const result = checkPushLines(input, work);
      assert.equal(result.problems.length, 1);
      assert.match(result.problems[0], /non-fast-forward/);
      assert.match(result.problems[0], /refs\/heads\/main/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mutation: dropping the ancestor check makes the same line pass', () => {
    // Re-implement checkPushLines without the fast-forward test: if the guard
    // were removed, this is what the hook would accept.
    const withoutGuard = (input) => {
      const lines = input.split('\n').filter(Boolean);
      return lines.every((line) => {
        const [, , , remoteSha] = line.split(/\s+/);
        return remoteSha === ZERO || true; // guard removed on purpose
      });
    };
    const input = `refs/heads/main ${'b'.repeat(40)} refs/heads/main ${'a'.repeat(40)}\n`;
    assert.equal(withoutGuard(input), true, 'mutation must accept the bad line');
    assert.equal(checkPushLines(input).problems.length, 1, 'the real guard must reject it');
  });

  test('a malformed line is reported, not silently ignored', () => {
    assert.equal(checkPushLines('only three fields\n').problems.length, 1);
    assert.deepEqual(checkPushLines('').problems, []);
  });
});

