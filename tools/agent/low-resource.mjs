// low-resource.mjs — one definition of "how much RAM is free".
//
// Both the CLI gate (tools/agent/heavy.mjs) and the test runner cap
// (vitest.config.ts) import from here, so the threshold and the macOS formula
// can never drift apart. This module has no shebang and no side effects: the
// vitest config bundles it with esbuild, which rejects `#!` lines.
import { spawnSync } from 'node:child_process';
import os from 'node:os';

export const MIN_FREE_BYTES = 1.5 * 1024 ** 3;

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