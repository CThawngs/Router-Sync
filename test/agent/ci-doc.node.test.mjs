// L2: `docs/CI.md` phải tồn tại và nhắc đúng tên các công cụ.
//
// Test này chỉ kiểm tài liệu, không chạy CI: nó chặn việc trang sổ tay bị xoá
// hoặc mất một mục giữa các vòng.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const DOC = join(ROOT, 'docs', 'CI.md');

describe('L2: docs/CI.md', () => {
  test('tồn tại và không rỗng', () => {
    assert.ok(existsSync(DOC), 'docs/CI.md phải tồn tại');
    assert.ok(readFileSync(DOC, 'utf8').trim().length > 500);
  });

  test('nhắc đủ các công cụ của hệ CI', () => {
    const text = readFileSync(DOC, 'utf8');
    for (const tool of [
      'pnpm prepush',
      'ci-watch.mjs',
      'ci-stats.mjs',
      'flake-hunt.yml',
      'pre-commit',
      'pre-push',
      'no-secrets.mjs',
      'no-personal-paths.mjs',
      'no-evidence-in-main.mjs',
      'no-force-push.mjs',
    ]) {
      assert.ok(text.includes(tool), `thiếu ${tool}`);
    }
  });

  test('giải thích mã thoát của ci-watch', () => {
    const text = readFileSync(DOC, 'utf8');
    for (const code of ['`0`', '`10`', '`11`', '`12`']) {
      assert.ok(text.includes(code), `thiếu mã thoát ${code}`);
    }
    assert.match(text, /hạ tầng/i);
  });

  test('nêu quy trình trả bằng chứng qua GitHub và lỗi e2e còn treo', () => {
    const text = readFileSync(DOC, 'utf8');
    assert.match(text, /evidence\/c<N>/);
    assert.match(text, /NOTE\.md/);
    assert.match(text, /44788053023/);
    // M1-01: the line reference follows the daemon-health assertion itself.
    const e2eLines = readFileSync(join(ROOT, 'test', 'e2e', 'e2e.test.ts'), 'utf8').split('\n');
    const healthLine = e2eLines.findIndex((l) => l.includes('daemon health failed; ')) + 1;
    assert.ok(healthLine > 0, 'e2e.test.ts must still print `daemon health failed; `');
    assert.ok(text.includes(`e2e.test.ts:${healthLine}`), `docs/CI.md must cite e2e.test.ts:${healthLine}`);
    assert.match(text, /\[E2E-DAEMON-HEALTH-SIGNAL\]/);
  });

  test('không chép lại AGENTS.md mà liên kết tới nó', () => {
    const text = readFileSync(DOC, 'utf8');
    assert.match(text, /AGENTS\.md/);
    // Trang sổ tay ngắn: nếu phình hơn 400 dòng thì đã thành bản sao.
    const lines = text.split('\n').length;
    assert.ok(lines < 400, `docs/CI.md dài ${lines} dòng, cần ngắn lại`);
  });
});