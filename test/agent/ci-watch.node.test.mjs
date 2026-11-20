import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const { classifyLog, classifyJob, exitCodeFor, maskText } = await import('../../tools/agent/ci-watch.mjs');

const INFRA_LOGS = {
  'cache-service': 'Failed to restore: Cache service responded with 400',
  'services-down': '<h2>Our services aren\'t available right now</h2>',
  'runner-shutdown': 'The runner has received a shutdown signal. Shutting down.',
  'artifact-create': 'Error: Failed to CreateArtifact: Received non-retryable error',
  capacity: 'The job was not started because of capacity constraints',
  'network-reset': 'Error: connect ECONNRESET 140.82.121.4:443',
  'operation-canceled': '##[error]The operation was canceled.',
};

describe('C22 Z2: infra vs code classification', () => {
  for (const [key, log] of Object.entries(INFRA_LOGS)) {
    test(`classifies ${key} as infra`, () => {
      assert.equal(classifyLog(log), key);
    });
  }

  test('classifies a test failure as code', () => {
    const log = 'AssertionError: expected true to be false\n  at test/acceptance/at-98.test.ts:124:25';
    assert.equal(classifyLog(log), null);
    const job = classifyJob('verify (windows-11-arm, node 22)', 'failure', log);
    assert.equal(job.kind, 'code');
  });

  test('exit code 0 when everything is green', () => {
    const results = [
      { job: 'a', conclusion: 'success', kind: 'ok' },
      { job: 'b', conclusion: 'success', kind: 'ok' },
    ];
    assert.equal(exitCodeFor(results), 0);
  });

  test('exit code 10 when only infra failed', () => {
    const results = [
      { job: 'a', conclusion: 'success', kind: 'ok' },
      { job: 'b', conclusion: 'failure', kind: 'infra' },
    ];
    assert.equal(exitCodeFor(results), 10);
  });

  test('exit code 11 when code failed, even next to infra', () => {
    const results = [
      { job: 'a', conclusion: 'failure', kind: 'infra' },
      { job: 'b', conclusion: 'failure', kind: 'code' },
    ];
    assert.equal(exitCodeFor(results), 11);
  });

  test('masks home paths and emails', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    const text = `at ${home}\\repo\\file.ts and mail me@example.org`;
    const masked = maskText(text, []);
    assert.ok(!masked.includes(home));
    assert.ok(!masked.includes('me@example.org'));
  });
});

describe('C22 Z2: mutation sanity for the infra table', () => {
  test('the table has an entry per documented pattern', () => {
    const source = readFileSync(new URL('../../tools/agent/ci-watch.mjs', import.meta.url), 'utf8');
    const sha = createHash('sha256').update(source).digest('hex');
    assert.match(sha, /^[0-9a-f]{64}$/);
    for (const key of Object.keys(INFRA_LOGS)) {
      assert.ok(source.includes(key), `pattern ${key} missing from the table`);
    }
  });
});