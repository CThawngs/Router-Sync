/**
 * packages/core/src/schedule/tick-gate.ts
 *
 * C45-WP7 (`Phục vụ: S6, S7`): Shared zero-dependency 15-minute freshness gate
 * and exclusive single-instance `<stateDir>/tick.lock` primitive.
 *
 * Used across `@routersync/mcp-server` (`tick_if_due`), `@routersync/cli` (`tick`),
 * and `@routersync/daemon` (`scheduler`) so Tier 2, Tier 3, and Tier 4 never
 * double-execute concurrently on the same `stateDir`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_TICK_GATE_MS = 15 * 60 * 1000;
export const STALE_LOCK_MAX_AGE_MS = 10 * 60 * 1000;

export type TickFreshnessReason = 'missing_status' | 'stale_status' | 'fresh';

export interface TickFreshnessResult {
  due: boolean;
  reason: TickFreshnessReason;
  lastTickAt: string | null;
  ageMs: number | null;
}

export interface TickLockPayload {
  pid: number;
  startedAt: string;
}

export interface TickLockAcquireResult {
  acquired: boolean;
  staleRecovered: boolean;
  holderPid: number;
  lockPath: string;
}

/**
 * Checks whether `pid` refers to a currently running same-user RouterSync OS process.
 *
 * `tick.lock` / `daemon.lock` live in the current user's own `<stateDir>`. Any live
 * process owned by the current user (`process.pid` or spawned child/sibling) succeeds
 * on `process.kill(pid, 0)`. `ESRCH` means dead PID; `EPERM` means the PID belongs to
 * a different UID / OS kernel thread (e.g. Linux `pid: 2` `[kthreadd]`) after PID reuse,
 * never our user-space RouterSync instance.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseTickLockPayload(raw: string): TickLockPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TickLockPayload>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    if (typeof parsed.startedAt !== 'string' || parsed.startedAt.trim().length === 0) {
      return null;
    }
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

/**
 * Strictly read-only evaluation of `<stateDir>/status.json`.
 * Never creates `stateDir` or mutates any file on disk.
 */
export function evaluateTickFreshness(
  stateDir: string,
  nowMs: number = Date.now(),
  gateMs: number = DEFAULT_TICK_GATE_MS
): TickFreshnessResult {
  const statusPath = path.join(stateDir, 'status.json');
  let raw: string;
  try {
    if (!fs.existsSync(statusPath)) {
      return { due: true, reason: 'missing_status', lastTickAt: null, ageMs: null };
    }
    raw = fs.readFileSync(statusPath, 'utf8');
  } catch {
    return { due: true, reason: 'missing_status', lastTickAt: null, ageMs: null };
  }

  let timestampStr: string | null = null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidate = parsed['timestamp'] ?? parsed['generatedAt'];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      timestampStr = candidate.trim();
    }
  } catch {
    return { due: true, reason: 'missing_status', lastTickAt: null, ageMs: null };
  }

  if (!timestampStr) {
    return { due: true, reason: 'missing_status', lastTickAt: null, ageMs: null };
  }

  const parsedMs = Date.parse(timestampStr);
  if (!Number.isFinite(parsedMs)) {
    return { due: true, reason: 'missing_status', lastTickAt: null, ageMs: null };
  }

  const ageMs = Math.max(0, nowMs - parsedMs);
  if (ageMs >= gateMs) {
    return {
      due: true,
      reason: 'stale_status',
      lastTickAt: timestampStr,
      ageMs,
    };
  }

  return {
    due: false,
    reason: 'fresh',
    lastTickAt: timestampStr,
    ageMs,
  };
}

function writeExclusiveLockFile(lockPath: string, payload: TickLockPayload): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify(payload) + '\n', 'utf8');
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EEXIST') {
      return false;
    }
    throw err;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

