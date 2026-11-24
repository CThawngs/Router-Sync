/**
 * packages/core/test/standing-consent.test.ts
 *
 * C45-WP4 Red-First Unit & Security Suite for Shared Consent, Freeze,
 * Apply-History Promotion Gate, Sandbox Guard, and Persistent Approval Tokens
 * (Phục vụ: S3, S4, S9).
 *
 * Hermetic isolation: 100% inside os.tmpdir(), zero live router ports, zero homedir writes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CONSENT_TTL_DAYS,
  ConsentValidationError,
  parseTargetScope,
  readStandingConsent,
  upsertStandingConsentTarget,
  revokeStandingConsentTarget,
  authorizeTargetWrite,
  getConsentedRouterCombos,
  readApplyHistory,
  appendApplyReceipt,
  assertEligibleForAutoSafe,
  readFreezeState,
  activateFreeze,
  deactivateFreeze,
  issuePersistentApprovalToken,
  verifyAndConsumePersistentApprovalToken,
  assertControlledWriteSandbox,
} from '../src/index.js';

function createDirLinkOrJunction(targetDir: string, linkPath: string): void {
  if (process.platform === 'win32') {
    try {
      fs.symlinkSync(targetDir, linkPath, 'dir');
    } catch {
      fs.symlinkSync(targetDir, linkPath, 'junction');
    }
  } else {
    fs.symlinkSync(targetDir, linkPath, 'dir');
  }
}

describe('C45-WP4 Standing Consent, Promotion Gate, Freeze & Persistent Approval Tokens', () => {
  let tmpDirs: string[] = [];

  function makeTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    tmpDirs = [];
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('Target Scope Grammar & Default Empty Policy', () => {
    it('returns empty policy [] without creating any files when standing-consent.json is absent', () => {
      const stateDir = makeTmpDir('rs-wp4-consent-empty-');
      const beforeEntries = fs.readdirSync(stateDir);

      const consent = readStandingConsent(stateDir);
      expect(consent.present).toBe(false);
      expect(consent.valid).toBe(true);
      expect(consent.targets).toEqual([]);
      expect(consent.activeTargets).toEqual([]);
      expect(Array.from(getConsentedRouterCombos(stateDir))).toEqual([]);

      // Zero files or signing keys created during read-only inspection (M7 guard)
      expect(fs.readdirSync(stateDir)).toEqual(beforeEntries);
    });

    it('accepts canonical router:<id>/<combo> and verified Tier-A write-adapter harnesses', () => {
      expect(parseTargetScope('router:nine/coding-primary')).toEqual({
        target: 'router:nine/coding-primary',
        targetKind: 'router',
        routerId: 'nine',
        comboName: 'coding-primary',
      });

      for (const h of ['hermes', 'openmausbot', 'opencode', 'dsh']) {
        expect(parseTargetScope(`harness:${h}`)).toEqual({
          target: `harness:${h}`,
          targetKind: 'harness',
          harnessId: h,
        });
      }
    });

    it('rejects wildcards and report-only/unknown harnesses with typed ConsentValidationError', () => {
      for (const wildcard of ['*', 'router:*', 'router:nine/*', 'harness:*']) {
        expect(() => parseTargetScope(wildcard)).toThrowError(ConsentValidationError);
        try {
          parseTargetScope(wildcard);
        } catch (err) {
          expect((err as ConsentValidationError).code).toBe('WILDCARD_TARGET_FORBIDDEN');
        }
      }

      for (const reportOnly of ['cursor', 'codex', 'claude-code', 'antigravity', 'grok-bot', 'unknown-app']) {
        expect(() => parseTargetScope(`harness:${reportOnly}`)).toThrowError(ConsentValidationError);
        try {
          parseTargetScope(`harness:${reportOnly}`);
        } catch (err) {
          expect((err as ConsentValidationError).code).toBe('TARGET_NOT_WRITABLE');
        }
      }
    });
  });

  describe('30-Day TTL, Expiry, and Constant-Time HMAC Integrity (M4 Guard)', () => {
    it('grants propose consent with default 30d TTL, enforces expiry, and detects hand-edited HMAC tampering', () => {
      const stateDir = makeTmpDir('rs-wp4-consent-hmac-');
      const baseNowMs = Date.parse('2026-11-24T00:00:00.000Z');

      const entry = upsertStandingConsentTarget(stateDir, {
        target: 'router:nine/coding-main',
        level: 'propose',
        nowMs: baseNowMs,
      });

      expect(entry.level).toBe('propose');
      const expectedExpiryMs = baseNowMs + DEFAULT_CONSENT_TTL_DAYS * 24 * 3600 * 1000;
      expect(Date.parse(entry.expiresAt)).toBe(expectedExpiryMs);

      // Valid before expiry
      const validRead = readStandingConsent(stateDir, baseNowMs + 1000);
      expect(validRead.valid).toBe(true);
      expect(validRead.activeTargets).toHaveLength(1);
      expect(authorizeTargetWrite(stateDir, 'router:nine/coding-main', baseNowMs + 1000).authorized).toBe(true);

      // Expired at or after expiresAt -> excluded from activeTargets & rejected with CONSENT_EXPIRED
      const expiredRead = readStandingConsent(stateDir, expectedExpiryMs);
      expect(expiredRead.valid).toBe(true);
      expect(expiredRead.activeTargets).toHaveLength(0);
      const expiredAuth = authorizeTargetWrite(stateDir, 'router:nine/coding-main', expectedExpiryMs);
      expect(expiredAuth.authorized).toBe(false);
      if (!expiredAuth.authorized) {
        expect(expiredAuth.errorCode).toBe('CONSENT_EXPIRED');
      }

      // Hand-edit level on disk -> fail-closed CONSENT_HMAC_INVALID
      const policyPath = path.join(stateDir, 'standing-consent.json');
      const raw = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
      (raw['targets'] as Array<Record<string, unknown>>)[0]!['level'] = 'auto-safe';
      fs.writeFileSync(policyPath, JSON.stringify(raw, null, 2), 'utf8');

      const tamperedRead = readStandingConsent(stateDir, baseNowMs + 1000);
      expect(tamperedRead.present).toBe(true);
      expect(tamperedRead.valid).toBe(false);
      expect(tamperedRead.errorCode).toBe('CONSENT_HMAC_INVALID');
      expect(tamperedRead.activeTargets).toEqual([]);
      const tamperedAuth = authorizeTargetWrite(stateDir, 'router:nine/coding-main', baseNowMs + 1000);
      expect(tamperedAuth.authorized).toBe(false);
      if (!tamperedAuth.authorized) {
        expect(tamperedAuth.errorCode).toBe('CONSENT_HMAC_INVALID');
      }
    });

    it('revokes consent cleanly per target or --all', () => {
      const stateDir = makeTmpDir('rs-wp4-consent-revoke-');
      upsertStandingConsentTarget(stateDir, { target: 'router:nine/combo-1', level: 'propose' });
      upsertStandingConsentTarget(stateDir, { target: 'harness:opencode', level: 'propose' });

      revokeStandingConsentTarget(stateDir, 'router:nine/combo-1');
      const afterSingle = authorizeTargetWrite(stateDir, 'router:nine/combo-1');
      expect(afterSingle.authorized).toBe(false);
      expect(authorizeTargetWrite(stateDir, 'harness:opencode').authorized).toBe(true);

      revokeStandingConsentTarget(stateDir, '--all');
      expect(readStandingConsent(stateDir).activeTargets).toEqual([]);
    });
  });

  describe('C45 §3.2 Auto-Safe Promotion & Runtime Execution Gate (M1 Guard)', () => {
    it('rejects auto-safe promotion without verified propose receipt, rejects rolled-back receipt, succeeds after verified propose receipt, and blocks runtime auto-safe if apply-history.json is deleted/tampered', () => {
      const stateDir = makeTmpDir('rs-wp4-promotion-');
      const target = 'router:nine/coding-primary';

      // 1. Denied when no receipt exists
      expect(() =>
        upsertStandingConsentTarget(stateDir, { target, level: 'auto-safe' })
      ).toThrowError(ConsentValidationError);
      try {
        upsertStandingConsentTarget(stateDir, { target, level: 'auto-safe' });
      } catch (err) {
        expect((err as ConsentValidationError).code).toBe('AUTO_SAFE_PROMOTION_DENIED');
      }

      // 2. Denied when receipt rolledBack === true or readBackVerified === false
      appendApplyReceipt(stateDir, {
        target,
        planHash: 'hash-rolled-back-01',
        appliedAt: '2026-11-24T01:00:00.000Z',
        appliedAtLevel: 'propose',
        authorizedVia: 'standing-consent',
        success: false,
        readBackVerified: false,
        readBackLevel: 'db-only',
        rolledBack: true,
        snapshotOrBackupRef: 'snap-failed-1',
      });

      expect(() => assertEligibleForAutoSafe(stateDir, target)).toThrowError(ConsentValidationError);

      // 3. Append a verified propose receipt -> promotion succeeds and binds receiptId
      const okReceipt = appendApplyReceipt(stateDir, {
        target,
        planHash: 'hash-verified-02',
        appliedAt: '2026-11-24T02:00:00.000Z',
        appliedAtLevel: 'propose',
        authorizedVia: 'standing-consent',
        success: true,
        readBackVerified: true,
        readBackLevel: 'db-only',
        rolledBack: false,
        snapshotOrBackupRef: 'snap-ok-2',
      });

      const promoted = upsertStandingConsentTarget(stateDir, { target, level: 'auto-safe' });
      expect(promoted.level).toBe('auto-safe');
      expect(promoted.verifiedProposeReceiptId).toBe(okReceipt.receiptId);

      const runtimeOk = authorizeTargetWrite(stateDir, target);
      expect(runtimeOk.authorized).toBe(true);
      if (runtimeOk.authorized) {
        expect(runtimeOk.level).toBe('auto-safe');
      }

      // 4. Tamper with apply-history.json -> runtime auto-safe execution MUST fail closed!
      const historyPath = path.join(stateDir, 'apply-history.json');
      const rawHist = JSON.parse(fs.readFileSync(historyPath, 'utf8')) as Record<string, unknown>;
      (rawHist['receipts'] as Array<Record<string, unknown>>)[0]!['rolledBack'] = false;
      rawHist['hmacSha256'] = '0'.repeat(64);
      fs.writeFileSync(historyPath, JSON.stringify(rawHist, null, 2), 'utf8');

      expect(readApplyHistory(stateDir).valid).toBe(false);
      const runtimeTampered = authorizeTargetWrite(stateDir, target);
      expect(runtimeTampered.authorized).toBe(false);
      if (!runtimeTampered.authorized) {
        expect(runtimeTampered.errorCode).toBe('AUTO_SAFE_RECEIPT_MISSING');
      }

      // 5. Delete apply-history.json -> runtime auto-safe execution still fails closed!
      fs.unlinkSync(historyPath);
      const runtimeMissing = authorizeTargetWrite(stateDir, target);
      expect(runtimeMissing.authorized).toBe(false);
      if (!runtimeMissing.authorized) {
        expect(runtimeMissing.errorCode).toBe('AUTO_SAFE_RECEIPT_MISSING');
      }
    });
  });

  describe('Emergency Freeze Gate Fail-Closed Semantics (M2 Guard)', () => {
    it('evaluates absent freeze.json as unfrozen, active freeze.json as frozen, and corrupt freeze.json as FROZEN fail-closed', () => {
      const stateDir = makeTmpDir('rs-wp4-freeze-');
      expect(readFreezeState(stateDir).frozen).toBe(false);
      expect(fs.readdirSync(stateDir)).toEqual([]);

      activateFreeze(stateDir, 'incident-drill');
      const active = readFreezeState(stateDir);
      expect(active.frozen).toBe(true);
      expect(active.reason).toBe('incident-drill');

      deactivateFreeze(stateDir);
      expect(readFreezeState(stateDir).frozen).toBe(false);

      // Corrupt JSON on disk -> MUST fail closed as frozen: true!
      fs.writeFileSync(path.join(stateDir, 'freeze.json'), '{ truncated-json', 'utf8');
      const corrupt = readFreezeState(stateDir);
      expect(corrupt.frozen).toBe(true);
      expect(corrupt.reason).toBe('corrupt-freeze-file-fail-closed');
    });
  });

  describe('Cross-Process Persistent Approval Token Store', () => {
    it('enforces HMAC signature, TTL expiry, non-consumption on plan_hash_mismatch, and single-use consumption', () => {
      const stateDir = makeTmpDir('rs-wp4-tokens-');
      const baseNowMs = Date.parse('2026-11-24T10:00:00.000Z');
      const issued = issuePersistentApprovalToken(
        stateDir,
        'plan-hash-expected-1234',
        300_000,
        ['router:nine/coding-main'],
        baseNowMs
      );
      expect(issued.token).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);

      // Forged signature rejected without consuming
      const [nonce, sig] = issued.token.split('.') as [string, string];
      const forged = `${nonce}.${sig[0] === '0' ? '1' : '0'}${sig.slice(1)}`;
      const forgedCheck = verifyAndConsumePersistentApprovalToken(
        stateDir,
        forged,
        'plan-hash-expected-1234',
        ['router:nine/coding-main'],
        baseNowMs + 1000
      );
      expect(forgedCheck).toEqual({ valid: false, reason: 'invalid_signature' });

      // Wrong planHash rejected WITHOUT consuming token
      const mismatchCheck = verifyAndConsumePersistentApprovalToken(
        stateDir,
        issued.token,
        'wrong-plan-hash-9999',
        ['router:nine/coding-main'],
        baseNowMs + 1000
      );
      expect(mismatchCheck).toEqual({ valid: false, reason: 'plan_hash_mismatch' });

      // Valid verification consumes token once
      const okCheck = verifyAndConsumePersistentApprovalToken(
        stateDir,
        issued.token,
        'plan-hash-expected-1234',
        ['router:nine/coding-main'],
        baseNowMs + 2000
      );
      expect(okCheck).toEqual({ valid: true });

      // Replay rejected
      const replayCheck = verifyAndConsumePersistentApprovalToken(
        stateDir,
        issued.token,
        'plan-hash-expected-1234',
        ['router:nine/coding-main'],
        baseNowMs + 3000
      );
      expect(replayCheck).toEqual({ valid: false, reason: 'token_already_consumed' });

      // Expired token rejected
      const expiredTok = issuePersistentApprovalToken(stateDir, 'plan-exp', 500, undefined, baseNowMs);
      const expCheck = verifyAndConsumePersistentApprovalToken(
        stateDir,
        expiredTok.token,
        'plan-exp',
        undefined,
        baseNowMs + 1000
      );
      expect(expCheck).toEqual({ valid: false, reason: 'token_expired' });
    });
  });

  describe('Controlled Write Sandbox Guard', () => {
    it('allows paths inside os.tmpdir() and blocks homedir, bots.json, and routines.json', () => {
      const tmpDir = makeTmpDir('rs-wp4-sandbox-');
      const okDb = path.join(tmpDir, 'sandbox-router.sqlite');
      const okHarness = path.join(tmpDir, 'opencode.jsonc');

      expect(() => assertControlledWriteSandbox(okDb, 'router-db', {})).not.toThrow();
      expect(() => assertControlledWriteSandbox(okHarness, 'harness-config', {})).not.toThrow();

      // Unconditionally block OpenMausBot runtime files even inside tmpdir
      expect(() =>
        assertControlledWriteSandbox(path.join(tmpDir, 'bots.json'), 'harness-config', {})
      ).toThrow();
      expect(() =>
        assertControlledWriteSandbox(path.join(tmpDir, 'routines.json'), 'harness-config', {})
      ).toThrow();

      // Block homedir paths outside tmpdir
      const fakeHomeTarget = path.join(os.homedir(), '.opencode', 'opencode.json');
      expect(() =>
        assertControlledWriteSandbox(fakeHomeTarget, 'harness-config', {})
      ).toThrowError(ConsentValidationError);
    });

    it('F1: resolves deep existing ancestor realpath for non-existent files under aliased os.tmpdir() and blocks directory symlink/junction escapes outside os.tmpdir()', () => {
      const realTmpBacking = makeTmpDir('rs-wp4-f1-real-');
      const linkHolder = makeTmpDir('rs-wp4-f1-holder-');
      const aliasedTmpDir = path.join(linkHolder, 'aliased-tmpdir');
      createDirLinkOrJunction(realTmpBacking, aliasedTmpDir);

      // (a) Reproduce macOS /var/folders -> /private/var/folders & Windows 8.3 short-name tmpdir:
      // os.tmpdir() points to an existing symlink/alias, while targetPath has non-existent nested segments.
      const prevTmpDir = process.env['TMPDIR'];
      const prevTemp = process.env['TEMP'];
      const prevTmp = process.env['TMP'];
      process.env['TMPDIR'] = aliasedTmpDir;
      process.env['TEMP'] = aliasedTmpDir;
      process.env['TMP'] = aliasedTmpDir;
      try {
        const nonExistentDb = path.join(aliasedTmpDir, 'nested-a', 'nested-b', 'sandbox-router.sqlite');
        const nonExistentCfg = path.join(aliasedTmpDir, 'nested-a', 'opencode.jsonc');

        expect(() => assertControlledWriteSandbox(nonExistentDb, 'router-db', {})).not.toThrow();
        expect(() => assertControlledWriteSandbox(nonExistentCfg, 'harness-config', {})).not.toThrow();
      } finally {
        if (prevTmpDir === undefined) delete process.env['TMPDIR'];
        else process.env['TMPDIR'] = prevTmpDir;
        if (prevTemp === undefined) delete process.env['TEMP'];
        else process.env['TEMP'] = prevTemp;
        if (prevTmp === undefined) delete process.env['TMP'];
        else process.env['TMP'] = prevTmp;
      }

      // (b) Directory symlink/junction inside os.tmpdir() pointing outside os.tmpdir() with a NON-EXISTENT filename
      // MUST fail closed with SANDBOX_OUTSIDE_TMPDIR even when process.cwd() itself resides inside os.tmpdir()!
      const sandboxDir = makeTmpDir('rs-wp4-f1-escape-');
      const escapeLinkDir = path.join(sandboxDir, 'escape-outside-tmp');
      const realTmpRoot = path.parse(fs.realpathSync.native(os.tmpdir())).root;
      createDirLinkOrJunction(realTmpRoot, escapeLinkDir);

      const prevCwd = process.cwd();
      try {
        process.chdir(sandboxDir);
        const escapedHarnessPath = path.join(escapeLinkDir, 'nonexistent-escaped-victim.json');
        const escapedRouterDbPath = path.join(escapeLinkDir, 'nonexistent-escaped-router.sqlite');

        expect(() =>
          assertControlledWriteSandbox(escapedHarnessPath, 'harness-config', {})
        ).toThrowError(ConsentValidationError);
        try {
          assertControlledWriteSandbox(escapedHarnessPath, 'harness-config', {});
        } catch (err) {
          expect((err as ConsentValidationError).code).toBe('SANDBOX_OUTSIDE_TMPDIR');
        }

        expect(() =>
          assertControlledWriteSandbox(escapedRouterDbPath, 'router-db', {})
        ).toThrowError(ConsentValidationError);
        try {
          assertControlledWriteSandbox(escapedRouterDbPath, 'router-db', {});
        } catch (err) {
          expect((err as ConsentValidationError).code).toBe('SANDBOX_OUTSIDE_TMPDIR');
        }
      } finally {
        process.chdir(prevCwd);
      }
    });
  });
});
