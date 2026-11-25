/**
 * packages/core/src/consent/types.ts
 *
 * Canonical types and error classes for C45-WP4 Controlled Automation:
 * Standing Consent (30d TTL, 3-tier mode, C45 §3.2 verified-propose promotion gate),
 * Apply History Receipts, Emergency Freeze, and Persistent Approval Tokens
 * (Phục vụ: S3, S4, S9).
 */

import * as os from 'node:os';
import * as path from 'node:path';

export const DEFAULT_CONSENT_TTL_DAYS = 30;
export const MAX_CONSENT_TTL_DAYS = 90;

export type ConsentLevel = 'propose' | 'auto-safe' | 'off';
export type EffectiveTargetMode = 'propose' | 'auto-safe' | 'off' | 'FROZEN';

export type ConsentErrorCode =
  | 'WILDCARD_TARGET_FORBIDDEN'
  | 'TARGET_NOT_WRITABLE'
  | 'INVALID_TARGET_SYNTAX'
  | 'INVALID_CONSENT_TTL'
  | 'INVALID_CONSENT_LEVEL'
  | 'CONSENT_HMAC_INVALID'
  | 'CONSENT_SCHEMA_INVALID'
  | 'CONSENT_EXPIRED'
  | 'TARGET_CONSENT_OFF'
  | 'UNAUTHORIZED_TARGET'
  | 'APPROVAL_TOKEN_REQUIRED'
  | 'AUTO_SAFE_PROMOTION_DENIED'
  | 'AUTO_SAFE_RECEIPT_MISSING'
  | 'WRITE_FROZEN'
  | 'SANDBOX_OUTSIDE_TMPDIR'
  | 'FORBIDDEN_RUNTIME_FILE';

export class ConsentValidationError extends Error {
  readonly code: ConsentErrorCode;

  constructor(code: ConsentErrorCode, message: string) {
    super(message);
    this.name = 'ConsentValidationError';
    this.code = code;
  }
}

export interface ParsedTargetScope {
  target: string;
  targetKind: 'router' | 'harness';
  routerId?: string | undefined;
  comboName?: string | undefined;
  harnessId?: string | undefined;
}

export interface StandingConsentEntry {
  target: string; // "router:<routerId>/<comboName>" | "harness:<harnessId>"
  targetKind: 'router' | 'harness';
  routerId?: string | undefined;
  comboName?: string | undefined;
  harnessId?: string | undefined;
  level: ConsentLevel;
  grantedAt: string; // ISO-8601
  expiresAt: string; // ISO-8601 (default: grantedAt + 30 days)
  grantedBy: 'interactive-tty';
  verifiedProposeReceiptId?: string | undefined; // Required iff level === 'auto-safe'
}

export interface StandingConsentEntryView extends StandingConsentEntry {
  expired: boolean;
}

export interface StandingConsentPolicyFile {
  version: 1;
  policyId: string; // 32-char hex
  updatedAt: string; // ISO-8601
  targets: StandingConsentEntry[];
  hmacSha256: string; // 64-char hex HMAC-SHA256 over canonical payload
}

export interface ReadStandingConsentResult {
  present: boolean;
  valid: boolean;
  errorCode?: 'CONSENT_HMAC_INVALID' | 'CONSENT_SCHEMA_INVALID' | undefined;
  policyId?: string | undefined;
  updatedAt?: string | undefined;
  targets: StandingConsentEntryView[];
  activeTargets: StandingConsentEntry[];
}

export type AuthorizeTargetWriteResult =
  | {
      authorized: true;
      level: 'propose' | 'auto-safe';
      entry: StandingConsentEntry;
    }
  | {
      authorized: false;
      errorCode: ConsentErrorCode;
      message: string;
    };

export interface ApplyHistoryReceipt {
  receiptId: string; // 32-char hex
  target: string; // "router:<routerId>/<comboName>" | "harness:<harnessId>"
  planHash: string;
  appliedAt: string; // ISO-8601
  appliedAtLevel: 'propose' | 'auto-safe';
  authorizedVia: 'standing-consent' | 'approval-token' | 'interactive-tty' | 'legacy-grant';
  success: boolean;
  readBackVerified: boolean;
  readBackLevel: string;
  rolledBack: boolean;
  snapshotOrBackupRef: string;
  preDigest?: string | undefined;
  postDigest?: string | undefined;
}

export interface ApplyHistoryFile {
  version: 1;
  updatedAt: string;
  receipts: ApplyHistoryReceipt[];
  hmacSha256: string;
}

export interface ReadApplyHistoryResult {
  present: boolean;
  valid: boolean;
  errorCode?: 'CONSENT_HMAC_INVALID' | 'CONSENT_SCHEMA_INVALID' | undefined;
  updatedAt?: string | undefined;
  receipts: ApplyHistoryReceipt[];
}

export interface FreezeStateFile {
  version: 1;
  frozen: boolean;
  frozenAt: string | null;
  unfrozenAt?: string | null | undefined;
  reason: string | null;
}

export interface PersistentApprovalTokenEntry {
  nonceHex: string;
  sigHex: string;
  planHash: string;
  allowedTargets?: string[] | undefined;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

export interface PersistentApprovalTokenStoreFile {
  version: 1;
  updatedAt: string;
  tokens: PersistentApprovalTokenEntry[];
  hmacSha256: string;
}

export type PersistentTokenRejectionReason =
  | 'token_not_found'
  | 'invalid_signature'
  | 'plan_hash_mismatch'
  | 'target_scope_mismatch'
  | 'token_expired'
  | 'token_already_consumed';

export interface PersistentTokenVerifyResult {
  valid: boolean;
  reason?: PersistentTokenRejectionReason | undefined;
}

/**
 * Resolves the unified control-plane state directory shared across CLI, Daemon,
 * `tick`, and MCP `apply_plan`.
 *
 * Note: pure path computation — NEVER creates directories or files on disk.
 */
export function resolveControlStateDir(
  explicitStateDir?: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (typeof explicitStateDir === 'string' && explicitStateDir.trim().length > 0) {
    return path.resolve(explicitStateDir.trim());
  }
  const envState = env['ROUTERSYNC_STATE_DIR']?.trim();
  if (envState) {
    return path.resolve(envState);
  }
  const envHome = env['ROUTERSYNC_HOME']?.trim();
  if (envHome) {
    return path.resolve(envHome, 'state');
  }
  return path.join(os.homedir(), '.routersync');
}
