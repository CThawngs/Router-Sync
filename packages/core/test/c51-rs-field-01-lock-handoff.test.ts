/**
 * packages/core/test/c51-rs-field-01-lock-handoff.test.ts
 *
 * Ticket RS-FIELD-01 & P2-1 (C51): Unit + multi-process contention tests for
 * cryptographic nonce + CAS + ppid-lineage tick.lock handoff.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STALE_LOCK_MAX_AGE_MS,
  generateTickLockHandoffNonce,
  parseTickLockPayload,
  releaseTickLock,
  tryAcquireTickLock,
  updateTickLockOwner,
} from '../src/index.js';

describe('C51 RS-FIELD-01 & P2-1: tryAcquireTickLock nonce + CAS + lineage handoff', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c51-f01-lock-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects non-reentrant re-entry and blocks holder-PID spoofing without valid nonce while keeping on-disk lock unchanged (kills M2)', () => {
    const nowMs = Date.parse('2026-11-28T10:00:00.000Z');
    const parentPid = 41001;
    const childPid = 41002;
    const realNonce = generateTickLockHandoffNonce();
    const wrongNonce = generateTickLockHandoffNonce();

    const initial = tryAcquireTickLock(tmpDir, parentPid, nowMs, () => true, {
      issueNonce: realNonce,
    });
    expect(initial.acquired).toBe(true);
    const lockPath = path.join(tmpDir, 'tick.lock');
    const rawInitialLock = fs.readFileSync(lockPath, 'utf8');

    // Omitted handoff args: both same-PID and child-PID must be rejected (M2)
    expect(tryAcquireTickLock(tmpDir, parentPid, nowMs + 1_000, () => true).acquired).toBe(false);
    expect(tryAcquireTickLock(tmpDir, childPid, nowMs + 1_000, () => true).acquired).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(rawInitialLock);

    // Invalid handoffParentPid values (0, negative, NaN): rejected
    expect(tryAcquireTickLock(tmpDir, childPid, nowMs + 1_000, () => true, 0).acquired).toBe(false);
    expect(tryAcquireTickLock(tmpDir, childPid, nowMs + 1_000, () => true, -5).acquired).toBe(false);
    expect(
      tryAcquireTickLock(tmpDir, childPid, nowMs + 1_000, () => true, Number.NaN).acquired
    ).toBe(false);

    // QA PoC: Attacker presenting live holder's PID (both pid === holderPid and childPid) with NO nonce -> acquired:false & on-disk unchanged
    const spoofSamePidNoNonce = tryAcquireTickLock(
      tmpDir,
      parentPid,
      nowMs + 1_500,
      () => true,
      parentPid
    );
    expect(spoofSamePidNoNonce.acquired).toBe(false);
    expect(spoofSamePidNoNonce.holderPid).toBe(parentPid);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(rawInitialLock);

    const spoofChildNoNonce = tryAcquireTickLock(
      tmpDir,
      childPid,
      nowMs + 1_500,
      () => true,
      parentPid
    );
    expect(spoofChildNoNonce.acquired).toBe(false);
    expect(spoofChildNoNonce.holderPid).toBe(parentPid);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(rawInitialLock);

    // Wrong or malformed nonces -> acquired:false & on-disk unchanged
    expect(
      tryAcquireTickLock(tmpDir, childPid, nowMs + 1_500, () => true, {
        parentPid,
        nonce: wrongNonce,
        childPpid: parentPid,
      }).acquired
    ).toBe(false);
    expect(
      tryAcquireTickLock(tmpDir, childPid, nowMs + 1_500, () => true, {
        parentPid,
        nonce: 'not-a-valid-hex-nonce',
        childPpid: parentPid,
      }).acquired
    ).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(rawInitialLock);

    // Same-PID self-handoff even WITH valid nonce must be rejected (child PID cannot equal live parent PID)
    expect(
      tryAcquireTickLock(tmpDir, parentPid, nowMs + 1_500, () => true, {
        parentPid,
        nonce: realNonce,
        childPpid: parentPid,
      }).acquired
    ).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(rawInitialLock);

    // Blind updateTickLockOwner without expectedNonce on a nonce-protected lock must fail-close
    expect(updateTickLockOwner(tmpDir, 99999, nowMs + 2_000)).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(rawInitialLock);
  });

  it('adopts active lock via CAS only on matching nonce + valid lineage, consumes single-use nonce, and preserves POSIX reparent + stale recovery (kills M11)', () => {
    const nowMs = Date.parse('2026-11-28T10:00:00.000Z');
    const parentPid = 51001;
    const childPid = 51002;
    const unrelatedPid = 59999;
    const lockPath = path.join(tmpDir, 'tick.lock');

    // Case A: Child reaches tryAcquireTickLock while lock still carries parentPid + nonceA
    const nonceA = generateTickLockHandoffNonce();
    expect(
      tryAcquireTickLock(tmpDir, parentPid, nowMs, () => true, { issueNonce: nonceA }).acquired
    ).toBe(true);

    // Mismatched childPpid while parentPid is alive -> rejected on both win32 and linux
    const rawBeforeLineageCheck = fs.readFileSync(lockPath, 'utf8');
    expect(
      tryAcquireTickLock(tmpDir, childPid, nowMs + 100, () => true, {
        parentPid,
        nonce: nonceA,
        childPpid: 88888,
        platform: 'win32',
      }).acquired
    ).toBe(false);
    expect(
      tryAcquireTickLock(tmpDir, childPid, nowMs + 100, () => true, {
        parentPid,
        nonce: nonceA,
        childPpid: 88888,
        platform: 'linux',
      }).acquired
    ).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(rawBeforeLineageCheck);

    // Matching nonce + matching childPpid -> adopted via CAS and nonce consumed
    const adoptedFromParent = tryAcquireTickLock(tmpDir, childPid, nowMs + 250, () => true, {
      parentPid,
      nonce: nonceA,
      childPpid: parentPid,
    });
    expect(adoptedFromParent).toEqual({
      acquired: true,
      staleRecovered: false,
      holderPid: childPid,
      lockPath,
    });
    const afterAdoptA = parseTickLockPayload(fs.readFileSync(lockPath, 'utf8'));
    expect(afterAdoptA).toEqual({
      pid: childPid,
      startedAt: new Date(nowMs + 250).toISOString(),
    });
    expect(afterAdoptA?.handoffNonce).toBeUndefined();

    // Replay with consumed nonceA must fail
    expect(
      tryAcquireTickLock(tmpDir, childPid + 1, nowMs + 300, () => true, {
        parentPid,
        nonce: nonceA,
        childPpid: parentPid,
      }).acquired
    ).toBe(false);

    // Late parent updateTickLockOwner after child already consumed nonceA must be a safe no-op
    expect(
      updateTickLockOwner(tmpDir, childPid, nowMs + 350, {
        expectedPid: parentPid,
        expectedNonce: nonceA,
        preserveNonce: true,
      })
    ).toBe(false);
    expect(parseTickLockPayload(fs.readFileSync(lockPath, 'utf8'))?.handoffNonce).toBeUndefined();

    releaseTickLock(tmpDir, childPid);

    // Case B: Parent CAS-updates owner to childPid (preserving nonceB), then POSIX-reparented child adopts
    const nonceB = generateTickLockHandoffNonce();
    expect(
      tryAcquireTickLock(tmpDir, parentPid, nowMs + 500, () => true, { issueNonce: nonceB }).acquired
    ).toBe(true);
    expect(
      updateTickLockOwner(tmpDir, childPid, nowMs + 600, {
        expectedPid: parentPid,
        expectedNonce: nonceB,
        preserveNonce: true,
      })
    ).toBe(true);

    // POSIX reparent to PID 1 (init) with valid nonceB -> adopted
    const adoptedPosixInit = tryAcquireTickLock(tmpDir, childPid, nowMs + 750, () => true, {
      parentPid,
      nonce: nonceB,
      childPpid: 1,
      platform: 'linux',
    });
    expect(adoptedPosixInit.acquired).toBe(true);
    expect(adoptedPosixInit.holderPid).toBe(childPid);
    releaseTickLock(tmpDir, childPid);

    // POSIX reparent to subreaper (ppid=1842) after detached parent exited -> adopted
    const nonceSubreaper = generateTickLockHandoffNonce();
    expect(
      tryAcquireTickLock(tmpDir, parentPid, nowMs + 800, () => true, {
        issueNonce: nonceSubreaper,
      }).acquired
    ).toBe(true);
    expect(
      updateTickLockOwner(tmpDir, childPid, nowMs + 850, {
        expectedPid: parentPid,
        expectedNonce: nonceSubreaper,
        preserveNonce: true,
      })
    ).toBe(true);
    const adoptedPosixSubreaper = tryAcquireTickLock(
      tmpDir,
      childPid,
      nowMs + 900,
      (candidatePid) => candidatePid === childPid, // parentPid exited, childPid alive
      {
        parentPid,
        nonce: nonceSubreaper,
        childPpid: 1842,
        platform: 'linux',
      }
    );
    expect(adoptedPosixSubreaper.acquired).toBe(true);

    // Case C: Lock held by unrelated live third process -> child must NOT steal it (kills M11)
    expect(updateTickLockOwner(tmpDir, unrelatedPid, nowMs + 1_000)).toBe(true);
    const rawThirdParty = fs.readFileSync(lockPath, 'utf8');
    const blockedByThirdParty = tryAcquireTickLock(tmpDir, childPid, nowMs + 1_200, () => true, {
      parentPid,
      nonce: nonceSubreaper,
      childPpid: parentPid,
    });
    expect(blockedByThirdParty.acquired).toBe(false);
    expect(blockedByThirdParty.holderPid).toBe(unrelatedPid);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(rawThirdParty);

    // Case D: Stale lock (> STALE_LOCK_MAX_AGE_MS) still recovers with staleRecovered: true
    const staleRecovered = tryAcquireTickLock(
      tmpDir,
      childPid,
      nowMs + 1_000 + STALE_LOCK_MAX_AGE_MS + 5_000,
      () => true
    );
    expect(staleRecovered.acquired).toBe(true);
    expect(staleRecovered.staleRecovered).toBe(true);
    expect(staleRecovered.holderPid).toBe(childPid);

    releaseTickLock(tmpDir, childPid);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('ensures two concurrent child processes handing off with the same nonce produce exactly one winner', async () => {
    const nowMs = Date.now();
    const sharedNonce = generateTickLockHandoffNonce();
    const parentLock = tryAcquireTickLock(tmpDir, process.pid, nowMs, undefined, {
      issueNonce: sharedNonce,
    });
    expect(parentLock.acquired).toBe(true);

    // Build path to compiled core dist (or run after core build; fallback to src via tsx/dist)
    const distEntry = path.resolve(__dirname, '../dist/index.js');
    expect(fs.existsSync(distEntry)).toBe(true);
    const distUrl = pathToFileURL(distEntry).href;

    const startGateFile = path.join(tmpDir, 'start.gate');
    const childScript = `
      import * as fs from 'node:fs';
      import { tryAcquireTickLock } from ${JSON.stringify(distUrl)};
      const [stateDir, gateFile, parentPidStr, nonce] = process.argv.slice(1);
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(gateFile) && Date.now() < deadline) {}
      const res = tryAcquireTickLock(stateDir, process.pid, Date.now(), undefined, {
        parentPid: Number(parentPidStr),
        nonce,
        childPpid: process.ppid,
      });
      process.stdout.write(JSON.stringify({ pid: process.pid, ...res }) + '\\n');
      setTimeout(() => process.exit(0), 250);
    `;

    const spawnContender = () =>
      new Promise<{ pid: number; acquired: boolean; holderPid: number }>((resolve, reject) => {
        const proc = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            childScript,
            tmpDir,
            startGateFile,
            String(process.pid),
            sharedNonce,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
        );
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        proc.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Contender exited with ${code}: ${stderr}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch (err) {
            reject(new Error(`Invalid contender output "${stdout}" / "${stderr}": ${String(err)}`));
          }
        });
      });

    const p1 = spawnContender();
    const p2 = spawnContender();
    // Release both contenders simultaneously once spawned
    await new Promise((r) => setTimeout(r, 120));
    fs.writeFileSync(startGateFile, 'go\n', 'utf8');

    const [r1, r2] = await Promise.all([p1, p2]);
    const winners = [r1, r2].filter((r) => r.acquired);
    const losers = [r1, r2].filter((r) => !r.acquired);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.holderPid).toBe(winners[0]!.pid);

    const onDisk = parseTickLockPayload(fs.readFileSync(path.join(tmpDir, 'tick.lock'), 'utf8'));
    expect(onDisk?.pid).toBe(winners[0]!.pid);
    expect(onDisk?.handoffNonce).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, 'tick.lock.cas'))).toBe(false);
  }, 15_000);
});