/**
 * Acquires `<stateDir>/tick.lock` atomically via `wx` exclusive open.
 *
 * Non-reentrant by design when `handoffParentPid` is omitted: if an active
 * non-stale lock is already held (even by `process.pid`), returns
 * `{ acquired: false, holderPid }` so concurrent async triggers inside the
 * same process cannot spawn duplicate ticks.
 *
 * When `handoffParentPid` is a positive integer (passed from `tick_if_due`
 * to its detached `tick --mode observe` child), an alive non-stale lock held
 * by either `pid` or `handoffParentPid` is atomically adopted by `pid`.
 */
export function tryAcquireTickLock(
  stateDir: string,
  pid: number = process.pid,
  nowMs: number = Date.now(),
  isAliveFn: (candidatePid: number) => boolean = isProcessAlive,
  handoffParentPid?: number
): TickLockAcquireResult {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, 'tick.lock');
  const payload: TickLockPayload = {
    pid,
    startedAt: new Date(nowMs).toISOString(),
  };

  if (writeExclusiveLockFile(lockPath, payload)) {
    return { acquired: true, staleRecovered: false, holderPid: pid, lockPath };
  }

  const validHandoffParentPid =
    typeof handoffParentPid === 'number' &&
    Number.isInteger(handoffParentPid) &&
    handoffParentPid > 0
      ? handoffParentPid
      : undefined;

  let existing: TickLockPayload | null = null;
  try {
    existing = parseTickLockPayload(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    existing = null;
  }

  if (existing) {
    const startedMs = Date.parse(existing.startedAt);
    const lockAgeMs = Number.isFinite(startedMs) ? nowMs - startedMs : Number.POSITIVE_INFINITY;
    const holderAlive = isAliveFn(existing.pid);
    if (holderAlive && lockAgeMs <= STALE_LOCK_MAX_AGE_MS) {
      if (
        validHandoffParentPid !== undefined &&
        (existing.pid === pid || existing.pid === validHandoffParentPid)
      ) {
        updateTickLockOwner(stateDir, pid, nowMs);
        return {
          acquired: true,
          staleRecovered: false,
          holderPid: pid,
          lockPath,
        };
      }
      return {
        acquired: false,
        staleRecovered: false,
        holderPid: existing.pid,
        lockPath,
      };
    }
  }

  // Stale lock (dead PID, corrupt payload, or > STALE_LOCK_MAX_AGE_MS): unlink and retry wx once.
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Another contender may have already unlinked it.
  }

  if (writeExclusiveLockFile(lockPath, payload)) {
    return { acquired: true, staleRecovered: true, holderPid: pid, lockPath };
  }

  let currentHolder = 0;
  try {
    const reread = parseTickLockPayload(fs.readFileSync(lockPath, 'utf8'));
    currentHolder = reread?.pid ?? 0;
  } catch {
    currentHolder = 0;
  }
  return {
    acquired: false,
    staleRecovered: false,
    holderPid: currentHolder,
    lockPath,
  };
}

/**
 * Updates `<stateDir>/tick.lock` with the spawned child's PID when `tick_if_due`
 * hands ownership of the lock to a detached `tick --mode observe` child process.
 */
export function updateTickLockOwner(
  stateDir: string,
  childPid: number,
  nowMs: number = Date.now()
): void {
  const lockPath = path.join(stateDir, 'tick.lock');
  const payload: TickLockPayload = {
    pid: childPid,
    startedAt: new Date(nowMs).toISOString(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(payload) + '\n', 'utf8');
}

/**
 * Releases `<stateDir>/tick.lock` if owned by `pid` (or unconditionally if `pid` omitted).
 */
export function releaseTickLock(stateDir: string, pid?: number): void {
  const lockPath = path.join(stateDir, 'tick.lock');
  try {
    if (!fs.existsSync(lockPath)) return;
    if (pid !== undefined) {
      const existing = parseTickLockPayload(fs.readFileSync(lockPath, 'utf8'));
      if (existing && existing.pid !== pid) {
        return;
      }
    }
    fs.unlinkSync(lockPath);
  } catch {
    // Lock already removed
  }
}
