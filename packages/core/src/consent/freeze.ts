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
import {
  type FreezeHistoryEvent,
  type FreezeStateFile,
  resolveControlStateDir,
} from './types.js';

export const FREEZE_STATE_FILENAME = 'freeze.json';
const MAX_FREEZE_HISTORY_EVENTS = 100;

function parseFreezeHistory(rawHistory: unknown): FreezeHistoryEvent[] {
  if (!Array.isArray(rawHistory)) return [];
  const valid: FreezeHistoryEvent[] = [];
  for (const item of rawHistory) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const action = rec['action'];
    const timestamp = rec['timestamp'];
    const reason = rec['reason'];
    if (
      (action === 'freeze' || action === 'unfreeze') &&
      typeof timestamp === 'string' &&
      timestamp.trim().length > 0
    ) {
      valid.push({
        action,
        timestamp,
        reason: typeof reason === 'string' ? reason : null,
      });
    }
  }
  return valid.slice(-MAX_FREEZE_HISTORY_EVENTS);
}

function readExistingFreezeHistory(freezePath: string): FreezeHistoryEvent[] {
  if (!fs.existsSync(freezePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(freezePath, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return [];
    const existing = parseFreezeHistory(parsed['history']);
    if (existing.length > 0) return existing;
    // Synthesize single legacy entry if prior freeze.json had no history array
    if (parsed['frozen'] === true && typeof parsed['frozenAt'] === 'string') {
      return [
        {
          action: 'freeze',
          timestamp: parsed['frozenAt'],
          reason: typeof parsed['reason'] === 'string' ? parsed['reason'] : 'frozen',
        },
      ];
    }
    return [];
  } catch {
    return [];
  }
}

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
    const history = parseFreezeHistory(parsed['history']);
    if (parsed['frozen'] === true) {
      return {
        version: 1,
        frozen: true,
        frozenAt: typeof parsed['frozenAt'] === 'string' ? parsed['frozenAt'] : null,
        unfrozenAt: null,
        reason: typeof parsed['reason'] === 'string' ? parsed['reason'] : 'frozen',
        ...(history.length > 0 ? { history } : {}),
      };
    }
    return {
      version: 1,
      frozen: false,
      frozenAt: null,
      unfrozenAt: typeof parsed['unfrozenAt'] === 'string' ? parsed['unfrozenAt'] : null,
      reason: null,
      ...(history.length > 0 ? { history } : {}),
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
  const tsIso = new Date(nowMs).toISOString();
  const cleanReason =
    typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'emergency-freeze';
  const prevHistory = readExistingFreezeHistory(freezePath);
  const history = [
    ...prevHistory,
    { action: 'freeze' as const, timestamp: tsIso, reason: cleanReason },
  ].slice(-MAX_FREEZE_HISTORY_EVENTS);
  const state: FreezeStateFile = {
    version: 1,
    frozen: true,
    frozenAt: tsIso,
    unfrozenAt: null,
    reason: cleanReason,
    history,
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
  const tsIso = new Date(nowMs).toISOString();
  const prevHistory = readExistingFreezeHistory(freezePath);
  const history = [
    ...prevHistory,
    { action: 'unfreeze' as const, timestamp: tsIso, reason: null },
  ].slice(-MAX_FREEZE_HISTORY_EVENTS);
  const state: FreezeStateFile = {
    version: 1,
    frozen: false,
    frozenAt: null,
    unfrozenAt: tsIso,
    reason: null,
    history,
  };
  atomicWriteFileSync(freezePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}
