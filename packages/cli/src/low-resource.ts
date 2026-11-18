/**
 * packages/cli/src/low-resource.ts
 *
 * Single source of truth for low-resource mode detection.
 *
 * Priority:
 *   1. ROUTERSYNC_LOW_RESOURCE=1  → always on
 *      ROUTERSYNC_LOW_RESOURCE=0  → always off
 *   2. Auto-detect: totalRAM ≤ 8 GiB, OR availableCores ≤ 4, OR availableMem < 2 GiB
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const GiB = 1024 * 1024 * 1024;
const AUTO_TOTAL_RAM_GIB = 8;
const AUTO_FREE_RAM_GIB = 2;
const AUTO_CORES = 4;
const NOTICE_TTL_MS = 10 * 60 * 1000;

let _cached: boolean | undefined;
let _reason: string | undefined;

/**
 * C15 Q1.3: parse `vm_stat` output into available bytes.
 * Uses free + inactive + speculative + purgeable pages (macOS counts cache as
 * unavailable in os.freemem()). No ellipses, no rounding beyond bytes.
 */
export function parseVmStat(text: string): number | null {
  const m = text.match(/page size of\s+(\d+)\s+bytes/i);
  if (!m) return null;
  const pageSize = Number(m[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  let pages = 0;
  let found = false;
  for (const key of ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable']) {
    const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(`${key}:`));
    if (!line) continue;
    const value = line.split(':')[1]?.replace(/[^\d]/g, '');
    if (value && value.length > 0) {
      pages += Number(value);
      found = true;
    }
  }
  return found ? pages * pageSize : null;
}

/** Available memory in bytes. Linux/Windows: os.freemem(); macOS: vm_stat with a 1 s timeout. */
export function availableMemoryBytes(): number {
  if (process.platform !== 'darwin') return os.freemem();
  try {
    const r = spawnSync('vm_stat', [], { encoding: 'utf8', timeout: 1000 });
    if (r.status === 0 && typeof r.stdout === 'string') {
      const parsed = parseVmStat(r.stdout);
      if (parsed !== null) return parsed;
    }
  } catch {
    // fall through to os.freemem()
  }
  return os.freemem();
}

function noticeFlagPath(): string {
  const stateDir = process.env['ROUTERSYNC_STATE_DIR']
    ? path.resolve(process.env['ROUTERSYNC_STATE_DIR'])
    : path.join(os.homedir(), '.routersync');
  return path.join(stateDir, 'low-resource-notice.json');
}

/** C15 Q1.4: print the auto-detect notice at most once per 10-minute window, never for --json. */
function printAutoNoticeOnce(reason: string): void {
  if (process.argv.includes('--json')) return;
  const flag = noticeFlagPath();
  const now = Date.now();
  try {
    if (fs.existsSync(flag)) {
      const raw = JSON.parse(fs.readFileSync(flag, 'utf8')) as { at?: number };
      if (typeof raw.at === 'number' && now - raw.at < NOTICE_TTL_MS) return;
    }
  } catch {
    // unreadable flag: treat as expired
  }
  try {
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, JSON.stringify({ at: now }) + '\n', 'utf8');
  } catch {
    // best-effort flag; still print this once
  }
  process.stderr.write(`[routersync] low-resource mode: ${reason}\n`);
}

/** Exposed for tests: one-time notice behaviour. */
export const _printAutoNoticeOnce = printAutoNoticeOnce;

export function isLowResource(): boolean {
  if (_cached !== undefined) return _cached;

  const envVal = process.env['ROUTERSYNC_LOW_RESOURCE'];
  if (envVal === '1') {
    _cached = true;
    _reason = 'ROUTERSYNC_LOW_RESOURCE=1 (manual)';
    return true;
  }
  if (envVal === '0') {
    _cached = false;
    return false;
  }

  const totalMem = os.totalmem();
  const availMem = availableMemoryBytes();
  const cores = os.availableParallelism?.() ?? os.cpus().length;

  if (totalMem <= AUTO_TOTAL_RAM_GIB * GiB) {
    _cached = true;
    _reason = `auto: totalRAM ${(totalMem / GiB).toFixed(1)} GiB ≤ ${AUTO_TOTAL_RAM_GIB} GiB`;
  } else if (cores <= AUTO_CORES) {
    _cached = true;
    _reason = `auto: availableCores ${cores} ≤ ${AUTO_CORES}`;
  } else if (availMem < AUTO_FREE_RAM_GIB * GiB) {
    _cached = true;
    _reason = `auto: availableMem ${(availMem / GiB).toFixed(1)} GiB < ${AUTO_FREE_RAM_GIB} GiB`;
  } else {
    _cached = false;
  }

  if (_cached && _reason) printAutoNoticeOnce(_reason);
  return _cached;
}

/** Returns the reason string when auto-detected, or undefined when manual/off. */
export function lowResourceReason(): string | undefined {
  isLowResource();
  return _reason;
}

/** Reset cached state — for testing only. */
export function _resetLowResourceCache(): void {
  _cached = undefined;
  _reason = undefined;
}

/** Remove the notice flag — for testing only. */
export function _resetLowResourceNotice(): void {
  try {
    fs.rmSync(noticeFlagPath(), { force: true });
  } catch {
    // ignore
  }
}

/** C14: Lower the OS priority on resource-constrained machines. */
export function applyLowResourcePriority(): boolean {
  if (!isLowResource()) return false;
  try {
    const low = (os.constants?.priority?.PRIORITY_LOW ?? 5) as number;
    os.setPriority(process.pid, low);
    return true;
  } catch {
    return false;
  }
}
