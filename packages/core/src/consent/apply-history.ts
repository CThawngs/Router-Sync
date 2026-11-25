/**
 * packages/core/src/consent/apply-history.ts
 *
 * HMAC-protected Apply History Receipt ledger (`<stateDir>/apply-history.json`)
 * and C45 §3.2 hard promotion gate (`assertEligibleForAutoSafe`).
 *
 * Read-only invariant: `readApplyHistory` NEVER creates files, directories, or keys.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../paths/atomic.js';
import {
  canonicalJsonStringify,
  computeHmacSha256Hex,
  ensureConsentSigningKey,
  readConsentSigningKeyIfPresent,
  verifyHmacSha256Hex,
} from './signing.js';
import {
  type ApplyHistoryFile,
  type ApplyHistoryReceipt,
  ConsentValidationError,
  type ReadApplyHistoryResult,
  resolveControlStateDir,
} from './types.js';

export const APPLY_HISTORY_FILENAME = 'apply-history.json';
export const MAX_APPLY_HISTORY_RECEIPTS = 500;

function isValidReceiptShape(item: unknown): item is ApplyHistoryReceipt {
  if (!item || typeof item !== 'object') return false;
  const r = item as Record<string, unknown>;
  return (
    typeof r['receiptId'] === 'string' &&
    r['receiptId'].length >= 8 &&
    typeof r['target'] === 'string' &&
    r['target'].length >= 3 &&
    typeof r['planHash'] === 'string' &&
    typeof r['appliedAt'] === 'string' &&
    (r['appliedAtLevel'] === 'propose' || r['appliedAtLevel'] === 'auto-safe') &&
    (r['authorizedVia'] === 'standing-consent' ||
      r['authorizedVia'] === 'approval-token' ||
      r['authorizedVia'] === 'interactive-tty' ||
      r['authorizedVia'] === 'legacy-grant') &&
    typeof r['success'] === 'boolean' &&
    typeof r['readBackVerified'] === 'boolean' &&
    typeof r['readBackLevel'] === 'string' &&
    typeof r['rolledBack'] === 'boolean' &&
    typeof r['snapshotOrBackupRef'] === 'string'
  );
}

/**
 * Strictly read-only load of `<stateDir>/apply-history.json`.
 * Never creates files, directories, or signing keys.
 */
export function readApplyHistory(explicitStateDir?: string | undefined): ReadApplyHistoryResult {
  const stateDir = resolveControlStateDir(explicitStateDir);
  const historyPath = path.join(stateDir, APPLY_HISTORY_FILENAME);
  if (!fs.existsSync(historyPath)) {
    return {
      present: false,
      valid: true,
      receipts: [],
    };
  }

  const signingKey = readConsentSigningKeyIfPresent(stateDir);
  if (!signingKey) {
    return {
      present: true,
      valid: false,
      errorCode: 'CONSENT_HMAC_INVALID',
      receipts: [],
    };
  }

  try {
    const raw = fs.readFileSync(historyPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed['version'] !== 1 ||
      typeof parsed['updatedAt'] !== 'string' ||
      !Array.isArray(parsed['receipts']) ||
      typeof parsed['hmacSha256'] !== 'string'
    ) {
      return {
        present: true,
        valid: false,
        errorCode: 'CONSENT_SCHEMA_INVALID',
        receipts: [],
      };
    }

    const receiptsRaw = parsed['receipts'] as unknown[];
    if (!receiptsRaw.every(isValidReceiptShape)) {
      return {
        present: true,
        valid: false,
        errorCode: 'CONSENT_SCHEMA_INVALID',
        receipts: [],
      };
    }

    const canonicalPayload = canonicalJsonStringify({
      version: 1,
      updatedAt: parsed['updatedAt'],
      receipts: receiptsRaw,
    });

    if (!verifyHmacSha256Hex(signingKey, canonicalPayload, parsed['hmacSha256'])) {
      return {
        present: true,
        valid: false,
        errorCode: 'CONSENT_HMAC_INVALID',
        receipts: [],
      };
    }

    return {
      present: true,
      valid: true,
      updatedAt: parsed['updatedAt'],
      receipts: receiptsRaw as ApplyHistoryReceipt[],
    };
  } catch {
    return {
      present: true,
      valid: false,
      errorCode: 'CONSENT_SCHEMA_INVALID',
      receipts: [],
    };
  }
}

export type AppendApplyReceiptInput = Omit<ApplyHistoryReceipt, 'receiptId'> & {
  receiptId?: string | undefined;
};

/**
 * Appends a signed `ApplyHistoryReceipt` to `<stateDir>/apply-history.json`
 * (capped to newest 500 receipts).
 */
