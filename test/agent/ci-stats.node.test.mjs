import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, isDependabot, pickPerCommit, classifyRed } from '../../tools/agent/ci-stats-core.mjs';

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
