#!/usr/bin/env node
// heavy.mjs — chặn lệnh nặng khi RAM trống < 1.5 GiB (máy yếu treo).
// Dùng: node tools/agent/heavy.mjs -- <lệnh>
//   Exit 3 = bị chặn (RAM thấp), Exit 2 = lệnh không hợp lệ, Exit N = mã lệnh thật.
// RS_FORCE_HEAVY=1 hoặc CI=true: bỏ qua cổng (CI luôn đặt CI=true).
import { spawnSync } from 'node:child_process';
import os from 'node:os';

export const MIN_FREE_BYTES = 1.5 * 1024 ** 3;

// Mỗi mục là danh sách bước; mỗi bước là mảng tham số cho pnpm.
// Không dùng toán tử shell (&&, ;, |) — mỗi bước chạy riêng.
export const HEAVY_REAL = {
  'pnpm test': [['exec', 'vitest', 'run', '--project', 'root-tools', '--project', 'packages']],
  'pnpm test:branch': [['exec', 'vitest', 'run', '--changed', 'origin/main']],
  'pnpm test:slow': [['exec', 'vitest', 'run', '--project', 'ui']],
  'pnpm typecheck': [['exec', 'tsc', '--noEmit'], ['-r', 'typecheck']],
  'pnpm build': [['-r', 'build']],
  'pnpm e2e': [['exec', 'vitest', 'run', '--project', 'e2e']],
};

/**
 * C15 Q1.3 / C19 W1: parse `vm_stat` into available bytes.
 * os.freemem() undercounts on macOS (it ignores inactive/speculative/purgeable
 * pages), so the gate must use the same formula as packages/cli/src/low-resource.ts.
 */
export function parseVmStat(text) {
  const match = text.match(/page size of\s+(\d+)\s+bytes/i);
  if (!match) return null;

  const pageSize = Number(match[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  let pages = 0;
  let found = false;
  for (const key of ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable']) {
    const line = text.split(/\r?\n/).find((candidate) => candidate.trim().startsWith(`${key}:`));
    if (!line) continue;

    const value = line.split(':')[1]?.replace(/[^\d]/g, '');
    if (value) {
      pages += Number(value);
      found = true;
    }
  }
  return found ? pages * pageSize : null;
}

/** Available memory in bytes. Linux/Windows: os.freemem(); macOS: vm_stat. */
export function availableMemoryBytes() {
  if (process.platform !== 'darwin') return os.freemem();

  const r = spawnSync('vm_stat', [], { encoding: 'utf8', timeout: 1000 });
  if (r.status === 0 && typeof r.stdout === 'string') {
    const parsed = parseVmStat(r.stdout);
    if (parsed !== null) return parsed;
  }
  return os.freemem();
}

export function decideHeavy(freeBytes = availableMemoryBytes(), force = false) {
  if (force) return false;
  return freeBytes < MIN_FREE_BYTES;
}

function main() {
  const idx = process.argv.indexOf('--');
  const cmd = idx >= 0 ? process.argv.slice(idx + 1).join(' ').trim() : '';
  const steps = HEAVY_REAL[cmd];
  if (!steps) {
    console.error('[heavy.mjs] lệnh nặng chưa biết hoặc không thuộc danh sách: ' + JSON.stringify(cmd));
    console.error('[heavy.mjs] mệnh lệnh hợp lệ: ' + Object.keys(HEAVY_REAL).join(', '));
    process.exit(2);
  }

  const free = availableMemoryBytes();
  const force = process.env.RS_FORCE_HEAVY === '1' || process.env.CI === 'true';
  if (decideHeavy(free, force)) {
    console.error(`[heavy.mjs] RAM trống ${(free / (1024 ** 3)).toFixed(2)} GiB (< ${(MIN_FREE_BYTES / (1024 ** 3)).toFixed(1)} GiB) - chặn lệnh nặng: ${cmd}`);
    console.error('[heavy.mjs] dùng pnpm test:file -- <đường dẫn> cho lệnh nhẹ, hoặc để CI chạy toàn bộ.');
    process.exit(3);
  }

  for (const step of steps) {
    const r = spawnSync('pnpm', step, {
      stdio: 'inherit',
      // Windows cần shell để chạy pnpm.cmd; các bước không chứa toán tử shell.
      shell: process.platform === 'win32',
    });
    if (r.error) process.exit(1);
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  process.exit(0);
}

// Chỉ chạy main() khi file này là entry point (vitest import không bị chặn).
if (process.argv[1] && process.argv[1].endsWith('heavy.mjs')) main();
