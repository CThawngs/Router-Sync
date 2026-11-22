// V4: rs-fast / rs-max chỉ từ bước đã đo; HANG/DEAD bị loại.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLists, parseRuns } from '../../tools/agent/combo-lists.mjs';

const mk = (a, b) => parseRuns([a.join('\n'), b.join('\n')]);

describe('V4: combo lists', () => {
  it('rs-fast chỉ lấy OK ở cả hai lượt, sort theo thời gian', () => {
    const r = buildLists(
      mk(
        ['p/slow\tOK\thttp=200\ttotal=3000ms', 'p/fast\tOK\thttp=200\ttotal=100ms'],
        ['p/slow\tOK\thttp=200\ttotal=3500ms', 'p/fast\tOK\thttp=200\ttotal=120ms']
      )
    );
    assert.deepEqual(r.rsFast, ['p/fast', 'p/slow']);
    assert.equal(r.rateLimited.length, 0);
  });

  it('HANG bị loại khỏi cả hai danh sách', () => {
    const r = buildLists(
      mk(
        ['p/ok\tOK\thttp=200\ttotal=100ms', 'p/hang\tTIMEOUT-NO-HEADER\thttp=-\ttotal=30000ms'],
        ['p/ok\tOK\thttp=200\ttotal=100ms', 'p/hang\tTIMEOUT-NO-HEADER\thttp=-\ttotal=30000ms']
      )
    );
    assert.deepEqual(r.rsFast, ['p/ok']);
    assert.deepEqual(r.rsMax, ['p/ok']);
    assert.equal(r.hang.length, 1);
  });

  it('RATE-LIMITED vào rs-max nhưng không vào rs-fast', () => {
    const r = buildLists(
      mk(
        ['p/ok\tOK\thttp=200\ttotal=100ms', 'p/rl\tRATE-LIMITED\thttp=429\ttotal=200ms'],
        ['p/ok\tOK\thttp=200\ttotal=100ms', 'p/rl\tRATE-LIMITED\thttp=429\ttotal=200ms']
      )
    );
    assert.deepEqual(r.rsFast, ['p/ok']);
    assert.ok(r.rsMax.includes('p/rl'));
  });

  it('mutation: đưa HANG vào rs-max thì test đỏ', () => {
    const r = buildLists(
      mk(
        ['p/ok\tOK\thttp=200\ttotal=100ms', 'p/hang\tHANG-AFTER-USAGE\thttp=-\ttotal=30000ms'],
        ['p/ok\tOK\thttp=200\ttotal=100ms', 'p/hang\tHANG-AFTER-USAGE\thttp=-\ttotal=30000ms']
      )
    );
    assert.ok(!r.rsMax.includes('p/hang'));
    assert.ok(!(r.rsMax.includes('p/hang') && r.rsMax.includes('p/hang')));
  });
});