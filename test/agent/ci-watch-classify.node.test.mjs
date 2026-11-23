import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStep, classifyLog, exitCodeFor, summarize, failedStepNames, stepNameFromLog } from '../../tools/agent/ci-watch.mjs';
// Namespace import: a symbol added by M1-01 is read as a property, so a missing
// export fails only the test that needs it instead of the whole file.
import * as watch from '../../tools/agent/ci-watch.mjs';

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

describe('M1-01 (b): E2E-DAEMON-HEALTH-SIGNAL is always a code failure', () => {
  const MARKER = /\[E2E-DAEMON-HEALTH-SIGNAL\]/;
  const E2E_JOB = { id: 31, name: 'verify (ubuntu-24.04-arm, node 22)', conclusion: 'failure', continue_on_error: false, steps: [{ name: 'Slow tests (e2e)', conclusion: 'failure' }] };
  // The expanded vitest message from test/e2e/e2e.test.ts, next to strings
  // that would otherwise look like infrastructure (network reset, cache).
  const HEALTH_LOG = [
    'verify (ubuntu-24.04-arm, node 22)\tSlow tests (e2e)\t2026-11-20T10:00:00Z daemon health failed; exited=false exitCode=null stdout= stderr=',
    'verify (ubuntu-24.04-arm, node 22)\tSlow tests (e2e)\t2026-11-20T10:00:01Z fetch failed: ECONNRESET',
    'verify (ubuntu-24.04-arm, node 22)\tSlow tests (e2e)\t2026-11-20T10:00:02Z Failed to save: Cache service responded with 503',
  ].join('\n');

  test('summarize: code with the marker, exit 11, even with infra strings and no assertion marker', () => {
    const out = summarize([E2E_JOB], { 31: HEALTH_LOG });
    assert.equal(out[0].kind, 'code');
    assert.match(String(out[0].evidence), MARKER);
    assert.equal(exitCodeFor(out), 11);
  });

  test('summarize: a non-test step carrying the signal is still code, never infra', () => {
    const job = { ...E2E_JOB, id: 32, steps: [{ name: 'Build', conclusion: 'failure' }] };
    const out = summarize([job], { 32: HEALTH_LOG.replaceAll('Slow tests (e2e)', 'Build') });
    assert.equal(out[0].kind, 'code');
    assert.match(String(out[0].evidence), MARKER);
  });

  test('classifyJob: code with the marker', () => {
    const out = watch.classifyJob(E2E_JOB.name, 'failure', HEALTH_LOG, 'failure');
    assert.equal(out.kind, 'code');
    assert.match(String(out.evidence), MARKER);
  });

  test('a continue-on-error job stays masked but keeps the marker', () => {
    const arm = { ...E2E_JOB, id: 33, name: 'verify (windows-11-arm, node 22)', continue_on_error: true };
    const out = summarize([arm], { 33: HEALTH_LOG });
    assert.equal(out[0].kind, 'masked');
    assert.match(String(out[0].evidence), MARKER);
  });

  test('detectDaemonHealthSignal needs the exact `daemon health failed; exited=` text', () => {
    assert.equal(typeof watch.detectDaemonHealthSignal, 'function', 'detectDaemonHealthSignal must be exported');
    assert.equal(watch.detectDaemonHealthSignal(HEALTH_LOG), true);
    assert.equal(watch.detectDaemonHealthSignal('daemon health failed; ${diag()}'), false);
    assert.equal(watch.detectDaemonHealthSignal('Failed to restore: Cache service responded with 400'), false);
  });
});

describe('M1-01 (c): gh resolves without a shell', () => {
  test('gh.exe on Windows, gh elsewhere; spawn options carry no shell', () => {
    assert.equal(typeof watch.ghExecutable, 'function', 'ghExecutable must be exported');
    assert.equal(watch.ghExecutable('win32'), 'gh.exe');
    assert.equal(watch.ghExecutable('linux'), 'gh');
    assert.equal(watch.ghExecutable('darwin'), 'gh');
    const options = watch.ghSpawnOptions(1024);
    assert.equal('shell' in options, false);
    assert.equal(options.maxBuffer, 1024);
    assert.equal(options.encoding, 'utf8');
  });
});
