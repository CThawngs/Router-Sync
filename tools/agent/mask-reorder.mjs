#!/usr/bin/env node
// tools/agent/mask-reorder.mjs
// C40 X1.4: che tên riêng trong tệp sắp xếp lại trước khi đưa vào gói bằng chứng.
// Chỉ in số đã che; không in tên.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { effectivePrivateNames } from './private-names.mjs';
import { personalPatterns } from './scan-private-names.mjs';

export function maskReorder(text, names = effectivePrivateNames()) {
  let out = text;
  names.forEach((name, index) => {
    if (name && name.length >= 3) out = out.split(name).join(`<private-${index + 1}>`);
  });
  for (const pattern of personalPatterns()) out = out.replace(pattern.regex, `<${pattern.name}>`);
  // Tên gateway tự sinh dạng UUID: không nằm trong danh sách guard nhưng vẫn là tên riêng.
  out = out.replace(/openai-compatible-chat-[0-9a-f-]{16,}/gi, '<private-gateway>');
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
  return out;
}

export function countMasked(text, names = effectivePrivateNames()) {
  return names.reduce((n, name) => n + (name && text.includes(name) ? 1 : 0), 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('dùng: node tools/agent/mask-reorder.mjs <in> <out>');
    process.exit(2);
  }
  const before = readFileSync(input, 'utf8');
  const after = maskReorder(before);
  writeFileSync(output, after, 'utf8');
  console.log(`[mask-reorder] tên đã che=${countMasked(before)}, còn lại=${countMasked(after)}`);
}
