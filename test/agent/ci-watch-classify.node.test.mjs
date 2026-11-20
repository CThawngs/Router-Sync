import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStep, classifyLog } from '../../tools/agent/ci-watch.mjs';

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