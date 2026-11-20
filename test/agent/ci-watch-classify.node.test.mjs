import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStep, classifyLog, exitCodeFor, summarize, failedStepNames, stepNameFromLog } from '../../tools/agent/ci-watch.mjs';

const TEST_LOG = `verify (ubuntu-latest, node 22)\tRun Tests\t2026-11-19T10:00:00Z AssertionError: expected true to be false
verify (ubuntu-latest, node 22)\tRun Tests\t2026-11-19T10:00:01Z  some test printed: ETIMEDOUT while probing upstream
verify (ubuntu-latest, node 22)\tRun Tests\t2026-11-19T10:00:02Z  Test Files  1 failed (2)
`;

const TEST_LOG_CLEAN = `verify (ubuntu-latest, node 22)\tRun Tests\t2026-11-19T10:00:00Z AssertionError: expected 1 to be 2
`;

const STEP_LOG = `verify (ubuntu-latest, node 22)\tProduct smoke with perf budgets\t2026-11-19T10:00:00Z Failed to restore: Cache service responded with 400
`;

describe('C23 V3: test steps are code failures by default', () => {
  test('an assertion failure wins over an ECONNRESET/ETIMEDOUT string in test output', () => {
    assert.equal(classifyStep('Run Tests', TEST_LOG), 'code');
  });

  test('a test step with a network string but a real assertion is still code', () => {
    assert.equal(classifyStep('Run Tests', TEST_LOG_CLEAN), 'code');
  });

  test('a test step with no assertion and an infra signature is infra', () => {
    assert.equal(classifyStep('Run Tests', 'Run Tests\tboom\nFailed to restore: Cache service responded with 400\n'), 'infra');
  });

  test('a smoke step with an infra signature is infra', () => {
    assert.equal(classifyStep('Product smoke with perf budgets', STEP_LOG), 'infra');
  });

  test('classifyLog alone still reports the raw signature', () => {
    assert.ok(classifyLog(TEST_LOG));
  });
});

describe('C24 A1: summarize classifies by the failed step, not the whole run log', () => {
  const GITHUB_LOG_HEADER = 'verify (ubuntu-latest, node 22)\tRun Tests\t2026-11-19T10:00:00Z ';
  const mixedLog = [
    `${GITHUB_LOG_HEADER}AssertionError: expected true to be false // Object.is equality`,
    `verify (ubuntu-latest, node 22)\tRun Tests\tsome-printed: ETIMEDOUT while probing upstream`,
    'verify (ubuntu-latest, node 22)\tRun Tests\tTest Files  1 failed (2)',
  ].join('\n');
  const cancelledJob = { id: 11, name: 'verify (macos-latest, node 22)', conclusion: 'cancelled', steps: [] };

  test('a red Run Tests step is code even when the log mentions ETIMEDOUT', () => {
    const jobs = [{ id: 1, name: 'verify (ubuntu-latest, node 22)', conclusion: 'failure', continue_on_error: false, steps: [{ name: 'Run Tests', conclusion: 'failure' }] }];
    const out = summarize(jobs, { 1: mixedLog });
    assert.equal(out[0].kind, 'code');
    assert.equal(exitCodeFor(out), 11);
  });

  test('a cancelled job with no steps is infra', () => {
    const out = summarize([cancelledJob], { 11: '' });
    assert.equal(out[0].kind, 'infra');
    assert.equal(out[0].evidence, 'no steps ran (capacity or runner loss)');
    assert.equal(exitCodeFor(out), 10);
  });

  test('continue-on-error jobs are masked, not counted as code', () => {
    const arm = { id: 12, name: 'verify (windows-11-arm, node 22)', conclusion: 'failure', continue_on_error: true, steps: [{ name: 'Run Tests', conclusion: 'failure' }] };
    const out = summarize([arm], { 12: `${GITHUB_LOG_HEADER}AssertionError: boom` });
    assert.equal(out[0].kind, 'masked');
    assert.equal(exitCodeFor(out), 0);
  });

  test('an infra signature on a non-test step is infra', () => {
    const jobs = [{ id: 13, name: 'Install dependencies', conclusion: 'failure', steps: [{ name: 'Install dependencies', conclusion: 'failure' }] }];
    const out = summarize(jobs, { 13: 'Failed to restore: Cache service responded with 400' });
    assert.equal(out[0].kind, 'infra');
    assert.equal(exitCodeFor(out), 10);
  });

  test('failedStepNames picks the steps that actually failed', () => {
    assert.deepEqual(failedStepNames({ steps: [{ name: 'A', conclusion: 'success' }, { name: 'B', conclusion: 'failure' }] }), ['B']);
    assert.deepEqual(failedStepNames({ steps: [{ name: 'A', conclusion: 'skipped' }] }), []);
  });
});

describe('C25 B0: masked is unconditional, unknown when there is no job log', () => {
  const ARM24 = { id: 22, name: 'verify (windows-11-arm, node 24)', conclusion: 'failure', continue_on_error: true, steps: [{ name: 'Run Tests', conclusion: 'failure' }] };
  const OTHER = { id: 23, name: 'verify (ubuntu-latest, node 22)', conclusion: 'failure', continue_on_error: false, steps: [{ name: 'Run Tests', conclusion: 'failure' }] };
  const NOSTEPS_CANCELLED = { id: 24, name: 'verify (macos-latest, node 22)', conclusion: 'cancelled', steps: [] };
  const NO_LOG_JOB = { id: 25, name: 'verify (ubuntu-latest, node 22)', conclusion: 'failure', continue_on_error: false, steps: [] };

  test('(a) run success + ARM job failure with continue_on_error → exit 0, ARM masked', () => {
    const out = summarize([ARM24], { 22: 'AssertionError: boom' }, 'success');
    assert.equal(out[0].kind, 'masked');
    assert.equal(exitCodeFor(out), 0);
  });

  test('(b) run failure + ARM red + other code red → exit 11, ARM still masked', () => {
    const out = summarize([ARM24, OTHER], { 22: 'AssertionError: boom', 23: 'AssertionError: boom2' }, 'failure');
    const arm = out.find((r) => r.job.includes('windows-11-arm'));
    const other = out.find((r) => r.job.includes('ubuntu'));
    assert.equal(arm.kind, 'masked');
    assert.equal(other.kind, 'code');
    assert.equal(exitCodeFor(out), 11);
  });

  test('(c) job cancelled with no steps ran → infra', () => {
    const out = summarize([NOSTEPS_CANCELLED], {});
    assert.equal(out[0].kind, 'infra');
    assert.equal(out[0].evidence, 'no steps ran (capacity or runner loss)');
  });

  test('job with no log and no continue_on_error → unknown, exit 12', () => {
    const out = summarize([NO_LOG_JOB], {});
    assert.equal(out[0].kind, 'unknown');
    assert.equal(out[0].evidence, 'no job log');
    assert.equal(exitCodeFor(out), 12);
  });
});