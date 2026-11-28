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

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../paths/atomic.js';

export const DEFAULT_TICK_GATE_MS = 15 * 60 * 1000;
export const STALE_LOCK_MAX_AGE_MS = 10 * 60 * 1000;
export const LOCK_HANDOFF_PARENT_PID_ENV = 'ROUTERSYNC_LOCK_HANDOFF_PARENT_PID';
export const LOCK_HANDOFF_NONCE_ENV = 'ROUTERSYNC_LOCK_HANDOFF_NONCE';

const HANDOFF_NONCE_PATTERN = /^[0-9a-f]{32,128}$/;
const CAS_LOCK_STALE_MS = 5_000;
const CAS_LOCK_ACQUIRE_TIMEOUT_MS = 1_500;
const CAS_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

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
  handoffNonce?: string | undefined;
}

export interface TickLockAcquireResult {
  acquired: boolean;
  staleRecovered: boolean;
  holderPid: number;
  lockPath: string;
}

export interface TickLockHandoffOptions {
  /**
   * Cryptographic nonce issued by the parent (`runTickIfDue`) when acquiring
   * `<stateDir>/tick.lock` prior to spawning a detached child.
   */
  issueNonce?: string | undefined;
  /**
   * Expected parent PID passed to the child via `ROUTERSYNC_LOCK_HANDOFF_PARENT_PID`.
   */
  parentPid?: number | undefined;
  /**
   * Secret handoff nonce passed to the child via `ROUTERSYNC_LOCK_HANDOFF_NONCE`.
   * Child adoption succeeds ONLY when this matches the on-disk `handoffNonce`.
   */
  nonce?: string | undefined;
  /**
   * Observed parent PID of the child (`process.ppid` by default when `pid === process.pid`).
   * Verified against `parentPid` with POSIX reparent fallback.
   */
  childPpid?: number | undefined;
  /**
   * Optional platform override for deterministic cross-platform unit tests.
   */
  platform?: NodeJS.Platform | undefined;
}

export interface TickLockCasExpectation {
  expectedPids?: readonly number[] | undefined;
  expectedNonce?: string | undefined;
  requireNoNonce?: boolean | undefined;
}

export interface UpdateTickLockOwnerOptions {
  expectedPid?: number | undefined;
  expectedNonce?: string | undefined;
  preserveNonce?: boolean | undefined;
}

export function generateTickLockHandoffNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function isValidHandoffNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && HANDOFF_NONCE_PATTERN.test(nonce);
}

function noncesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!isValidHandoffNonce(a) || !isValidHandoffNonce(b)) {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(CAS_WAIT_BUFFER, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Fallback spin if Atomics.wait is ever unavailable in a custom runtime
    }
  }
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
    const handoffNonce = isValidHandoffNonce(parsed.handoffNonce)
      ? parsed.handoffNonce
      : undefined;
    return handoffNonce !== undefined
      ? { pid: parsed.pid, startedAt: parsed.startedAt, handoffNonce }
      : { pid: parsed.pid, startedAt: parsed.startedAt };
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

function withTickLockCasGuard<T>(stateDir: string, fn: () => T, fallback: T): T {
  const casPath = path.join(stateDir, 'tick.lock.cas');
  const deadline = Date.now() + CAS_LOCK_ACQUIRE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(casPath, 'wx');
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n',
        'utf8'
      );
      fs.closeSync(fd);
      fd = null;
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close error
        }
      }
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EEXIST') {
        throw err;
      }
      try {
        const rawCas = fs.readFileSync(casPath, 'utf8');
        const parsedCas = parseTickLockPayload(rawCas);
        const casStartedMs = parsedCas ? Date.parse(parsedCas.startedAt) : Number.NaN;
        const casAged =
          !Number.isFinite(casStartedMs) || Date.now() - casStartedMs > CAS_LOCK_STALE_MS;
        if (!parsedCas || !isProcessAlive(parsedCas.pid) || casAged) {
          fs.unlinkSync(casPath);
          continue;
        }
      } catch {
        // Contender already released or replaced casPath
      }
      sleepSyncMs(2);
      continue;
    }

    try {
      return fn();
    } finally {
      try {
        fs.unlinkSync(casPath);
      } catch {
        // ignore unlink error
      }
    }
  }

  return fallback;
}

