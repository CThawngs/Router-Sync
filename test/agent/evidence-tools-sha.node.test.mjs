// C30 K1.1: công cụ bằng chứng chuẩn phải nguyên vẹn.
//
// capture.mjs và verify-records.mjs là bản chuẩn của chủ dự án
// (RouterSync-tools), không phải bản agent tự viết. Ghi đúng sha256 64 ký tự:
// sửa một byte trong công cụ đo là test đỏ, và người viết công cụ không được
// tự chấm bằng công cụ do mình viết.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const EXPECTED = {
  'tools/agent/capture.mjs': '2f2768cf0cd9bc855527db62bd70218198352f6ebcc2b785df242df71b216514',
  'tools/agent/verify-records.mjs': '7b310d901d304ae672a466e64aa6df6ece12a74fe662477316de58b1ebd78a48',
};

function sha256File(rel) {
  return createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');
}

for (const [rel, want] of Object.entries(EXPECTED)) {
  test(`${rel} khớp sha256 chuẩn (64 ký tự)`, () => {
    assert.match(want, /^[0-9a-f]{64}$/);
    assert.equal(sha256File(rel), want);
  });
}

test('bản agent tự viết đã bị thay, không còn dấu vết host-check cũ 4,7 MB', () => {
  const capture = readFileSync(join(ROOT, 'tools/agent/capture.mjs'), 'utf8');
  // Bản tự viết dùng `name`/`sha256.out`; bản chuẩn dùng `id` và sha256 dạng chuỗi.
  assert.ok(capture.includes('privateNamesLoaded'), 'bản chuẩn phải ghi privateNamesLoaded');
  assert.ok(!/\bname:\s*id\b/.test(capture), 'không còn định dạng bản ghi tự viết');
  const hostCheck = readFileSync(join(ROOT, 'tools/agent/host-check.mjs'), 'utf8');
  assert.ok(!hostCheck.includes('hfCatalogIdsPresent'), 'host-check không được dump cả danh mục');
  assert.ok(!hostCheck.includes('openrouterPerId'), 'host-check không được dump từng id OpenRouter');
});