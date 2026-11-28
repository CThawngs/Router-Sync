/**
 * packages/core/test/c51-rs-field-01-lock-handoff.test.ts
 *
 * Ticket RS-FIELD-01 (C51): Red-First unit tests for parent-to-child tick.lock handoff
 * while preserving strict in-process non-reentrancy when handoffParentPid is omitted.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STALE_LOCK_MAX_AGE_MS,
  releaseTickLock,
  tryAcquireTickLock,
  updateTickLockOwner,
} from '../src/index.js';

describe('C51 RS-FIELD-01: tryAcquireTickLock parent-to-child handoff & non-reentrancy', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c51-f01-lock-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves strict non-reentrancy when handoffParentPid is omitted or non-positive', () => {
    const nowMs = Date.parse('2026-11-28T10:00:00.000Z');
    const parentPid = 41001;
    const childPid = 41002;

    const initial = tryAcquireTickLock(tmpDir, parentPid, nowMs, () => true);
    expect(initial.acquired).toBe(true);

    // Omitted 5th arg: both same-PID and child-PID must be rejected
    expect(tryAcquireTickLock(tmpDir, parentPid, nowMs + 1_000, () => true).acquired).toBe(false);
    expect(tryAcquireTickLock(tmpDir, childPid, nowMs + 1_000, () => true).acquired).toBe(false);

    // Invalid handoffParentPid values (0, negative, NaN): must still reject
    expect(tryAcquireTickLock(tmpDir, childPid, nowMs + 1_000, () => true, 0).acquired).toBe(false);
    expect(tryAcquireTickLock(tmpDir, childPid, nowMs + 1_000, () => true, -5).acquired).toBe(false);
    expect(tryAcquireTickLock(tmpDir, childPid, nowMs + 1_000, () => true, Number.NaN).acquired).toBe(false);
  });

  it('adopts active non-stale lock when existing.pid matches child pid or handoffParentPid, and rejects third-party pid', () => {
    const nowMs = Date.parse('2026-11-28T10:00:00.000Z');
    const parentPid = 51001;
    const childPid = 51002;
    const unrelatedPid = 59999;

    // Case A: Child reaches tryAcquireTickLock while lock still carries parentPid (pre-updateTickLockOwner race)
    const parentLock = tryAcquireTickLock(tmpDir, parentPid, nowMs, () => true);
    expect(parentLock.acquired).toBe(true);

    const adoptedFromParent = tryAcquireTickLock(
      tmpDir,
      childPid,
      nowMs + 250,
      () => true,
      parentPid
    );
    expect(adoptedFromParent).toEqual({
      acquired: true,
      staleRecovered: false,
      holderPid: childPid,
      lockPath: path.join(tmpDir, 'tick.lock'),
    });
    const onDiskAfterParentHandoff = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'tick.lock'), 'utf8')
    ) as { pid: number; startedAt: string };
    expect(onDiskAfterParentHandoff.pid).toBe(childPid);

    // Case B: Parent already called updateTickLockOwner(stateDir, childPid) before child checked
    updateTickLockOwner(tmpDir, childPid, nowMs + 500);
    const adoptedFromPreUpdatedChild = tryAcquireTickLock(
      tmpDir,
      childPid,
      nowMs + 750,
      () => true,
      parentPid
    );
    expect(adoptedFromPreUpdatedChild).toEqual({
      acquired: true,
      staleRecovered: false,
      holderPid: childPid,
      lockPath: path.join(tmpDir, 'tick.lock'),
    });

    // Case C: Lock is held by an unrelated third live process -> child must NOT steal it
    updateTickLockOwner(tmpDir, unrelatedPid, nowMs + 1_000);
    const blockedByThirdParty = tryAcquireTickLock(
      tmpDir,
      childPid,
      nowMs + 1_200,
      () => true,
      parentPid
    );
    expect(blockedByThirdParty.acquired).toBe(false);
    expect(blockedByThirdParty.holderPid).toBe(unrelatedPid);

    // Case D: Stale lock (> STALE_LOCK_MAX_AGE_MS) still recovers with staleRecovered: true
    const staleRecovered = tryAcquireTickLock(
      tmpDir,
      childPid,
      nowMs + 1_000 + STALE_LOCK_MAX_AGE_MS + 5_000,
      () => true,
      parentPid
    );
    expect(staleRecovered.acquired).toBe(true);
    expect(staleRecovered.staleRecovered).toBe(true);
    expect(staleRecovered.holderPid).toBe(childPid);

    releaseTickLock(tmpDir, childPid);
    expect(fs.existsSync(path.join(tmpDir, 'tick.lock'))).toBe(false);
  });
});
