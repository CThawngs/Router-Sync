/**
 * packages/daemon/src/single-instance.ts
 *
 * Single-instance lock for the daemon: PID-file + stale check, plus cross-tier
 * `<stateDir>/tick.lock` mutual exclusion compatible with CLI `tick` and MCP `tick_if_due`.
 * Pure fs/path/process only (AT-118 read-only isolation: zero root @routersync/core imports).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function resolveTickLockPath(stateDir: string): string {
  return path.join(stateDir, 'tick.lock');
}

export interface LockContent {
  pid: number;
  startedAt: string;
}

export interface AcquireLockResult {
  acquired: boolean;
  stale: boolean;
  pid: number;
}

export interface TickLockAcquireResult {
  acquired: boolean;
  lockPath: string;
  pid: number;
  staleReplaced: boolean;
  holderPid?: number | undefined;
}

export function parseLockContent(raw: string): LockContent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockContent>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return { pid: parsed.pid, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '' };
  } catch {
    return null;
  }
}

/**
 * True if `pid` points to a live same-user process on this host.
 * `EPERM` (e.g. Linux `pid: 2` `[kthreadd]` owned by root) indicates a foreign-UID
 * process rather than a user-space RouterSync daemon owning `<stateDir>`.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tryAcquireTickLock(
  stateDir: string,
  pid: number = process.pid,
  nowMs: number = Date.now()
): TickLockAcquireResult {
  const lockPath = resolveTickLockPath(stateDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({ pid, startedAt: new Date(nowMs).toISOString() }) + "\n";
  let staleReplaced = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, payload, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { acquired: true, lockPath, pid, staleReplaced };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      let existing: LockContent | null = null;
      try {
        existing = parseLockContent(fs.readFileSync(lockPath, 'utf8'));
      } catch {
        existing = null;
      }
      if (existing && existing.pid === pid) {
        fs.writeFileSync(lockPath, payload, 'utf8');
        return { acquired: true, lockPath, pid, staleReplaced: true };
      }
      if (existing && isPidAlive(existing.pid)) {
        return { acquired: false, lockPath, pid, staleReplaced: false, holderPid: existing.pid };
      }
      try {
        fs.unlinkSync(lockPath);
        staleReplaced = true;
      } catch {
        // raced unlink
      }
    }
  }
  return { acquired: false, lockPath, pid, staleReplaced };
}

export function releaseTickLock(stateDir: string, pid: number = process.pid): void {
  releaseLock(resolveTickLockPath(stateDir), pid);
}

export function acquireLock(lockPath: string, pid: number = process.pid): AcquireLockResult {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const content: LockContent = { pid, startedAt: new Date().toISOString() };
  if (!fs.existsSync(lockPath)) {
    fs.writeFileSync(lockPath, JSON.stringify(content) + '\n', 'utf8');
    return { acquired: true, stale: false, pid };
  }
  const existing = parseLockContent(fs.readFileSync(lockPath, 'utf8'));
  if (existing && isPidAlive(existing.pid) && existing.pid !== pid) {
    return { acquired: false, stale: false, pid: existing.pid };
  }
  // Stale: owner dead, same pid re-entering, or malformed content.
  fs.writeFileSync(lockPath, JSON.stringify(content) + '\n', 'utf8');
  return { acquired: true, stale: true, pid };
}

export function releaseLock(lockPath: string, pid: number = process.pid): void {
  try {
    const existing = parseLockContent(fs.readFileSync(lockPath, 'utf8'));
    if (existing && existing.pid === pid) fs.unlinkSync(lockPath);
  } catch {
    // lock already gone
  }
}
