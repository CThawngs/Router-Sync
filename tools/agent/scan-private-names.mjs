#!/usr/bin/env node
// tools/agent/scan-private-names.mjs
//
// L0.3: đếm (không in) số lần tên riêng xuất hiện ở một ref hoặc một file.
//
// Dùng:
//   node tools/agent/scan-private-names.mjs <ref>...
//   node tools/agent/scan-private-names.mjs --file <path>
//
// Chỉ in "<nơi>: <số lần khớp>". Không bao giờ in tên.

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { effectivePrivateNames } from './private-names.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** V0: mẫu cá nhân — tên user OS, C:\Users\<user>, /Users/<user>, /home/<user>, OneDrive. */
export function personalPatterns(user = userInfo().username) {
  const name = String(user ?? '').trim();
  if (!name) return [];
  const paths = [
    'C:\\Users\\' + name,
    'C:/Users/' + name,
    '/Users/' + name,
    '/home/' + name,
    'OneDrive',
  ];
  const names = [name, ...paths];
  return names.map((n) => ({
    name: /^[A-Za-z0-9._-]+$/.test(n) ? '<OS_USER>' : '<PERSONAL_PATH>',
    regex: new RegExp(esc(n).replace(/[- ]/g, '[- ]'), 'gi'),
  }));
}

export function buildMatchers(names = effectivePrivateNames(), withPersonal = true) {
  const all = names.map((n) => ({
    name: '<private>',
    regex: new RegExp(`(?<![A-Za-z0-9])${esc(n).replace(/[- ]/g, '[- ]')}(?![A-Za-z0-9])`, 'gi'),
  }));
  if (withPersonal) all.push(...personalPatterns());
  return all;
}

export function countText(text, matchers = buildMatchers()) {
  let hits = 0;
  for (const { regex } of matchers) {
    regex.lastIndex = 0;
    while (regex.exec(text)) hits += 1;
  }
  return hits;
}

function countRef(ref, matchers) {
  let listing = '';
  try {
    listing = execFileSync('git', ['ls-tree', '-r', '--name-only', ref], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    return `SKIP (${String(err.stderr ?? err.message).split('\n')[0]})`;
  }
  const files = listing
    .split('\n')
    .filter(Boolean)
    .filter((p) => !/\.(png|jpe?g|gif|ico|pdf|zip|gz|mp4|webm|woff2?|ttf|exe|dll)$/i.test(p));
  let total = 0;
  const perFile = [];
  for (const file of files) {
    let blob;
    try {
      blob = execFileSync('git', ['show', `${ref}:${file}`], { maxBuffer: 64 * 1024 * 1024 });
    } catch {
      continue;
    }
    if (blob.includes(0)) continue;
    const n = countText(blob.toString('utf8'), matchers);
    if (n > 0) {
      total += n;
      perFile.push(`${file}=${n}`);
    }
  }
  return `${total}${perFile.length ? ` -> ${perFile.join(', ')}` : ''}`;
}

function main() {
  const args = process.argv.slice(2);
  const names = effectivePrivateNames();
  if (args[0] === '--file') {
    const file = args[1];
    if (!file || !existsSync(file)) {
      console.error(`không thấy file: ${file ?? '(chưa truyền)'}`);
      process.exit(2);
    }
    console.log(`${file}: ${countText(readFileSync(file, 'utf8'))}`);
    process.exit(0);
  }
  if (args.length === 0) {
    console.error('dùng: node tools/agent/scan-private-names.mjs <ref>... | --file <path>');
    process.exit(2);
  }
  console.log(`# danh sách hiệu dụng: ${names.length} tên`);
  for (const ref of args) console.log(`${ref}: ${countRef(ref, buildMatchers(names))}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
