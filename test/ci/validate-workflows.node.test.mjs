import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'tools/ci/validate-workflows.mjs');
const expectToMatch = (text, re) => assert.ok(re.test(text), `expected ${re} to match`);

function run(dir) {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout ?? '') + (r.stderr ?? '') };
}

function writeWorkflow(dir, name, body) {
  writeFileSync(path.join(dir, name), body, 'utf8');
}

const GOOD = `name: ci
on: push
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7.0.1
`;

describe('C22 Z3: validate-workflows', () => {
  test('accepts a clean workflow', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rs-wf-ok-'));
    try {
      writeWorkflow(dir, 'ci.yml', GOOD);
      const r = run(dir);
      assert.equal(r.status, 0, r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a job without timeout-minutes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rs-wf-timeout-'));
    try {
      writeWorkflow(dir, 'ci.yml', GOOD.replace('    timeout-minutes: 10\n', ''));
      const r = run(dir);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /no timeout-minutes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a floating major tag', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rs-wf-float-'));
    try {
      writeWorkflow(dir, 'ci.yml', GOOD.replace('actions/checkout@v7.0.1', 'actions/checkout@v7'));
      const r = run(dir);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /floating ref/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects continue-on-error outside the ARM job', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rs-wf-arm-'));
    try {
      const body = GOOD.replace(
        '    timeout-minutes: 10\n',
        '    timeout-minutes: 10\n    continue-on-error: ${{ matrix.os == \'ubuntu-latest\' }}\n'
      );
      writeWorkflow(dir, 'ci.yml', body);
      const r = run(dir);
      assert.equal(r.status, 1, r.stdout);
      expectToMatch(r.stdout, /continue-on-error is not the ARM rule/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});