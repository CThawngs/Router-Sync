import test from 'node:test';
import assert from 'node:assert/strict';
import { countProbeLines, unmeasuredSteps, EVIDENCE_REFS } from '../../tools/agent/x40-evidence.mjs';

test('C40: đếm đúng dòng kết quả, bỏ dòng tiêu đề và dòng tổng hợp', () => {
  const text = [
    'cf/a\tOK\thttp=200\ttotal=10ms\tusage=-',
    'gemini/b\tHANG\tok=0/6\tp90=-ms',
    'bắt đầu=2026-11-22T09:00:00Z tổng=2 OK=1 HANG=1',
    '# tiêu đề',
    '',
  ].join('\n');
  assert.equal(countProbeLines(text), 2);
});

test('C40: liệt kê bước chưa đo, không lặp lại bước đã đo', () => {
  const c32 = [
    'cf/a\tOK\thttp=200\ttotal=10ms\tusage=-',
    'cf/b\tOK\thttp=200\ttotal=10ms\tusage=-',
    'cf/c\tOK\thttp=200\ttotal=10ms\tusage=-',
    'hf/dead\t404\thttp=404\ttotal=1ms\tusage=-',
  ].join('\n');
  const reliability = ['cf/a\tRELIABLE\tok=6/6\tp90=10ms'].join('\n');
  assert.deepEqual(unmeasuredSteps([c32], reliability), ['cf/b', 'cf/c']);
});

test('C40: danh sách nhánh bằng chứng có c32 đến c39', () => {
  assert.ok(EVIDENCE_REFS.some((r) => r.endsWith('/c32')));
  assert.ok(EVIDENCE_REFS.some((r) => r.endsWith('/c39')));
});
