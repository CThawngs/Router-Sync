#!/usr/bin/env node
// tools/agent/capture-evidence.mjs
//
// L0: lớp bọc quanh `capture.mjs` chuẩn (sha đã ghim, không sửa).
//
// Việc của lớp bọc:
//   1. nạp danh sách tên riêng từ guard (nguồn đã được kiểm) và truyền cho
//      `capture.mjs` qua `RS_PRIVATE_NAMES`, để số tên nạp luôn là số của
//      danh sách hiện hành, không phải của một file cũ;
//   2. sau khi chạy, đọc bản ghi vừa ghi và xác nhận
//      `masked.privateNamesLoaded` bằng đúng số tên đã nạp — lệch thì thoát
//      khác 0 (không âm thầm chấp nhận việc che thiếu).
//
// Dùng:
//   node tools/agent/capture-evidence.mjs <id> -- <lệnh...>
//   RS_EVIDENCE_DIR=evidence/C31 node tools/agent/capture-evidence.mjs ...
//
// Không in tên riêng; chỉ in số đếm.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPrivateNames, effectivePrivateNames } from './private-names.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (argv.length < 3 || sep !== 1) {
  console.error('Dùng: node tools/agent/capture-evidence.mjs <id> -- <lệnh...>');
  process.exit(2);
}
const id = argv[0];
const command = argv.slice(sep + 1);

const names = effectivePrivateNames();
if (names.length === 0) {
  console.error('[capture-evidence] danh sách tên riêng rỗng — từ chối chạy (che thiếu còn tệ hơn không chạy)');
  process.exit(2);
}

const evidenceDir = process.env.RS_EVIDENCE_DIR || '.agent/evidence';
const env = { ...process.env, RS_PRIVATE_NAMES: names.join(',') };

// Lớp bọc chạy `capture.mjs` chuẩn (không phải lệnh trực tiếp), nên bản ghi
// vẫn đúng định dạng và vẫn được ghim sha256.
const here = dirname(fileURLToPath(import.meta.url));
const capture = join(here, 'capture.mjs');
const run = spawnSync(process.execPath, [capture, id, '--', ...command], {
  stdio: 'inherit',
  env,
});
const exit = typeof run.status === 'number' ? run.status : 1;

const recordFile = join(evidenceDir, 'records.jsonl');
if (!existsSync(recordFile)) {
  console.error(`[capture-evidence] không thấy ${recordFile}`);
  process.exit(exit === 0 ? 1 : exit);
}
const rows = readFileSync(recordFile, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const row = rows.filter((r) => (r.id ?? r.name) === id).pop();
if (!row) {
  console.error(`[capture-evidence] không thấy bản ghi ${id} trong ${recordFile}`);
  process.exit(exit === 0 ? 1 : exit);
}
const loaded = row.masked?.privateNamesLoaded ?? 0;
if (loaded !== names.length) {
  console.error(
    `[capture-evidence] ${id}: privateNamesLoaded=${loaded}, danh sách hiện hành=${names.length} — bản ghi không chứng minh được là đã che đủ`
  );
  process.exit(1);
}
const guardCount = localPrivateNames().length;
console.log(
  `[capture-evidence] ${id}: privateNamesLoaded=${loaded} = số tên hiện hành (guard=${guardCount}, effective=${names.length}), masked.privateName=${row.masked?.privateName ?? 0}`
);
process.exit(exit);