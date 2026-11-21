import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fakeRecordIssues, scanPackage, requiredRecordIssues, commandIssues } from '../../tools/agent/verify-package.mjs';

describe('C25 B6.2: fake-record and personal-name guard', () => {
  test('round-hour timestamps and duration < 50ms are rejected', () => {
    const issues = fakeRecordIssues([
      { id: 'fake', durationMs: 0, startedAt: '2026-11-20T07:00:00.000Z', endedAt: '2026-11-20T07:00:00.000Z', stdout: { file: 'a.txt', lines: 0 }, stderr: { file: 'a.txt' } },
    ]);
    assert.ok(issues.length >= 3);
    assert.ok(issues.some((i) => i.includes('durationMs')));
    assert.ok(issues.some((i) => i.includes('round hour')));
  });

  test('a real capture record passes', () => {
    const issues = fakeRecordIssues([
      { id: 'real', durationMs: 4300, startedAt: '2026-11-20T08:15:42.287Z', endedAt: '2026-11-20T08:15:46.600Z', stdout: { file: 'a.txt', lines: 20 }, stderr: { file: 'b.txt', lines: 0 } },
    ]);
    assert.deepEqual(issues, []);
  });

  test('capture records must carry masked and sys; commands must be runnable', () => {
    const bare = requiredRecordIssues([{ name: 'x', startedAt: '2026-11-20T08:15:42.287Z' }]);
    assert.ok(bare.some((i) => i.includes('masked missing')));
    assert.ok(bare.some((i) => i.includes('sys missing')));
    const shellish = commandIssues([{ name: 'y', command: ['node', 'a.mjs', '--flag=1;', 'rm'] }]);
    assert.ok(shellish.some((i) => i.includes('shell operator')));
    const ok = requiredRecordIssues([{ name: 'z', startedAt: '2026-11-20T08:15:42.287Z', masked: [], sys: { os: 'linux', runId: '1', headSha: 'a'.repeat(40) }, command: ['node', 'x.mjs'] }]);
    assert.deepEqual(ok, []);
  });

  test('scanPackage finds the machine home path in a file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rs-pkg-scan-'));
    mkdirSync(join(tmp, 'records'));
    writeFileSync(join(tmp, 'records.jsonl'), 'id real\n', 'utf8');
    writeFileSync(join(tmp, 'records', 'a.out.txt'), `at ${homedir()}\\repo\n`, 'utf8');
    const found = scanPackage(tmp, []);
    assert.ok(found.files >= 2);
    assert.ok(found.matches >= 1);
    rmSync(tmp, { recursive: true, force: true });
  });
});
