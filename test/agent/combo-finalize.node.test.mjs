import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLowSampleCandidates,
  finalize,
  priority,
  rankSteps,
  specializedReason,
  splitLists,
} from '../../tools/agent/combo-finalize.mjs';
import { relabelReliabilityText } from '../../packages/cli/dist/commands/combos-reorder.js';

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

const W4_FIXTURE = [
  'bước cần đo: 39 (giới hạn 70)',
  'cf/@cf/meta/llama-3.2-3b-instruct\tRELIABLE\tok=6/6\tp90=674ms',
  'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast\tRELIABLE\tok=6/6\tp90=719ms',
  'cf/@cf/mistralai/mistral-small-3.1-24b-instruct\tRELIABLE\tok=6/6\tp90=986ms',
  'cf/@cf/zai-org/glm-4.7-flash\tRELIABLE\tok=6/6\tp90=3080ms',
  'gemini/gemini-3.8-flash\tHANG\tok=0/6\tp90=3777ms',
  'gemini/gemini-4-hydrogen\tHANG\tok=1/6\tp90=17020ms',
  'groq/allam-2-7b\tRELIABLE\tok=6/6\tp90=1682ms',
  'groq/openai/gpt-oss-120b\tRELIABLE\tok=6/6\tp90=3122ms',
  'groq/openai/gpt-oss-20b\tRELIABLE\tok=6/6\tp90=684ms',
  'groq/qwen/qwen3.8-27b\tRELIABLE\tok=6/6\tp90=1525ms',
  'kc/nvidia/nemotron-3-ultra-550b-a55b:free\tRELIABLE\tok=6/6\tp90=2257ms',
  'nvidia/google/gemma-4-31b-it\tHANG\tok=0/6\tp90=-ms',
  'nvidia/meta/muse-glimmer-30b\tHANG\tok=0/6\tp90=-ms',
  'nvidia/nvidia/ising-calibration-1.5-31b\tRELIABLE\tok=6/6\tp90=895ms',
  'nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning\tRELIABLE\tok=6/6\tp90=1777ms',
  'nvidia/nvidia/nemotron-3-ultra-550b-a55b\tRELIABLE\tok=6/6\tp90=2243ms',
  'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b\tRELIABLE\tok=6/6\tp90=1754ms',
  'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b\tRELIABLE\tok=6/6\tp90=1884ms',
  'nvidia/nvidia/riva-translate-4b-instruct-v2\tRELIABLE\tok=6/6\tp90=1597ms',
  'nvidia/poolside/laguna-xs-2.1\tRELIABLE\tok=6/6\tp90=1653ms',
  'nvidia/stepfun-ai/step-5-preview\tHANG\tok=4/6\tp90=5354ms',
  'nvidia/z-ai/glm-5.3-flash\tHANG\tok=0/6\tp90=-ms',
].join('\n');

const X2_FIXTURE = [
  'oc/big-pickle\tRATE-LIMITED\tok=0/1\tp90=1597ms\tquota=1',
  'openrouter/baidu/ernie-5.5-flash-preview:free\tDEAD\tok=1/1\tp90=3312ms',
  'oc/deepseek-v4.1-flash-free\tRATE-LIMITED\tok=0/1\tp90=449ms\tquota=1',
  'openrouter/inclusionai/ling-3.2-flash:free\tDEAD\tok=0/1\tp90=5584ms',
  'oc/hy4-flash-free\tRATE-LIMITED\tok=0/1\tp90=791ms\tquota=1',
  'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free\tDEAD\tok=1/1\tp90=994ms',
  'oc/iceman-free\tRATE-LIMITED\tok=0/1\tp90=457ms\tquota=1',
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free\tDEAD\tok=1/1\tp90=1274ms',
  'oc/longcat-2.5-free\tRATE-LIMITED\tok=0/1\tp90=417ms\tquota=1',
  'openrouter/nvidia/nemotron-3.5-lightning:free\tDEAD\tok=1/1\tp90=872ms',
  'oc/mimo-v2.6-flash-free\tRATE-LIMITED\tok=0/1\tp90=2619ms\tquota=1',
  'openrouter/nvidia/nemotron-3.5-super-vl:free\tDEAD\tok=1/1\tp90=901ms',
  'oc/nemotron-3.5-lightning-free\tRATE-LIMITED\tok=0/1\tp90=583ms\tquota=1',
  'openrouter/openrouter/free\tDEAD\tok=1/1\tp90=845ms',
  'oc/nemotron-3.5-super-vl-free\tRATE-LIMITED\tok=0/1\tp90=2575ms\tquota=1',
  'openrouter/recursive/flint-v1.0:free\tDEAD\tok=1/1\tp90=1219ms',
  'oc/tidepool-alpha-free\tRATE-LIMITED\tok=0/1\tp90=1854ms\tquota=1',
].join('\n');