/**
 * Atomically verifies the on-disk `<stateDir>/tick.lock` payload under an
 * exclusive `wx` CAS mutex (`tick.lock.cas`) and swaps in `nextPayload` via
 * temp-file + fsync + rename only if all expectations match.
 *
 * Fail-closed: if the lock disappeared, changed owner, or lost/mismatched its
 * single-use `handoffNonce`, returns `false` and leaves `<stateDir>/tick.lock`
 * untouched on disk.
 */
export function compareAndSwapTickLock(
  stateDir: string,
  expectation: TickLockCasExpectation,
  nextPayload: TickLockPayload
): boolean {
  const lockPath = path.join(stateDir, 'tick.lock');
  try {
    return withTickLockCasGuard(
      stateDir,
      () => {
        if (!fs.existsSync(lockPath)) {
          return false;
        }
        const current = parseTickLockPayload(fs.readFileSync(lockPath, 'utf8'));
        if (!current) {
          return false;
        }
        if (
          expectation.expectedPids !== undefined &&
          !expectation.expectedPids.includes(current.pid)
        ) {
          return false;
        }
        if (expectation.expectedNonce !== undefined) {
          if (!noncesMatch(current.handoffNonce, expectation.expectedNonce)) {
            return false;
          }
        } else if (expectation.requireNoNonce && current.handoffNonce !== undefined) {
          return false;
        }
        atomicWriteFileSync(lockPath, JSON.stringify(nextPayload) + '\n');
        return true;
      },
      false
    );
  } catch {
    return false;
  }
}

function isHandoffLineageValid(
  handoffParentPid: number,
  childPpid: number | undefined,
  platform: NodeJS.Platform,
  isAliveFn: (candidatePid: number) => boolean
): boolean {
  if (childPpid === undefined) {
    return true;
  }
  if (childPpid === handoffParentPid) {
    return true;
  }
  // POSIX reparent fallback: when a detached parent exits before its child reaches
  // tryAcquireTickLock, POSIX reparents the orphan to PID 1 (init) or a subreaper
  // while handoffParentPid is no longer alive.
  if (platform !== 'win32' && (childPpid === 1 || !isAliveFn(handoffParentPid))) {
    return true;
  }
  return false;
}

/**
 * Acquires `<stateDir>/tick.lock` atomically via `wx` exclusive open.
 *
 * Non-reentrant by design when handoff credentials are omitted: if an active
 * non-stale lock is already held (even by `process.pid`), returns
 * `{ acquired: false, holderPid }` so concurrent async triggers inside the
 * same process cannot spawn duplicate ticks.
 *
 * Detached parent-to-child handoff (`tick_if_due` -> `tick --mode observe`)
 * succeeds ONLY when:
 *  1. The parent issued a cryptographic `handoffNonce` into `<stateDir>/tick.lock`,
 *  2. The child presents the matching `nonce` and `parentPid` (`pid !== parentPid`),
 *  3. Child parent-lineage (`process.ppid === handoffParentPid`, with POSIX reparent
 *     fallback when the detached parent already exited) is verified, and
 *  4. Atomic `compareAndSwapTickLock` consumes `handoffNonce` so at most one
 *     child contender can win.
 */
