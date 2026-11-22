#!/usr/bin/env node
// tools/agent/order-by-name.mjs
// C41 Y1.5: đề xuất thứ tự CHỈ từ tên model (không phải số đo chất lượng).
// Model lớn trước nhỏ trong cùng provider; các provider được xen kẽ.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Ước lượng kích thước từ tên; trả 0 khi không có dấu hiệu rõ. */
export function sizeHint(step) {
  const s = String(step).toLowerCase();
  if (/\bultra\b/.test(s)) return 10_000;
  if (/\b550b\b/.test(s)) return 550;
  const match = s.match(/(?:^|[/_-])(\d+(?:\.\d+)?)\s*b\b/);
  if (match) return Number(match[1]);
  if (/\bnano\b/.test(s) || /\bxs\b/.test(s)) return 1;
  if (/\bsmall\b|\bmini\b/.test(s)) return 2;
  if (/\bflash\b|\blight\b/.test(s)) return 3;
  return 0;
}

export function orderByName(steps) {
  const groups = new Map();
  for (const step of steps) {
    const provider = step.split('/')[0];
    const list = groups.get(provider) ?? [];
    list.push(step);
    groups.set(provider, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => sizeHint(b) - sizeHint(a) || a.localeCompare(b));
  }
  const out = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const list of groups.values()) {
      const next = list.shift();
      if (next !== undefined) {
        out.push(next);
        progressed = true;
      }
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('dùng: node tools/agent/order-by-name.mjs <tệp-danh-sách>');
    process.exit(2);
  }
  const steps = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes('/') && !l.startsWith('#'));
  for (const step of orderByName(steps)) console.log(step);
}
