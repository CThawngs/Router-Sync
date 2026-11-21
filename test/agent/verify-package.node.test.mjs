import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  fakeRecordIssues,
  scanPackage,
  requiredRecordIssues,
  commandIssues,
} from '../../tools/agent/verify-package.mjs';

const GOOD = {
  id: 'x',
  command: 'node tools/agent/host-check.mjs',
  startedAt: '2026-11-20T08:15:42.287Z',
  endedAt: '2026-11-20T08:15:46.600Z',
  durationMs: 4313,
  masked: { homePath: 0, userName: 0, privateName: 0, email: 0, privateNamesLoaded: 4 },
  sys: { cpus: 8, totalMemMB: 16000, freeMemStartMB: 3000, freeMemMinMB: 2800 },
  stdout: { file: 'x.out.txt', bytes: 20 },
  stderr: { file: 'x.err.txt', bytes: 0 },
};

describe('C25 B6.2 / C30 K1.2: fake-record and personal-name guard', () => {
  test('round-hour timestamps and duration < 50ms are rejected', () => {
    const issues = fakeRecordIssues([
      { ...GOOD, startedAt: '2026-11-20T07:00:00.000Z', durationMs: 0 },
    ]);
    assert.ok(issues.length >= 2);
    assert.ok(issues.some((i) => i.includes('durationMs')));
    assert.ok(issues.some((i) => i.includes('round hour')));
  });

  test('a real capture record passes', () => {
    assert.deepEqual(fakeRecordIssues([GOOD]), []);
  });

  test('capture records must carry masked + sys and a runnable command', () => {
    const bare = requiredRecordIssues([{ startedAt: GOOD.startedAt }]);
    assert.ok(bare.some((i) => i.includes('id missing')));
    assert.ok(bare.some((i) => i.includes('masked missing')));
    assert.ok(bare.some((i) => i.includes('sys missing')));

    const noNames = requiredRecordIssues([{ ...GOOD, masked: { ...GOOD.masked, privateNamesLoaded: 0 } }]);
    assert.ok(noNames.some((i) => i.includes('privateNamesLoaded')));

    const shellish = commandIssues([{ ...GOOD, command: 'node a.mjs --flag=1; rm -rf x' }]);
    assert.ok(shellish.some((i) => i.includes('shell operator')));

    const badVerb = commandIssues([{ ...GOOD, command: 'curl https://example.com' }]);
    assert.ok(badVerb.some((i) => i.includes('not in allowlist')));

    assert.deepEqual(requiredRecordIssues([GOOD]), []);
    assert.deepEqual(commandIssues([GOOD]), []);
  });

  test('scanPackage finds a private name in a .out.txt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-pkg-'));
    try {
      writeFileSync(join(dir, 'records.jsonl'), JSON.stringify(GOOD) + '\n');
      writeFileSync(join(dir, 'x.out.txt'), 'provider alpha was here\n');
      const res = scanPackage(dir, ['alpha']);
      assert.ok(res.files >= 2, 'must scan the .out.txt file, not just records.jsonl');
      assert.ok(res.matches >= 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('scanPackage finds the machine home path in a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-pkg-'));
    try {
      writeFileSync(join(dir, 'records.jsonl'), JSON.stringify(GOOD) + '\n');
      writeFileSync(join(dir, 'x.out.txt'), `path ${homedir()}\\project\n`);
      const res = scanPackage(dir, []);
      assert.ok(res.matches >= 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a clean package reports no matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-pkg-'));
    try {
      writeFileSync(join(dir, 'records.jsonl'), JSON.stringify(GOOD) + '\n');
      mkdirSync(join(dir, 'records'), { recursive: true });
      writeFileSync(join(dir, 'x.out.txt'), 'nothing personal here\n');
      const res = scanPackage(dir, ['alpha']);
      assert.equal(res.matches, 0);
      assert.deepEqual(res.hits, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});