export function tryAcquireTickLock(
  stateDir: string,
  pid: number = process.pid,
  nowMs: number = Date.now(),
  isAliveFn: (candidatePid: number) => boolean = isProcessAlive,
  handoff?: number | TickLockHandoffOptions,
  handoffNonceArg?: string
): TickLockAcquireResult {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, 'tick.lock');

  const handoffOpts: TickLockHandoffOptions =
    typeof handoff === 'number'
      ? { parentPid: handoff, nonce: handoffNonceArg }
      : {
          ...(handoff ?? {}),
          ...(handoffNonceArg !== undefined ? { nonce: handoffNonceArg } : {}),
        };

  const issueNonce = isValidHandoffNonce(handoffOpts.issueNonce)
    ? handoffOpts.issueNonce
    : undefined;

  const validHandoffParentPid =
    typeof handoffOpts.parentPid === 'number' &&
    Number.isSafeInteger(handoffOpts.parentPid) &&
    handoffOpts.parentPid > 0
      ? handoffOpts.parentPid
      : undefined;

  const validHandoffNonce = isValidHandoffNonce(handoffOpts.nonce)
    ? handoffOpts.nonce
    : undefined;

  const effectivePlatform = handoffOpts.platform ?? process.platform;
  const effectiveChildPpid =
    typeof handoffOpts.childPpid === 'number' &&
    Number.isSafeInteger(handoffOpts.childPpid) &&
    handoffOpts.childPpid >= 0
      ? handoffOpts.childPpid
      : pid === process.pid
        ? process.ppid
        : undefined;

  const payload: TickLockPayload =
    issueNonce !== undefined
      ? {
          pid,
          startedAt: new Date(nowMs).toISOString(),
          handoffNonce: issueNonce,
        }
      : {
          pid,
          startedAt: new Date(nowMs).toISOString(),
        };

  if (writeExclusiveLockFile(lockPath, payload)) {
    return { acquired: true, staleRecovered: false, holderPid: pid, lockPath };
  }

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
        validHandoffNonce !== undefined &&
        pid !== validHandoffParentPid &&
        (existing.pid === validHandoffParentPid || existing.pid === pid) &&
        noncesMatch(existing.handoffNonce, validHandoffNonce) &&
        isHandoffLineageValid(
          validHandoffParentPid,
          effectiveChildPpid,
          effectivePlatform,
          isAliveFn
        )
      ) {
        const adopted = compareAndSwapTickLock(
          stateDir,
          {
            expectedPids: [validHandoffParentPid, pid],
            expectedNonce: validHandoffNonce,
          },
          {
            pid,
            startedAt: new Date(nowMs).toISOString(),
          }
        );
        if (adopted) {
          return {
            acquired: true,
            staleRecovered: false,
            holderPid: pid,
            lockPath,
          };
        }
        let winnerPid = existing.pid;
        try {
          const reread = parseTickLockPayload(fs.readFileSync(lockPath, 'utf8'));
          if (reread) {
            winnerPid = reread.pid;
          }
        } catch {
          // ignore read error
        }
        return {
          acquired: false,
          staleRecovered: false,
          holderPid: winnerPid,
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
 * Atomically updates `<stateDir>/tick.lock` with the spawned child's PID via
 * compare-and-swap (`compareAndSwapTickLock`). Never performs a blind overwrite,
 * never resurrects an unlinked lock, and refuses to overwrite a nonce-protected
 * lock unless the matching `expectedNonce` is supplied.
 */
export function updateTickLockOwner(
  stateDir: string,
  childPid: number,
  nowMs: number = Date.now(),
  options?: UpdateTickLockOwnerOptions
): boolean {
  if (!Number.isInteger(childPid) || childPid <= 0) {
    return false;
  }
  const validExpectedPid =
    options?.expectedPid !== undefined &&
    Number.isInteger(options.expectedPid) &&
    options.expectedPid > 0
      ? options.expectedPid
      : undefined;
  if (options?.expectedPid !== undefined && validExpectedPid === undefined) {
    return false;
  }
  if (options?.expectedNonce !== undefined && !isValidHandoffNonce(options.expectedNonce)) {
    return false;
  }
  const nextPayload: TickLockPayload =
    options?.preserveNonce && isValidHandoffNonce(options.expectedNonce)
      ? {
          pid: childPid,
          startedAt: new Date(nowMs).toISOString(),
          handoffNonce: options.expectedNonce,
        }
      : {
          pid: childPid,
          startedAt: new Date(nowMs).toISOString(),
        };

  return compareAndSwapTickLock(
    stateDir,
    {
      expectedPids: validExpectedPid !== undefined ? [validExpectedPid] : undefined,
      expectedNonce: options?.expectedNonce,
      requireNoNonce: options?.expectedNonce === undefined,
    },
    nextPayload
  );
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
