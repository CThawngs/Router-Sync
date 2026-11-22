import test from 'node:test';
import assert from 'node:assert/strict';
import { orderByName, sizeHint } from '../../tools/agent/order-by-name.mjs';

test('C41 Y1: gợi ý kích thước từ tên', () => {
  assert.ok(sizeHint('groq/openai/gpt-oss-120b') > sizeHint('groq/openai/gpt-oss-20b'));
  assert.ok(sizeHint('cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast') > sizeHint('cf/@cf/meta/llama-3.2-3b-instruct'));
  assert.ok(sizeHint('kc/nvidia/nemotron-3-ultra-550b-a55b:free') > sizeHint('nvidia/nvidia/nemotron-3-nano-omni'));
});

test('C41 Y1: model lớn đứng trước trong cùng provider, provider xen kẽ', () => {
  const steps = [
    'groq/openai/gpt-oss-20b',
    'cf/@cf/meta/llama-3.2-3b-instruct',
    'groq/openai/gpt-oss-120b',
    'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  ];
  const out = orderByName(steps);
  assert.deepEqual(out, [
    'groq/openai/gpt-oss-120b',
    'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    'groq/openai/gpt-oss-20b',
    'cf/@cf/meta/llama-3.2-3b-instruct',
  ]);
  assert.equal(out.length, steps.length);
});

test('C41 Y1: mutation — đảo chiều so sánh thì test đỏ', () => {
  const a = sizeHint('groq/x-120b');
  const b = sizeHint('groq/x-20b');
  assert.ok(a > b);
  assert.ok(!(b > a));
});
