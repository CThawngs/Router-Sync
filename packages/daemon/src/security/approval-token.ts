/**
 * packages/daemon/src/security/approval-token.ts
 *
 * Human Approval Token Management (Phase 3b / T3-DAEMON-SEC / M2-01 / SPEC §03).
 *
 * Invariant: AI/MCP clients can never approve changes; only human-granted
 * HMAC-SHA256 signed tokens (`<nonceHex>.<sigHex>`) tied to a matching planHash
 * can authorize write actions. Tokens are single-use nonces with strict TTL.
 */

import * as crypto from 'node:crypto';

export interface ApprovalTokenRecord {
  token: string;
  planHash: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

interface StoredApprovalNonceRecord {
  nonceHex: string;
  planHash: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

export type ApprovalTokenRejectionReason =
  | 'token_not_found'
  | 'invalid_signature'
  | 'plan_hash_mismatch'
  | 'token_expired'
  | 'token_already_consumed';

export interface TokenVerificationResult {
  valid: boolean;
  reason?: ApprovalTokenRejectionReason | undefined;
}

const DEFAULT_TTL_MS = 300_000; // 5 minutes
const HEX_64_RE = /^[0-9a-f]{64}$/i;

export class ApprovalTokenManager {
  readonly #signingKey: Buffer = crypto.randomBytes(32);
  readonly #tokens = new Map<string, StoredApprovalNonceRecord>();

  #computeCanonicalPayload(
    nonceHex: string,
    planHash: string,
    createdAt: number,
    expiresAt: number
  ): string {
    return `${nonceHex}:${planHash}:${createdAt}:${expiresAt}`;
  }

  #signPayloadBuf(payload: string): Buffer {
    return crypto.createHmac('sha256', this.#signingKey).update(payload, 'utf8').digest();
  }

  issueToken(planHash: string, ttlMs = DEFAULT_TTL_MS): ApprovalTokenRecord {
    const nonceHex = crypto.randomBytes(32).toString('hex');
    const createdAt = Date.now();
    const expiresAt = createdAt + ttlMs;
    const payload = this.#computeCanonicalPayload(nonceHex, planHash, createdAt, expiresAt);
    const sigHex = this.#signPayloadBuf(payload).toString('hex');

    this.#tokens.set(nonceHex, {
      nonceHex,
      planHash,
      createdAt,
      expiresAt,
      consumed: false,
    });

    return {
      token: `${nonceHex}.${sigHex}`,
      planHash,
      createdAt,
      expiresAt,
      consumed: false,
    };
  }

  verifyAndConsume(token: string, planHash: string): TokenVerificationResult {
    // Step 1: Legacy non-dot lookup guard (preserves AT-165 'non-existent-token-hex' -> 401 token_not_found)
    if (typeof token !== 'string' || !token.includes('.')) {
      return { valid: false, reason: 'token_not_found' };
    }

    // Step 2: Structural <64hex>.<64hex> check
    const parts = token.split('.');
    if (parts.length !== 2 || !HEX_64_RE.test(parts[0]!) || !HEX_64_RE.test(parts[1]!)) {
      return { valid: false, reason: 'invalid_signature' };
    }

    const nonceHex = parts[0]!.toLowerCase();
    const sigHex = parts[1]!.toLowerCase();
    const actualSigBuf = Buffer.from(sigHex, 'hex');

    // Step 3: Constant-time HMAC verification BEFORE any state mutation
    const record = this.#tokens.get(nonceHex);
    if (!record) {
      const dummySigBuf = this.#signPayloadBuf(nonceHex);
      crypto.timingSafeEqual(dummySigBuf, actualSigBuf);
      return { valid: false, reason: 'invalid_signature' };
    }

    const expectedPayload = this.#computeCanonicalPayload(
      record.nonceHex,
      record.planHash,
      record.createdAt,
      record.expiresAt
    );
    const expectedSigBuf = this.#signPayloadBuf(expectedPayload);
    if (
      expectedSigBuf.length !== actualSigBuf.length ||
      !crypto.timingSafeEqual(expectedSigBuf, actualSigBuf)
    ) {
      return { valid: false, reason: 'invalid_signature' };
    }

    // Step 4: Replay check
    if (record.consumed) {
      return { valid: false, reason: 'token_already_consumed' };
    }

    // Step 5: Expiry check
    if (Date.now() > record.expiresAt) {
      return { valid: false, reason: 'token_expired' };
    }

    // Step 6: Plan binding check (does not consume token on wrong planHash)
    if (record.planHash !== planHash) {
      return { valid: false, reason: 'plan_hash_mismatch' };
    }

    // Step 7: Atomically mark consumed & succeed
    record.consumed = true;
    return { valid: true };
  }

  clearExpired(): number {
    const now = Date.now();
    let cleared = 0;
    for (const [nonceHex, record] of this.#tokens.entries()) {
      if (now > record.expiresAt || record.consumed) {
        this.#tokens.delete(nonceHex);
        cleared++;
      }
    }
    return cleared;
  }

  reset(): void {
    this.#tokens.clear();
  }
}

const defaultApprovalTokenManager = new ApprovalTokenManager();

/**
 * Creates a cryptographically signed single-use approval token tied to a specific planHash.
 */
export function createApprovalToken(
  planHash: string,
  ttlMs = DEFAULT_TTL_MS
): ApprovalTokenRecord {
  return defaultApprovalTokenManager.issueToken(planHash, ttlMs);
}

export const issueApprovalToken = createApprovalToken;

/**
 * Verifies HMAC signature, TTL, and planHash binding, and atomically consumes the token.
 */
export function verifyAndConsumeApprovalToken(
  token: string,
  planHash: string
): TokenVerificationResult {
  return defaultApprovalTokenManager.verifyAndConsume(token, planHash);
}

/**
 * Clears expired or consumed tokens to keep memory footprint bounded.
 */
export function clearExpiredTokens(): number {
  return defaultApprovalTokenManager.clearExpired();
}

/**
 * Resets the token registry (primarily used for test cleanup).
 */
export function resetTokenRegistry(): void {
  defaultApprovalTokenManager.reset();
}
