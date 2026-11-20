#!/usr/bin/env node
// heavy.mjs — chặn lệnh nặng khi RAM trống < 1.5 GiB (máy yếu treo).
// Dùng: node tools/agent/heavy.mjs -- <lệnh>
//   Exit 3 = bị chặn (RAM thấp), Exit 2 = lệnh không hợp lệ, Exit N = mã lệnh thật.
// RS_FORCE_HEAVY=1 hoặc CI=true: bỏ qua cổng (CI luôn đặt CI=true).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { MIN_FREE_BYTES, availableMemoryBytes, parseVmStat } from './low-resource.mjs';

// Re-exported so existing tests and the CLI keep importing from heavy.mjs.
export { MIN_FREE_BYTES, availableMemoryBytes, parseVmStat };

// Mỗi mục là danh sách bước; mỗi bước là mảng tham số cho pnpm.
// Không dùng toán tử shell (&&, ;, |) — mỗi bước chạy riêng.
export const HEAVY_REAL = {
  'pnpm test': [['exec', 'vitest', 'run', '--project', 'root-tools', '--project', 'packages']],
  'pnpm test:related': [['exec', 'node', 'tools/ci/related-tests.mjs']],
  'pnpm test:branch': [['exec', 'vitest', 'run', '--changed', 'origin/main']],
  'pnpm test:slow': [['exec', 'vitest', 'run', '--project', 'ui']],
  'pnpm typecheck': [['exec', 'tsc', '--noEmit'], ['-r', 'typecheck']],
  'pnpm build': [['-r', 'build']],
  'pnpm e2e': [['exec', 'vitest', 'run', '--project', 'e2e']],
};

export function decideHeavy(freeBytes = availableMemoryBytes(), force = false) {
  if (force) return false;
  return freeBytes < MIN_FREE_BYTES;
}

/**
 * C20 X2.4: build the pnpm invocation without a shell.
 *
 * `spawnSync(cmd, args, { shell: true })` prints DEP0190 on Node 24 because the
 * arguments are concatenated into one shell string. Two non-shell options work:
 *   - `node <pnpm.cjs> ...` when the shim's CommonJS entry is installed
 *   - `cmd.exe /c pnpm.cmd ...` otherwise (a cmd shim is not an executable)
 * The command name stays `pnpm` in the gate message either way.
 */
export function resolvePnpmInvocation(args) {
  const npmRoot = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '';
  const candidates = [
    path.join(npmRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    path.join(npmRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  ];
  for (const entry of candidates) {
    if (existsSync(entry)) return { command: process.execPath, args: [entry, ...args], label: 'pnpm.cjs' };
  }
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm.cmd', ...args], label: 'cmd/pnpm.cmd' };
  }
  return { command: 'pnpm', args, label: 'pnpm' };
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
    // C20 X2.4: spawnSync(cmd, args, { shell: true }) prints DEP0190 on Node 24
    // because the arguments are concatenated into one shell string. Resolve the
    // pnpm shim once and run it without a shell instead.
    const invocation = resolvePnpmInvocation(step);
    const r = spawnSync(invocation.command, invocation.args, { stdio: 'inherit' });
    if (r.error) process.exit(1);
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  process.exit(0);
}

// Chỉ chạy main() khi file này là entry point (vitest import không bị chặn).
if (process.argv[1] && process.argv[1].endsWith('heavy.mjs')) main();
