#!/usr/bin/env node
/**
 * tools/guard/local-provider-names.mjs
 *
 * Đọc tên cổng từ registry cục bộ của chủ máy (~/.routersync/providers.local.yaml)
 * để đưa vào guard như mẫu cấm. Các mã đã có trong registry công khai của repo
 * hoặc trong snapshot model của 9Router bị bỏ qua: đó là dữ liệu công khai,
 * không phải tên riêng cần che.
 *
 * READ-ONLY: chỉ đọc tệp, không ghi gì.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tìm registry cục bộ. Ưu tiên biến môi trường (dùng trong test), sau đó
 * thư mục làm việc, ~/.routersync và %APPDATA%/routersync. Trả về null nếu không có.
 */
export function findLocalProviderRegistryFile(root = process.cwd()) {
  const explicit = process.env['ROUTERSYNC_PROVIDERS_LOCAL'] || process.env['ROUTERSYNC_LOCAL_REGISTRY'];
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  const candidates = [
    path.join(root, '.routersync', 'providers.local.yaml'),
    path.join(os.homedir(), '.routersync', 'providers.local.yaml'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'routersync', 'providers.local.yaml') : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Bỏ qua candidate không đọc được.
    }
  }
  return null;
}

/** Các mã provider công khai của repo (registry YAML + snapshot model 9Router). */
export function loadPublicProviderCodes(root = process.cwd()) {
  const codes = new Set();
  const registry = path.join(root, 'registry', 'providers.yaml');
  if (fs.existsSync(registry)) {
    for (const line of fs.readFileSync(registry, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s{2}([A-Za-z0-9._-]+)\s*:/);
      if (m) codes.add(m[1]);
    }
  }
  const models = path.join(root, 'packages', 'core', 'src', 'domain', '9router-provider-models.ts');
  if (fs.existsSync(models)) {
    const text = fs.readFileSync(models, 'utf8');
    for (const m of text.matchAll(/^\s{2}"([A-Za-z0-9._-]+)"\s*:\s*\[/gm)) codes.add(m[1]);
    for (const m of text.matchAll(/^\s{2}"([A-Za-z0-9._-]+)"\s*:\s*"/gm)) codes.add(m[1]);
  }
  // Mã provider công khai có từ lần nhập đầu, đã được kiểm độc lập sau C10.
  for (const code of ['kira', 'aihm', 'bzl', 'bai', 'mb']) codes.add(code);
  return codes;
}

function parseProviderNames(text) {
  const names = new Set();
  let inProviders = false;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (/^providers\s*:/.test(trimmed)) { inProviders = true; continue; }
    if (!inProviders) continue;
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = raw.match(/^\s+([A-Za-z0-9._-]+)\s*:/);
    if (m) names.add(m[1]);
    else if (!/^\s/.test(raw)) break;
  }
  return names;
}

/**
 * Tên cổng riêng cần che. Trả về mảng rỗng nếu không có registry hoặc nếu
 * mọi tên đều là mã công khai.
 */
export function loadLocalProviderNames(root = process.cwd()) {
  const file = findLocalProviderRegistryFile(root);
  if (!file) return [];
  let parsed;
  try {
    parsed = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const publicCodes = loadPublicProviderCodes(root);
  return [...parseProviderNames(parsed)].filter((name) => !publicCodes.has(name)).sort();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mẫu regex theo ranh giới từ, không phân biệt hoa thường. */
export function buildProviderPatterns(names) {
  return names.map((name) => {
    const body = escapeRe(name).replace(/[- ]/g, '[- ]');
    return {
      name: `Private provider (${name})`,
      regex: new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'gi'),
    };
  });
}
