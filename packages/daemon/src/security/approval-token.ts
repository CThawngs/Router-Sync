/**
 * packages/daemon/src/security/approval-token.ts
 *
 * Human Approval Token Management (Phase 3b / T3-DAEMON-SEC / SPEC §03).
 *
 * Invariant: AI/MCP clients can never approve changes; only human-granted
 * tokens tied to a matching planHash can authorize write actions.
 * Tokens are single-use nonces with strict TTL expiration.
 */

import * as crypto from 'node:crypto';

export interface ApprovalTokenRecord {
  token: string;
  planHash: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

export interface TokenVerificationResult {
  valid: boolean;
  reason?: 'token_not_found' | 'plan_hash_mismatch' | 'token_expired' | 'token_already_consumed' | undefined;
}

const DEFAULT_TTL_MS = 300_000; // 5 minutes
const tokenStore = new Map<string, ApprovalTokenRecord>();

/**
 * Creates a cryptographically random single-use approval token tied to a specific planHash.
 */
export function createApprovalToken(
  planHash: string,
  ttlMs = DEFAULT_TTL_MS
): ApprovalTokenRecord {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const record: ApprovalTokenRecord = {
    token,
    planHash,
    createdAt: now,
    expiresAt: now + ttlMs,
    consumed: false,
  };

  tokenStore.set(token, record);
  return record;
}

/**
 * Verifies and atomically consumes an approval token.
 * Single-use invariant: If valid, the token is immediately marked consumed.
 */
export function verifyAndConsumeApprovalToken(
  token: string,
  planHash: string
): TokenVerificationResult {
  const record = tokenStore.get(token);
  if (!record) {
    return { valid: false, reason: 'token_not_found' };
  }

  if (record.consumed) {
    return { valid: false, reason: 'token_already_consumed' };
  }

  if (Date.now() > record.expiresAt) {
    return { valid: false, reason: 'token_expired' };
  }

  if (record.planHash !== planHash) {
    return { valid: false, reason: 'plan_hash_mismatch' };
  }

  // Atomically mark as consumed (single-use)
  record.consumed = true;
  return { valid: true };
}

/**
 * Clears expired tokens to keep memory footprint bounded.
 */
export function clearExpiredTokens(): number {
  const now = Date.now();
  let cleared = 0;
  for (const [token, record] of tokenStore.entries()) {
    if (now > record.expiresAt || record.consumed) {
      tokenStore.delete(token);
      cleared++;
    }
  }
  return cleared;
}

/**
 * Resets the token registry (primarily used for test cleanup).
 */
export function resetTokenRegistry(): void {
  tokenStore.clear();
}
