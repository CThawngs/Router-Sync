#!/usr/bin/env node
// tools/agent/x40-evidence.mjs
// C40: đếm số request đã dùng ở các vòng bằng chứng và chuẩn bị bước chưa đo.
// Chỉ đọc git/file local; không gọi router, không in tên riêng.
import { execFileSync } from 'node:child_process';

export const EVIDENCE_REFS = [
  'origin/evidence/c32',
  'origin/evidence/c33',
  'origin/evidence/c34',
  'origin/evidence/c35',
  'origin/evidence/c36',
  'origin/evidence/c37',
  'origin/evidence/c37-e2e',
  'origin/evidence/c38',
  'origin/evidence/c39',
];

const VERDICT_RE = /^(OK|RATE-LIMITED|TIMEOUT-NO-HEADER|HANG-AFTER-USAGE|HANG-NO-USAGE|HANG|RELIABLE|SLOW|DEAD|SKIPPED-QUOTA|ERROR-5XX|ERROR|NO-RESULT)$/;

/** Một dòng kết quả probe/reliability có dạng `model\tVERDICT\t...`. */
export function countProbeLines(text) {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split('\t');
    if (p.length >= 3 && p[0]?.includes('/') && VERDICT_RE.test(p[1] ?? '')) n += 1;
  }
  return n;
}

export function listRefFiles(ref) {
  try {
    return execFileSync('git', ['ls-tree', '-r', '--name-only', ref], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((f) => f.endsWith('.out.txt'));
  } catch {
    return [];
  }
}

export function readRefFile(ref, file) {
  return execFileSync('git', ['show', `${ref}:${file}`], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString('utf8');
}

/** Tổng hợp số dòng kết quả, ước lượng số request của các vòng trước. */
export function countHistoricRequests(refs = EVIDENCE_REFS) {
  const out = [];
  for (const ref of refs) {
    let count = 0;
    for (const file of listRefFiles(ref)) {
      try {
        count += countProbeLines(readRefFile(ref, file));
      } catch {
        // file nhị phân hoặc đã đổi tên: bỏ qua
      }
    }
    out.push({ ref, requests: count });
  }
  return out;
}

const KEEP = new Set(['OK', 'RATE-LIMITED', 'TIMEOUT-NO-HEADER', 'HANG-AFTER-USAGE', 'HANG-NO-USAGE']);

/** 39 bước W4 lấy từ C32, trừ 22 bước đã đo ở C38 → các bước còn thiếu. */
export function unmeasuredSteps(c32runs, reliabilityText) {
  const all = new Set();
  for (const text of c32runs) {
    for (const line of text.split(/\r?\n/)) {
      const p = line.trim().split('\t');
      if (p.length >= 4 && p[0]?.includes('/') && KEEP.has(p[1] ?? '')) all.add(p[0]);
    }
  }
  const measured = new Set();
  for (const line of reliabilityText.split(/\r?\n/)) {
    const p = line.trim().split('\t');
    if (p.length >= 3 && p[0]?.includes('/') && VERDICT_RE.test(p[1] ?? '')) measured.add(p[0]);
  }
  return [...all].filter((s) => !measured.has(s)).sort();
}

if (process.argv[1] && process.argv[1].endsWith('x40-evidence.mjs')) {
  const counts = countHistoricRequests();
  const total = counts.reduce((n, r) => n + r.requests, 0);
  for (const r of counts) console.log(`${r.ref}\t${r.requests}`);
  console.log(`TỔNG ƯỚC LƯỢNG\ttotal=${total}`);
}
