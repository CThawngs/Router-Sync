import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeStats, isDependabot, pickPerCommit, classifyRed } from '../../tools/agent/ci-stats-core.mjs';
// Namespace import: a symbol added by M1-01 is read as a property, so a missing
// export fails only the test that needs it instead of the whole file.
import * as core from '../../tools/agent/ci-stats-core.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

const run = (over) => ({
  id: 1,
  head_sha: 'aaaaaaa0000000',
  head_branch: 'feature/x',
  event: 'pull_request',
  run_attempt: 1,
  conclusion: 'success',
  name: 'CI',
  created_at: '2026-11-19T10:00:00Z',
  ...over,
});

describe('C25 B2: stats must match their labels', () => {
  test('dependabot is separated by event AND branch prefix', () => {
    assert.equal(isDependabot(run({ event: 'dynamic' })), true);
    assert.equal(isDependabot(run({ head_branch: 'dependabot/npm_and_yarn/x-1.0' })), true);
    assert.equal(isDependabot(run()), false);
    const stats = computeStats([
      run({ id: 1 }),
      run({ id: 2, head_sha: 'bbbbbbb0000000', event: 'dynamic' }),
      run({ id: 3, head_sha: 'ccccccc0000000', head_branch: 'dependabot/npm_and_yarn/x-1.0' }),
    ], { since: '2026-11-17T00:00:00Z' });
    assert.equal(stats.greenFirst, 1);
    assert.equal(stats.uniqueSha, 1);
    assert.equal(stats.dependabot, 2);
  });

  test('CI workflow wins over dynamic for the same commit; missing CI push is reported', () => {
    const picked = pickPerCommit([
      run({ id: 10, name: 'dynamic', event: 'push', head_branch: 'main', head_sha: 'ddddddd0000000', conclusion: 'failure' }),
      run({ id: 11, name: 'CI', event: 'push', head_branch: 'main', head_sha: 'ddddddd0000000', conclusion: 'success' }),
    ]);
    assert.equal(picked.length, 1);
    assert.equal(picked[0].name, 'CI');
    assert.equal(picked[0].conclusion, 'success');

    const stats = computeStats([run({ id: 12, name: 'dynamic', event: 'push', head_branch: 'main' })], { since: '2026-11-17T00:00:00Z' });
    assert.deepEqual(stats.missingCIPush, ['aaaaaaa']);
  });

  test('pending runs with conclusion=null are excluded but counted', () => {
    const stats = computeStats([
      run({ id: 20, head_sha: 'eeeeeee0000000' }),
      run({ id: 21, head_sha: 'ffffffff00000', conclusion: null }),
    ], { since: '2026-11-17T00:00:00Z' });
    assert.equal(stats.uniqueSha, 1);
    assert.equal(stats.pending, 1);
  });

  test('UNKNOWN STEP is unknown, not infra; cancelled by concurrency is not red', () => {
    assert.equal(classifyRed(run({ conclusion: 'failure' }), 'UNKNOWN STEP\tboom').kind, 'unknown');
    assert.equal(classifyRed(run({ conclusion: 'failure' }), '').kind, 'infra');
    assert.equal(classifyRed(run({ conclusion: 'failure' }), 'job\tRun Tests\tsomething AssertionError: x').kind, 'code');
    assert.equal(classifyRed(run({ conclusion: 'cancelled' }), 'cancel-in-progress: superseded').kind, 'not-red');
  });

  test('window and from-C20 column use the pass-through filters', () => {
    const stats = computeStats([
      run({ id: 30, head_sha: '11111110000000', created_at: '2026-11-16T10:00:00Z' }),
      run({ id: 31, head_sha: '22222220000000', created_at: '2026-11-20T10:00:00Z' }),
    ], { since: '2026-11-17T00:00:00Z', sinceC20: '2026-11-19T00:00:00Z' });
    assert.equal(stats.uniqueSha, 1);
    assert.equal(stats.sinceC20Stats.greenFirst, 1);
    assert.equal(stats.sinceC20Stats.commits, 1);
  });
});

