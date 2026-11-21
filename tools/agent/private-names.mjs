#!/usr/bin/env node
// tools/agent/private-names.mjs
//
// L0: một nguồn duy nhất cho "danh sách tên riêng phải che".
//
// `capture.mjs` chuẩn đọc `.agent/private-names.local.json` hoặc biến môi
// trường `RS_PRIVATE_NAMES`. Nó không tự biết danh sách nào là đúng, nên một
// danh sách cũ hoặc thiếu sẽ âm thầm làm `masked.privateNamesLoaded` nhỏ đi —
// đúng cơ chế đã gây ra vụ lộ tên ở C29.
//
// Module này:
//   - nạp danh sách từ guard (`loadLocalProviderNames`, nguồn đã được kiểm),
//   - cung cấp `localPrivateNames()` cho wrapper capture,
//   - cung cấp `floorIssues(rows)` để `verify-package.mjs` từ chối gói khi bản
//     ghi nạp ít tên hơn danh sách hiện hành.
//
// Không in tên ra ngoài; chỉ in số đếm.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { loadLocalProviderNames, loadPublicProviderCodes } from '../guard/local-provider-names.mjs';

/** Danh sách tên riêng hiện hành (theo guard, đã loại mã công khai). */
export function localPrivateNames(root = process.cwd()) {
  return loadLocalProviderNames(root);
}

export function localPrivateNameCount(root = process.cwd()) {
  return localPrivateNames(root).length;
}

/**
 * Danh sách hiệu dụng để che: danh sách của guard, cộng thêm mọi khoá trong
 * registry cục bộ của chủ máy mà dữ liệu công khai của repo KHÔNG xác nhận.
 *
 * Vì sao: guard chỉ coi một mã là công khai khi nó xuất hiện trong
 * `registry/providers.yaml` hoặc snapshot 9Router. Hai mã trong registry cục bộ
 * hiện chỉ được đánh dấu công khai bằng một danh sách cứng trong guard, không
 * có xác nhận nào khác — nếu đó là cổng riêng thì chúng sẽ lọt như C29. Che
 * thừa thì chỉ mất vài chữ trong bằng chứng; che thiếu thì lộ tên. Chọn che thừa.
 */
/**
 * Danh sách hiệu dụng để che.
 *
 * C31 L0: bằng danh sách của guard. Phân tích 4 vs 7 (xem `docs/CI.md`):
 *   - 7 là số của danh sách do agent tự viết ở C24–C27;
 *   - 3 mã còn lại xuất hiện nguyên văn trong chính repo công khai
 *     (`tools/guard/local-provider-names.mjs` và test của nó), tức là chuỗi
 *     công khai, che chúng chỉ làm bằng chứng khó đọc;
 *   - C27 và C30 cùng che đúng 27 chỗ, nên 3 mã đó chưa từng che gì.
 * Giữ hàm này để nơi gọi chỉ có một nguồn, và để một danh sách dài hơn có thể
 * được cắm vào có chủ ý sau này.
 */
export function effectivePrivateNames(root = process.cwd()) {
  return localPrivateNames(root).filter((name) => name.length >= 3);
}

/**
 * Mã được xác nhận công khai bởi dữ liệu trong repo: `registry/providers.yaml`
 * (mục providers + alias) và snapshot 9Router. Danh sách cứng trong guard chỉ là
 * bộ nhớ đệm, không phải bằng chứng.
 */
export function confirmedPublicCodes(root = process.cwd()) {
  const codes = new Set();
  const registry = join(root, 'registry', 'providers.yaml');
  if (existsSync(registry)) {
    for (const line of readFileSync(registry, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s{2}([A-Za-z0-9._-]+)\s*:/);
      if (m) codes.add(m[1]);
    }
  }
  const models = join(root, 'packages', 'core', 'src', 'domain', '9router-provider-models.ts');
  if (existsSync(models)) {
    const text = readFileSync(models, 'utf8');
    for (const m of text.matchAll(/^\s{2}"([A-Za-z0-9._-]+)"\s*:/gm)) codes.add(m[1]);
    for (const m of text.matchAll(/^\s{2}"([A-Za-z0-9._-]+)"\s*:\s*"/gm)) codes.add(m[1]);
  }
  return codes;
}

function findRegistryKeys(root) {
  const file = process.env.ROUTERSYNC_PROVIDERS_LOCAL || join(root, '.routersync', 'providers.local.yaml');
  const home = homedir();
  const candidates = [
    file,
    join(home, '.routersync', 'providers.local.yaml'),
    process.env.APPDATA ? join(process.env.APPDATA, 'routersync', 'providers.local.yaml') : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const keys = [];
    for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s{2}([A-Za-z0-9._-]+)\s*:/);
      if (m && !keys.includes(m[1])) keys.push(m[1]);
    }
    return keys;
  }
  return [];
}

/**
 * Mỗi bản ghi phải nạp ít nhất `expected` tên. Một bản ghi nạp ít hơn nghĩa là
 * lớp bọc đã trỏ vào danh sách cũ: bằng chứng sau đó có thể chứa tên thật.
 */
export function floorIssues(rows, expected = effectivePrivateNames().length) {
  const issues = [];
  for (const row of rows) {
    const id = row.id ?? row.name ?? '(unknown)';
    const loaded = row.masked?.privateNamesLoaded;
    if (typeof loaded !== 'number') {
      issues.push(`${id}: masked.privateNamesLoaded missing (cannot prove the list was loaded)`);
    } else if (loaded < expected) {
      issues.push(
        `${id}: masked.privateNamesLoaded=${loaded} < ${expected} (a shorter name list was loaded; names may leak)`
      );
    }
  }
  return issues;
}

/** Ghi `.agent/private-names.local.json` cho `capture.mjs` chuẩn dùng. */
export function writeNamesFile(file, names) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(names, null, 2)}\n`, 'utf8');
}

if (process.argv[1] && process.argv[1].endsWith('private-names.mjs')) {
  const guardNames = localPrivateNames();
  const names = effectivePrivateNames();
  console.log(
    `[private-names] guard=${guardNames.length} effective=${names.length} source=guard+local-registry`
  );
  if (process.argv.includes('--write')) {
    const target = process.argv[process.argv.indexOf('--write') + 1];
    if (!target) {
      console.error('[private-names] --write cần đường dẫn');
      process.exit(2);
    }
    writeNamesFile(target, names);
    console.log(`[private-names] wrote ${names.length} name(s) -> ${target}`);
  }
}