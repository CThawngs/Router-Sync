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