describe('M1-01 (a): consecutive push-on-main first-attempt green streak', () => {
  const WINDOW = { since: '2026-11-17T00:00:00Z' };
  const pushMain = (sha, minute, over = {}) =>
    run({
      id: 1000 + minute,
      head_sha: `${sha.repeat(7)}0000000`,
      head_branch: 'main',
      event: 'push',
      created_at: `2026-11-20T10:${String(minute).padStart(2, '0')}:00Z`,
      ...over,
    });

  test('counts from the newest push on main back to the first non-green one', () => {
    const runs = [
      // Given out of order on purpose: the streak must follow created_at.
      pushMain('e', 50),
      pushMain('a', 10),
      pushMain('c', 30),
      pushMain('b', 20, { conclusion: 'failure' }),
      pushMain('d', 40),
      // Noise that must not break or extend the streak.
      run({ id: 2001, head_sha: '99999990000000', created_at: '2026-11-20T10:45:00Z', conclusion: 'failure' }),
      run({ id: 2002, head_sha: '88888880000000', event: 'dynamic', head_branch: 'dependabot/npm_and_yarn/x-1.0', created_at: '2026-11-20T10:46:00Z', conclusion: 'failure' }),
    ];
    const stats = computeStats(runs, WINDOW);
    assert.deepEqual(stats.pushMainStreak, { count: 3, firstSha: 'ccccccc', lastSha: 'eeeeeee' });
  });

  test('a green run on attempt 2 breaks the streak', () => {
    const stats = computeStats([
      pushMain('a', 10),
      pushMain('b', 20),
      pushMain('c', 30, { run_attempt: 2 }),
      pushMain('d', 40),
    ], WINDOW);
    assert.deepEqual(stats.pushMainStreak, { count: 1, firstSha: 'ddddddd', lastSha: 'ddddddd' });
  });

  test('a red newest push on main gives count=0 with null SHAs', () => {
    const stats = computeStats([pushMain('a', 10), pushMain('b', 20, { conclusion: 'failure' })], WINDOW);
    assert.deepEqual(stats.pushMainStreak, { count: 0, firstSha: null, lastSha: null });
  });

  test('no push on main at all gives count=0', () => {
    const stats = computeStats([run({ id: 3001 })], WINDOW);
    assert.deepEqual(stats.pushMainStreak, { count: 0, firstSha: null, lastSha: null });
  });

  test('a pending newest push on main is skipped, not a break', () => {
    const stats = computeStats([pushMain('a', 10), pushMain('b', 20), pushMain('c', 30, { conclusion: null })], WINDOW);
    assert.deepEqual(stats.pushMainStreak, { count: 2, firstSha: 'aaaaaaa', lastSha: 'bbbbbbb' });
  });

  test('the CLI line has the exact contract format', () => {
    assert.equal(typeof core.formatStreakLine, 'function', 'formatStreakLine must be exported');
    assert.equal(
      core.formatStreakLine({ count: 3, firstSha: 'ccccccc', lastSha: 'eeeeeee' }),
      'push on main consecutive green first attempt: 3 (firstSha=ccccccc lastSha=eeeeeee)'
    );
    assert.equal(
      core.formatStreakLine({ count: 0, firstSha: null, lastSha: null }),
      'push on main consecutive green first attempt: 0 (firstSha=- lastSha=-)'
    );
  });

  test('ci-stats.mjs prints the streak line', () => {
    const source = readFileSync(join(ROOT, 'tools', 'agent', 'ci-stats.mjs'), 'utf8');
    assert.match(source, /formatStreakLine\(stats\.pushMainStreak\)/);
  });
});

describe('M1-01 (b): daemon health signal is a code failure in ci-stats', () => {
  const SIGNAL_LOG = [
    'verify (ubuntu-24.04-arm, node 22)\tEnd-to-end tests\t2026-11-20T10:00:00Z daemon health failed; exited=false exitCode=null stdout= stderr=',
    'verify (ubuntu-24.04-arm, node 22)\tEnd-to-end tests\t2026-11-20T10:00:01Z socket hang up',
  ].join('\n');

  test('classifyRed returns code with the marker even next to an infra string', () => {
    const out = classifyRed(run({ conclusion: 'failure' }), SIGNAL_LOG);
    assert.equal(out.kind, 'code');
    assert.match(out.evidence, /\[E2E-DAEMON-HEALTH-SIGNAL\]/);
  });

  test('the signal on an UNKNOWN STEP line is code, never unknown', () => {
    const out = classifyRed(run({ conclusion: 'failure' }), 'UNKNOWN STEP\tdaemon health failed; exited=true exitCode=1');
    assert.equal(out.kind, 'code');
    assert.match(out.evidence, /\[E2E-DAEMON-HEALTH-SIGNAL\]/);
  });

  test('computeStats counts it as code and prints the marker in the red line', () => {
    const red = run({ id: 4001, head_sha: 'abcdef10000000', conclusion: 'failure' });
    const stats = computeStats([red], { since: '2026-11-17T00:00:00Z', evidence: { 4001: SIGNAL_LOG } });
    assert.deepEqual(stats.classified, { code: 1, infra: 0, unknown: 0 });
    assert.match(stats.redLines[0], /kind=code evidence=\[E2E-DAEMON-HEALTH-SIGNAL\]/);
  });
});

describe('M1-01 (c): gh is spawned without a shell (no DEP0190)', () => {
  const sourceOf = (file) => readFileSync(join(ROOT, 'tools', 'agent', file), 'utf8');

  test('ci-stats.mjs and ci-watch.mjs pass no shell option to child_process', () => {
    for (const file of ['ci-stats.mjs', 'ci-watch.mjs']) {
      assert.doesNotMatch(sourceOf(file), /\bshell\s*:/, `${file} must not set a shell option`);
    }
  });

  test('ci-stats.mjs uses the shared gh helpers', () => {
    const source = sourceOf('ci-stats.mjs');
    assert.match(source, /ghExecutable\(\)/);
    assert.match(source, /ghSpawnOptions\(/);
  });

  test('the shared spawn options emit no DEP0190 warning on stderr', () => {
    const watchUrl = pathToFileURL(join(ROOT, 'tools', 'agent', 'ci-watch.mjs')).href;
    // A child process spawns `node -e` with an argument array using the same
    // options as `gh`. DEP0190 is printed by the parent of that spawn.
    const script = [
      "import { spawnSync } from 'node:child_process';",
      `import { ghSpawnOptions } from ${JSON.stringify(watchUrl)};`,
      "const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(1 + 1))'], ghSpawnOptions(1024 * 1024));",
      'process.stdout.write(String(r.stdout));',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '2');
    assert.doesNotMatch(child.stderr, /DEP0190/);
    assert.equal(child.stderr, '');
  });
});
