/**
 * packages/daemon/src/single-instance.ts
 *
 * Single-instance lock for the daemon: PID-file + stale check.
 * Pure fs only, no OS scheduling, no side effects beyond the lock file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LockContent {
  pid: number;
  startedAt: string;
}

export interface AcquireLockResult {
  acquired: boolean;
  stale: boolean;
  pid: number;
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

/** True if pid points to a live process on this host. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