const COMBO_RS_C40 = [
  '# rs-fast (bản thật, C40)',
  'cf/@cf/meta/llama-3.2-3b-instruct',
  'groq/openai/gpt-oss-20b',
  'nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'kc/nvidia/nemotron-3-ultra-550b-a55b:free',
  'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'groq/qwen/qwen3.8-27b',
  'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
  'cf/@cf/mistralai/mistral-small-3.1-24b-instruct',
  'groq/allam-2-7b',
  'cf/@cf/zai-org/glm-4.7-flash',
  'groq/openai/gpt-oss-120b',
  '# rs-max (bản thật, C40)',
  'cf/@cf/meta/llama-3.2-3b-instruct',
  'groq/openai/gpt-oss-20b',
  'nvidia/poolside/laguna-xs-2.1',
  'kc/nvidia/nemotron-3-ultra-550b-a55b:free',
  'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'groq/qwen/qwen3.8-27b',
  'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
  'cf/@cf/mistralai/mistral-small-3.1-24b-instruct',
  'groq/allam-2-7b',
  'nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'cf/@cf/zai-org/glm-4.7-flash',
  'groq/openai/gpt-oss-120b',
  'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b',
  'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
].join('\n');

test('C40 X2: tách danh sách fast/max (kể cả tiêu đề kèm chú thích C40)', () => {
  const lists = splitLists(current);
  assert.deepEqual(lists.fast, ['cf/a', 'nvidia/nvidia/ising-calibration-1.5-31b', 'groq/b', 'cf/c']);
  assert.equal(lists.max.length, 3);

  const c40Lists = splitLists(COMBO_RS_C40);
  assert.equal(c40Lists.fast.length, 11);
  assert.equal(c40Lists.max.length, 14);
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

test('R2: priority xếp LOW-SAMPLE ở hạng 4 (trước DEAD/HANG hạng 5, sau RATE-LIMITED hạng 3)', () => {
  const rel = new Map([
    ['cf/rel', { label: 'RELIABLE', p90Ms: 300, ok: 6, attempts: 6 }],
    ['cf/slow', { label: 'SLOW', p90Ms: 6000, ok: 6, attempts: 6 }],
    ['oc/lim', { label: 'RATE-LIMITED', p90Ms: 450, ok: 0, attempts: 1 }],
    ['openrouter/openrouter/free', { label: 'LOW-SAMPLE', p90Ms: 845, ok: 1, attempts: 1 }],
    ['openrouter/inclusionai/ling-3.2-flash:free', { label: 'DEAD', p90Ms: 5584, ok: 0, attempts: 1 }],
    ['gemini/hang', { label: 'HANG', p90Ms: null, ok: 0, attempts: 6 }],
  ]);
  assert.equal(priority('cf/rel', rel), 1);
  assert.equal(priority('cf/slow', rel), 2);
  assert.equal(priority('oc/lim', rel), 3);
  assert.equal(priority('unmeasured/m', rel), 4);
  assert.equal(priority('openrouter/openrouter/free', rel), 4);
  assert.equal(priority('openrouter/inclusionai/ling-3.2-flash:free', rel), 5);
  assert.equal(priority('gemini/hang', rel), 5);
});

test('R2: tính lại ngoại tuyến C38+C40 giữ nguyên rs-fast và trích đúng 7 ứng viên LOW-SAMPLE theo p90 tăng dần', () => {
  const x2Relabeled = relabelReliabilityText(X2_FIXTURE);
  const before = finalize(COMBO_RS_C40, [W4_FIXTURE, X2_FIXTURE]);
  const after = finalize(COMBO_RS_C40, [W4_FIXTURE, x2Relabeled.text]);
  assert.deepEqual(after.fast, before.fast);

  const candidates = extractLowSampleCandidates([
    W4_FIXTURE,
    x2Relabeled.text,
    'openrouter/test/embed-v1:free\tLOW-SAMPLE\tok=1/1\tp90=100ms',
  ]);
  assert.deepEqual(
    candidates.map((c) => c.step),
    [
      'openrouter/openrouter/free',
      'openrouter/nvidia/nemotron-3.5-lightning:free',
      'openrouter/nvidia/nemotron-3.5-super-vl:free',
      'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'openrouter/recursive/flint-v1.0:free',
      'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
      'openrouter/baidu/ernie-5.5-flash-preview:free',
    ]
  );
  assert.deepEqual(
    candidates.map((c) => c.p90Ms),
    [845, 872, 901, 994, 1219, 1274, 3312]
  );
});
