import test from 'node:test';
import assert from 'node:assert/strict';
import { finalize, rankSteps, specializedReason, splitLists } from '../../tools/agent/combo-finalize.mjs';

const current = [
  '# rs-fast',
  'cf/a',
  'nvidia/nvidia/ising-calibration-1.5-31b',
  'groq/b',
  'cf/c',
  '# rs-max',
  'cf/a',
  'nvidia/nvidia/riva-translate-4b-instruct-v2',
  'groq/b',
].join('\n');

const reliability = [
  'cf/a\tRELIABLE\tok=6/6\tp90=300ms',
  'groq/b\tRELIABLE\tok=6/6\tp90=900ms',
  'cf/c\tRATE-LIMITED\tok=0/6\tp90=-ms',
].join('\n');

test('C40 X2: tách danh sách fast/max', () => {
  const lists = splitLists(current);
  assert.deepEqual(lists.fast, ['cf/a', 'nvidia/nvidia/ising-calibration-1.5-31b', 'groq/b', 'cf/c']);
  assert.equal(lists.max.length, 3);
});

test('C40 X2: model chuyên dụng bị đưa vào danh sách cần xác nhận', () => {
  assert.ok(specializedReason('nvidia/nvidia/ising-calibration-1.5-31b'));
  assert.ok(specializedReason('nvidia/nvidia/riva-translate-4b-instruct-v2'));
  assert.equal(specializedReason('groq/allam-2-7b'), null);
  const result = finalize(current, [reliability]);
  assert.equal(result.needsConfirmation.length, 2);
  assert.ok(result.fast.every((s) => !specializedReason(s)));
  assert.ok(result.max.every((s) => !specializedReason(s)));
});

test('C41 Y1: thứ tự do chủ dự án đứng trước p90', () => {
  const result = finalize(current, [reliability], ['groq/b', 'cf/a']);
  assert.deepEqual(result.fast.slice(0, 2), ['groq/b', 'cf/a']);
  assert.deepEqual(result.max.slice(0, 2), ['groq/b', 'cf/a']);
});

test('C40 X2: bước nhanh đứng trước, provider xen kẽ', () => {
  const steps = ['cf/a', 'cf/c', 'groq/b', 'nvidia/d'];
  const rel = new Map([
    ['cf/a', { label: 'RELIABLE', p90Ms: 300, ok: 6, attempts: 6 }],
    ['groq/b', { label: 'RELIABLE', p90Ms: 900, ok: 6, attempts: 6 }],
    ['cf/c', { label: 'RATE-LIMITED', p90Ms: null, ok: 0, attempts: 6 }],
  ]);
  const out = rankSteps(steps, rel);
  assert.deepEqual(out, ['cf/a', 'groq/b', 'cf/c', 'nvidia/d']);
});