export function appendApplyReceipt(
  explicitStateDir: string | undefined,
  input: AppendApplyReceiptInput
): ApplyHistoryReceipt {
  const stateDir = resolveControlStateDir(explicitStateDir);
  const signingKey = ensureConsentSigningKey(stateDir);
  const existing = readApplyHistory(stateDir);
  const baseReceipts = existing.valid ? existing.receipts : [];

  const receipt: ApplyHistoryReceipt = {
    receiptId:
      typeof input.receiptId === 'string' && input.receiptId.trim().length >= 8
        ? input.receiptId.trim()
        : crypto.randomBytes(16).toString('hex'),
    target: input.target.trim(),
    planHash: input.planHash,
    appliedAt: input.appliedAt,
    appliedAtLevel: input.appliedAtLevel,
    authorizedVia: input.authorizedVia,
    success: input.success,
    readBackVerified: input.readBackVerified,
    readBackLevel: input.readBackLevel,
    rolledBack: input.rolledBack,
    snapshotOrBackupRef: input.snapshotOrBackupRef,
    ...(input.preDigest !== undefined ? { preDigest: input.preDigest } : {}),
    ...(input.postDigest !== undefined ? { postDigest: input.postDigest } : {}),
  };

  const receipts = [...baseReceipts, receipt].slice(-MAX_APPLY_HISTORY_RECEIPTS);
  const updatedAt = new Date().toISOString();
  const canonicalPayload = canonicalJsonStringify({
    version: 1,
    updatedAt,
    receipts,
  });
  const hmacSha256 = computeHmacSha256Hex(signingKey, canonicalPayload);

  const filePayload: ApplyHistoryFile = {
    version: 1,
    updatedAt,
    receipts,
    hmacSha256,
  };
  const historyPath = path.join(stateDir, APPLY_HISTORY_FILENAME);
  atomicWriteFileSync(historyPath, `${JSON.stringify(filePayload, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

/**
 * Marks matching non-rolled-back receipt(s) in `<stateDir>/apply-history.json` as
 * `rolledBack: true` and re-signs the file with HMAC-SHA256.
 *
 * When rolling back to an earlier snapshot/backup ref, also invalidates all
 * subsequent chronologically appended receipts in the same target scope (and
 * receipts at or after `appliedAtOrAfter` when rolling back to a manual pre-pilot
 * snapshot that has no direct apply receipt).
 *
 * Read-safe when `apply-history.json` does not exist (returns `0` without creating files).
 * Fails closed with `ConsentValidationError` if `apply-history.json` is tampered/corrupt.
 */
export function markApplyReceiptRolledBack(
  explicitStateDir: string | undefined,
  criteria: {
    target?: string | undefined;
    targetPrefix?: string | undefined;
    snapshotOrBackupRef?: string | undefined;
    appliedAtOrAfter?: string | undefined;
  }
): number {
  const stateDir = resolveControlStateDir(explicitStateDir);
  const existing = readApplyHistory(stateDir);
  if (!existing.present) {
    return 0;
  }
  if (!existing.valid) {
    throw new ConsentValidationError(
      existing.errorCode ?? 'CONSENT_HMAC_INVALID',
      `Apply history ledger (<stateDir>/apply-history.json) failed integrity verification (${existing.errorCode ?? 'CONSENT_HMAC_INVALID'}).`
    );
  }

  const normalizedTarget = criteria.target?.trim();
  const normalizedPrefix = criteria.targetPrefix?.trim();
  const normalizedRef = criteria.snapshotOrBackupRef?.trim();
  const rawCutoff = criteria.appliedAtOrAfter?.trim();
  const cutoffMs = rawCutoff ? Date.parse(rawCutoff) : Number.NaN;
  const hasCutoff = Number.isFinite(cutoffMs);
  const foldCase = process.platform === 'win32' || process.platform === 'darwin';
  const normPathOrRef = (v: string): string => {
    const resolved = v.includes('/') || v.includes('\\') ? path.resolve(v) : v;
    return foldCase ? resolved.toLowerCase() : resolved;
  };

  const matchesScope = (r: ApplyHistoryReceipt): boolean =>
    (normalizedTarget ? r.target === normalizedTarget : true) &&
    (normalizedPrefix ? r.target.startsWith(normalizedPrefix) : true);

  const normRef = normalizedRef ? normPathOrRef(normalizedRef) : undefined;
  const firstScopedExactIdx = normRef
    ? existing.receipts.findIndex(
        (r) => matchesScope(r) && normPathOrRef(r.snapshotOrBackupRef) === normRef
      )
    : -1;
  const firstAnyExactIdx = normRef
    ? existing.receipts.findIndex((r) => normPathOrRef(r.snapshotOrBackupRef) === normRef)
    : -1;

  let updatedCount = 0;
  let finalReceipts = existing.receipts;

  if (normRef) {
    const pivotIdx = firstScopedExactIdx >= 0 ? firstScopedExactIdx : firstAnyExactIdx;
    if (pivotIdx >= 0) {
      finalReceipts = existing.receipts.map((r, idx) => {
        if (r.rolledBack || !matchesScope(r)) return r;
        const appliedMs = Date.parse(r.appliedAt);
        const afterCutoff = hasCutoff && Number.isFinite(appliedMs) && appliedMs > cutoffMs;
        if (idx >= pivotIdx || afterCutoff) {
          updatedCount += 1;
          return { ...r, rolledBack: true };
        }
        return r;
      });
    } else if (hasCutoff) {
      finalReceipts = existing.receipts.map((r) => {
        if (r.rolledBack || !matchesScope(r)) return r;
        const appliedMs = Date.parse(r.appliedAt);
        if (Number.isFinite(appliedMs) && appliedMs >= cutoffMs) {
          updatedCount += 1;
          return { ...r, rolledBack: true };
        }
        return r;
      });
    }
  } else {
    finalReceipts = existing.receipts.map((r) => {
      if (r.rolledBack || !matchesScope(r)) return r;
      const appliedMs = Date.parse(r.appliedAt);
      if (!hasCutoff || (Number.isFinite(appliedMs) && appliedMs >= cutoffMs)) {
        updatedCount += 1;
        return { ...r, rolledBack: true };
      }
      return r;
    });
  }

  // Fallback for harness rollback when backup path was overridden (e.g. pre-pilot backup):
  // if target matched active receipts even though backup ref differed, mark target receipts rolled back.
  if (updatedCount === 0 && normalizedTarget && normRef && !hasCutoff) {
    finalReceipts = existing.receipts.map((r) => {
      if (!r.rolledBack && r.target === normalizedTarget) {
        updatedCount += 1;
        return { ...r, rolledBack: true };
      }
      return r;
    });
  }

  if (updatedCount === 0) {
    return 0;
  }

  const signingKey = ensureConsentSigningKey(stateDir);
  const updatedAt = new Date().toISOString();
  const canonicalPayload = canonicalJsonStringify({
    version: 1,
    updatedAt,
    receipts: finalReceipts,
  });
  const hmacSha256 = computeHmacSha256Hex(signingKey, canonicalPayload);
  const filePayload: ApplyHistoryFile = {
    version: 1,
    updatedAt,
    receipts: finalReceipts,
    hmacSha256,
  };
  const historyPath = path.join(stateDir, APPLY_HISTORY_FILENAME);
  atomicWriteFileSync(historyPath, `${JSON.stringify(filePayload, null, 2)}\n`, { mode: 0o600 });
  return updatedCount;
}

/**
 * Strictly read-only search for the newest verified, non-rolled-back `propose` receipt
 * for `target` inside an HMAC-valid `apply-history.json`.
 */
export function findVerifiedProposeReceipt(
  explicitStateDir: string | undefined,
  target: string
): ApplyHistoryReceipt | null {
  const normalizedTarget = target.trim();
  const hist = readApplyHistory(explicitStateDir);
  if (!hist.valid) {
    return null;
  }
  for (let i = hist.receipts.length - 1; i >= 0; i--) {
    const r = hist.receipts[i]!;
    if (
      r.target === normalizedTarget &&
      r.appliedAtLevel === 'propose' &&
      r.authorizedVia !== 'standing-consent' &&
      r.success === true &&
      r.readBackVerified === true &&
      r.rolledBack === false
    ) {
      return r;
    }
  }
  return null;
}

/**
 * C45 §3.2 Hard Promotion Gate:
 * Asserts `target` has at least 1 verified, non-rolled-back `propose` receipt
 * in an HMAC-valid `<stateDir>/apply-history.json`.
 */
export function assertEligibleForAutoSafe(
  explicitStateDir: string | undefined,
  target: string
): ApplyHistoryReceipt {
  const receipt = findVerifiedProposeReceipt(explicitStateDir, target);
  if (!receipt) {
    throw new ConsentValidationError(
      'AUTO_SAFE_PROMOTION_DENIED',
      `Target '${target}' cannot enter 'auto-safe': requires at least 1 successful, read-back verified, non-rolled-back 'propose' apply receipt in HMAC-valid apply-history.json (C45 §3.2).`
    );
  }
  return receipt;
}
