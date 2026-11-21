#!/usr/bin/env node
// Kiểm tính toàn vẹn của records.jsonl do capture.mjs tạo ra.
// Dùng: node verify-records.mjs [records.jsonl] [thư-mục-bằng-chứng]
// Thoát 0 nếu sạch, 1 nếu có dòng đáng ngờ. Không in nội dung tệp bằng chứng.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const recFile = process.argv[2] ?? '.agent/evidence/records.jsonl';
const dir = process.argv[3] ?? dirname(recFile);
const problems = [];
const seen = new Map();
const rows = readFileSync(recFile, 'utf8').split(/\r?\n/).filter(Boolean);
const sha = (b) => createHash('sha256').update(b).digest('hex');
let prevStart = 0;

rows.forEach((line, i) => {
  const n = i + 1;
  let r;
  try { r = JSON.parse(line); } catch { problems.push(`dòng ${n}: không phải JSON`); return; }
  const bad = (m) => problems.push(`dòng ${n} (${r.id ?? '?'}): ${m}`);
  if (!r.id || !r.command) bad('thiếu id/command');
  if (seen.has(r.id)) bad(`id trùng với dòng ${seen.get(r.id)}`); else seen.set(r.id, n);
  for (const k of ['stdout', 'stderr']) {
    const s = r[k];
    if (!s || !/^[0-9a-f]{64}$/.test(s.sha256 ?? '')) { bad(`${k}.sha256 rỗng hoặc sai dạng`); continue; }
    const f = join(dir, s.file ?? '');
    if (!existsSync(f)) { bad(`${k}: tệp ${s.file} không tồn tại`); continue; }
    const buf = readFileSync(f);
    if (sha(buf) !== s.sha256) bad(`${k}: sha256 không khớp tệp (tệp bị ghi đè hoặc sửa tay)`);
    if (buf.length !== s.bytes) bad(`${k}: bytes không khớp tệp`);
  }
  const t0 = Date.parse(r.startedAt), t1 = Date.parse(r.endedAt);
  if (!(t1 >= t0)) bad('thời gian bắt đầu/kết thúc sai');
  else if (Math.abs((t1 - t0) - r.durationMs) > 50) bad('durationMs lệch quá 50 ms so với start/end');
  if (t0 < prevStart) bad('startedAt lùi so với dòng trước');
  prevStart = t0;
  if (/T\d\d:\d\d:\d\d\.000Z$/.test(r.startedAt ?? '') && /T00:00:\d\d\.000Z$/.test(r.startedAt ?? '')) bad('startedAt tròn giây sát nửa đêm UTC, trông như gõ tay');
  if (!r.masked || !(r.masked.privateNamesLoaded > 0)) bad('privateNamesLoaded = 0 (capture chưa nạp danh sách tên riêng)');
  if (!r.sys || r.sys.freeMemMinMB > r.sys.freeMemStartMB) bad('sys.freeMemMinMB lớn hơn freeMemStartMB');
});

if (problems.length) { console.log(`ĐÁNG NGỜ: ${problems.length} vấn đề trên ${rows.length} dòng`); problems.forEach((p) => console.log(' - ' + p)); process.exit(1); }
console.log(`SẠCH: ${rows.length} dòng`);
