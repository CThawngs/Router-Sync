/**
 * packages/core/src/consent/freeze.ts
 *
 * Emergency Freeze circuit breaker (`<stateDir>/freeze.json`, Phục vụ: S4, S9).
 *
 * Fail-closed invariant:
 *  - Absent `freeze.json` -> `{ frozen: false }` (0 files/dirs created).
 *  - Unreadable or malformed `freeze.json` -> `{ frozen: true, reason: 'corrupt-freeze-file-fail-closed' }`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../paths/atomic.js';
import { type FreezeStateFile, resolveControlStateDir } from './types.js';

export const FREEZE_STATE_FILENAME = 'freeze.json';

/**
 * Strictly read-only check of `<stateDir>/freeze.json`.
 * Never creates directories or files on disk.
 */
export function readFreezeState(explicitStateDir?: string | undefined): FreezeStateFile {
  const stateDir = resolveControlStateDir(explicitStateDir);
  const freezePath = path.join(stateDir, FREEZE_STATE_FILENAME);
  if (!fs.existsSync(freezePath)) {
    return {
      version: 1,
      frozen: false,
      frozenAt: null,
      reason: null,
    };
  }
  try {
    const raw = fs.readFileSync(freezePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed['frozen'] !== 'boolean') {
      return {
        version: 1,
        frozen: true,
        frozenAt: null,
        reason: 'corrupt-freeze-file-fail-closed',
      };
    }
    if (parsed['frozen'] === true) {
      return {
        version: 1,
        frozen: true,
        frozenAt: typeof parsed['frozenAt'] === 'string' ? parsed['frozenAt'] : null,
        unfrozenAt: null,
        reason: typeof parsed['reason'] === 'string' ? parsed['reason'] : 'frozen',
      };
    }
    return {
      version: 1,
      frozen: false,
      frozenAt: null,
      unfrozenAt: typeof parsed['unfrozenAt'] === 'string' ? parsed['unfrozenAt'] : null,
      reason: null,
    };
  } catch {
    return {
      version: 1,
      frozen: true,
      frozenAt: null,
      reason: 'corrupt-freeze-file-fail-closed',
    };
  }
}

/**
 * Immediately trips the emergency freeze circuit breaker (`0` TTY prompt required).
 */
export function activateFreeze(
  explicitStateDir?: string | undefined,
  reason?: string | null | undefined,
  nowMs = Date.now()
): FreezeStateFile {
  const stateDir = resolveControlStateDir(explicitStateDir);
  const freezePath = path.join(stateDir, FREEZE_STATE_FILENAME);
  const state: FreezeStateFile = {
    version: 1,
    frozen: true,
    frozenAt: new Date(nowMs).toISOString(),
    unfrozenAt: null,
    reason: typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'emergency-freeze',
  };
  atomicWriteFileSync(freezePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

/**
 * Clears the freeze circuit breaker (CLI caller MUST verify interactive TTY + `'unfreeze'` first).
 */
export function deactivateFreeze(
  explicitStateDir?: string | undefined,
  nowMs = Date.now()
): FreezeStateFile {
  const stateDir = resolveControlStateDir(explicitStateDir);
  const freezePath = path.join(stateDir, FREEZE_STATE_FILENAME);
  const state: FreezeStateFile = {
    version: 1,
    frozen: false,
    frozenAt: null,
    unfrozenAt: new Date(nowMs).toISOString(),
    reason: null,
  };
  atomicWriteFileSync(freezePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}
