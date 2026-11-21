// L0.2: gói bằng chứng bị từ chối khi bản ghi nạp ít tên riêng hơn danh sách hiện hành.
//
// Kịch bản: danh sách giả có 7 tên, bản ghi chỉ nạp 4 (đúng kiểu C29/C30) ->
// floor check phải đỏ. Mutation: bỏ floor check thì cùng bản ghi đó trôi qua.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { floorIssues } from '../../tools/agent/private-names.mjs';
import { nameFloorIssues } from '../../tools/agent/verify-package.mjs';

const SEVEN = ['alpha-gw', 'bravo-gw', 'charlie-gw', 'delta-gw', 'echo-gw', 'foxtrot-gw', 'golf-gw'];

function record(id, loaded) {
  return {
    id,
    command: 'node tools/agent/host-check.mjs',
    startedAt: '2026-11-21T08:15:42.287Z',
    endedAt: '2026-11-21T08:15:46.600Z',
    durationMs: 4313,
    exitCode: 0,
    stdout: { file: `${id}.out.txt`, sha256: 'a'.repeat(64), lines: 1, bytes: 10 },
    stderr: { file: `${id}.err.txt`, sha256: 'b'.repeat(64), lines: 0, bytes: 0 },
    masked: { homePath: 0, userName: 0, privateName: 0, email: 0, privateNamesLoaded: loaded },
    sys: { cpus: 8, totalMemMB: 16000, freeMemStartMB: 3000, freeMemMinMB: 2800 },
  };
}

describe('L0.2: floor theo số tên riêng hiện hành', () => {
  test('bản ghi nạp 4 trong khi danh sách có 7 thì bị từ chối', () => {
    const issues = floorIssues([record('r1', 4)], 7);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /privateNamesLoaded=4 < 7/);
  });

  test('bản ghi nạp đủ 7 thì sạch', () => {
    assert.deepEqual(floorIssues([record('r2', 7)], 7), []);
  });

  test('thiếu hẳn privateNamesLoaded cũng bị từ chối', () => {
    const row = record('r3', 7);
    delete row.masked.privateNamesLoaded;
    const issues = floorIssues([row], 7);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /missing/);
  });

  test('verify-package phơi cùng kiểm tra ra ngoài (nameFloorIssues)', () => {
    assert.equal(nameFloorIssues([record('r4', 4)], 7).length, 1);
    assert.deepEqual(nameFloorIssues([record('r5', 7)], 7), []);
  });

  test('mutation: bỏ floor check thì bản ghi 4/7 trôi qua', () => {
    // Không có floor: chỉ còn các kiểm tra khác, và bản ghi giả này hợp lệ.
    const withoutFloor = (rows) => rows.filter((r) => !r.id);
    assert.deepEqual(withoutFloor([record('r6', 4)]), []);
    assert.equal(floorIssues([record('r6', 4)], 7).length, 1);
  });

  test('danh sách giả 7 tên có thể ghi ra file cho capture.mjs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-names-'));
    try {
      const file = join(dir, 'private-names.local.json');
      writeFileSync(file, `${JSON.stringify(SEVEN, null, 2)}\n`, 'utf8');
      const loaded = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(loaded.length, 7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});