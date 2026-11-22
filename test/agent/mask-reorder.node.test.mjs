import test from 'node:test';
import assert from 'node:assert/strict';
import { countMasked, maskReorder } from '../../tools/agent/mask-reorder.mjs';
import { effectivePrivateNames } from '../../tools/agent/private-names.mjs';

test('C40 X1: che tên riêng trong tệp sắp xếp lại', () => {
  const name = effectivePrivateNames()[0];
  assert.ok(name, 'cần ít nhất một tên riêng để test');
  const input = `# hạng 6\n${name}/some-model\ngroq/ok\n`;
  const masked = maskReorder(input);
  assert.equal(masked.includes(name), false);
  assert.ok(masked.includes('groq/ok'));
  assert.equal(countMasked(masked), 0);
});

test('C40 X1: che gateway dạng UUID', () => {
  const input = 'openai-compatible-chat-5c7bdb86-5261-4ca7-b5e1-9413a85e6b92/deepseek/x\n';
  const masked = maskReorder(input);
  assert.ok(masked.includes('<private-gateway>'));
  assert.equal(masked.includes('5c7bdb86'), false);
});

test('C40 X1: mutation — bỏ bước che thì test đỏ', () => {
  const name = effectivePrivateNames()[0];
  const input = `${name}/some-model\n`;
  assert.equal(input.includes(name), true);
  assert.equal(maskReorder(input).includes(name), false);
});
