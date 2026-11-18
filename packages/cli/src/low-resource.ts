/**
 * packages/cli/src/low-resource.ts
 *
 * Single source of truth for low-resource mode detection.
 *
 * Priority:
 *   1. ROUTERSYNC_LOW_RESOURCE=1  → always on
 *      ROUTERSYNC_LOW_RESOURCE=0  → always off
 *   2. Auto-detect: totalRAM ≤ 8 GiB, OR availableCores ≤ 4, OR freeMem < 2 GiB
 */

import * as os from 'node:os';

const GiB = 1024 * 1024 * 1024;
const AUTO_TOTAL_RAM_GIB = 8;
const AUTO_FREE_RAM_GIB = 2;
const AUTO_CORES = 4;

let _cached: boolean | undefined;
let _reason: string | undefined;

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

  // Auto-detect
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cores = os.availableParallelism?.() ?? os.cpus().length;

  if (totalMem <= AUTO_TOTAL_RAM_GIB * GiB) {
    _cached = true;
    _reason = `auto: totalRAM ${(totalMem / GiB).toFixed(1)} GiB ≤ ${AUTO_TOTAL_RAM_GIB} GiB`;
  } else if (cores <= AUTO_CORES) {
    _cached = true;
    _reason = `auto: availableCores ${cores} ≤ ${AUTO_CORES}`;
  } else if (freeMem < AUTO_FREE_RAM_GIB * GiB) {
    _cached = true;
    _reason = `auto: freeMem ${(freeMem / GiB).toFixed(1)} GiB < ${AUTO_FREE_RAM_GIB} GiB`;
  } else {
    _cached = false;
  }

  if (_cached) {
    process.stderr.write(`[routersync] low-resource mode: ${_reason}\n`);
  }

  return _cached;
}

/** Returns the reason string when auto-detected, or undefined when manual/off. */
export function lowResourceReason(): string | undefined {
  isLowResource(); // ensure evaluated
  return _reason;
}

/** Reset cached state — for testing only. */
export function _resetLowResourceCache(): void {
  _cached = undefined;
  _reason = undefined;
}

/**
 * C14: Lower the OS priority of the current process when low-resource mode is
 * active. Best-effort: unsupported platforms / missing permissions are ignored.
 * Returns true when the priority was actually lowered.
 */
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
