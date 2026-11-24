/**
 * packages/core/src/consent/approval-token-store.ts
 *
 * Cross-process HMAC-protected single-use approval token ledger
 * (`<stateDir>/approval-tokens.json`, signed with `<stateDir>/consent-signing.key`).
 *
 * Shares the exact same wire format as `packages/daemon/src/security/approval-token.ts`
 * so daemon-issued tokens can be verified & consumed atomically by MCP `apply_plan`.
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
  type PersistentApprovalTokenEntry,
  type PersistentApprovalTokenStoreFile,
  type PersistentTokenVerifyResult,
  resolveControlStateDir,
} from './types.js';

export const APPROVAL_TOKENS_FILENAME = 'approval-tokens.json';
const HEX_64_RE = /^[0-9a-f]{64}$/i;
const MAX_STORED_TOKENS = 250;

export function computePersistentTokenPayload(
  nonceHex: string,
  planHash: string,
  createdAt: number,
  expiresAt: number,
  allowedTargets?: string[] | undefined
): string {
  const targetsSuffix =
    allowedTargets && allowedTargets.length > 0
      ? `:${[...allowedTargets].sort().join(',')}`
      : '';
  return `${nonceHex}:${planHash}:${createdAt}:${expiresAt}${targetsSuffix}`;
}

function readTokenStoreEntries(stateDir: string, signingKey: Buffer): PersistentApprovalTokenEntry[] | null {
  const filePath = path.join(stateDir, APPROVAL_TOKENS_FILENAME);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed['version'] !== 1 ||
      typeof parsed['updatedAt'] !== 'string' ||
      !Array.isArray(parsed['tokens']) ||
      typeof parsed['hmacSha256'] !== 'string'
    ) {
      return null;
    }
    const canonical = canonicalJsonStringify({
      version: 1,
      updatedAt: parsed['updatedAt'],
      tokens: parsed['tokens'],
    });
    if (!verifyHmacSha256Hex(signingKey, canonical, parsed['hmacSha256'])) {
      return null;
    }
    return parsed['tokens'] as PersistentApprovalTokenEntry[];
  } catch {
    return null;
  }
}

function writeTokenStoreEntries(
  stateDir: string,
  signingKey: Buffer,
  tokens: PersistentApprovalTokenEntry[],
  nowMs: number
): void {
  const bounded = tokens.slice(-MAX_STORED_TOKENS);
  const updatedAt = new Date(nowMs).toISOString();
  const canonical = canonicalJsonStringify({
    version: 1,
    updatedAt,
    tokens: bounded,
  });
  const hmacSha256 = computeHmacSha256Hex(signingKey, canonical);
  const payload: PersistentApprovalTokenStoreFile = {
    version: 1,
    updatedAt,
    tokens: bounded,
    hmacSha256,
  };
  atomicWriteFileSync(
    path.join(stateDir, APPROVAL_TOKENS_FILENAME),
    `${JSON.stringify(payload, null, 2)}\n`,
    { mode: 0o600 }
  );
}

export interface IssuedPersistentApprovalToken {
  token: string;
  planHash: string;
  allowedTargets?: string[] | undefined;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

export function issuePersistentApprovalToken(
  explicitStateDir: string | undefined,
  planHash: string,
  ttlMs = 300_000,
  allowedTargets?: string[] | undefined,
  nowMs = Date.now()
): IssuedPersistentApprovalToken {
  const stateDir = resolveControlStateDir(explicitStateDir);
  const signingKey = ensureConsentSigningKey(stateDir);
  const nonceHex = crypto.randomBytes(32).toString('hex');
  const createdAt = nowMs;
  const expiresAt = createdAt + ttlMs;
  const normalizedTargets =
    allowedTargets && allowedTargets.length > 0
      ? [...new Set(allowedTargets.map((t) => t.trim()))].sort()
      : undefined;

  const payload = computePersistentTokenPayload(
    nonceHex,
    planHash,
    createdAt,
    expiresAt,
    normalizedTargets
  );
  const sigHex = crypto.createHmac('sha256', signingKey).update(payload, 'utf8').digest('hex');

  const existing = readTokenStoreEntries(stateDir, signingKey) ?? [];
  const entry: PersistentApprovalTokenEntry = {
    nonceHex,
    sigHex,
    planHash,
    ...(normalizedTargets ? { allowedTargets: normalizedTargets } : {}),
    createdAt,
    expiresAt,
    consumed: false,
  };
  writeTokenStoreEntries(stateDir, signingKey, [...existing, entry], nowMs);

  return {
    token: `${nonceHex}.${sigHex}`,
    planHash,
    ...(normalizedTargets ? { allowedTargets: normalizedTargets } : {}),
    createdAt,
    expiresAt,
    consumed: false,
  };
}

function verifyPersistentApprovalTokenInternal(
  explicitStateDir: string | undefined,
  token: string,
  planHash: string,
  requestedTargets: string[] | undefined,
  nowMs: number,
  consume: boolean
): PersistentTokenVerifyResult {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, reason: 'token_not_found' };
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !HEX_64_RE.test(parts[0]!) || !HEX_64_RE.test(parts[1]!)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const nonceHex = parts[0]!.toLowerCase();
  const sigHex = parts[1]!.toLowerCase();
  const actualSigBuf = Buffer.from(sigHex, 'hex');

  const stateDir = resolveControlStateDir(explicitStateDir);
  const signingKey = readConsentSigningKeyIfPresent(stateDir);
  if (!signingKey) {
    const dummyKey = crypto.randomBytes(32);
    const dummySig = crypto.createHmac('sha256', dummyKey).update(nonceHex, 'utf8').digest();
    crypto.timingSafeEqual(dummySig, actualSigBuf);
    return { valid: false, reason: 'invalid_signature' };
  }

  const entries = readTokenStoreEntries(stateDir, signingKey);
  if (!entries) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const idx = entries.findIndex((e) => e.nonceHex.toLowerCase() === nonceHex);
  if (idx < 0) {
    const dummySig = crypto.createHmac('sha256', signingKey).update(nonceHex, 'utf8').digest();
    crypto.timingSafeEqual(dummySig, actualSigBuf);
    return { valid: false, reason: 'invalid_signature' };
  }

  const record = entries[idx]!;
  const expectedPayload = computePersistentTokenPayload(
    record.nonceHex,
    record.planHash,
    record.createdAt,
    record.expiresAt,
    record.allowedTargets
  );
  const expectedSigBuf = crypto.createHmac('sha256', signingKey).update(expectedPayload, 'utf8').digest();
  if (
    expectedSigBuf.length !== actualSigBuf.length ||
    !crypto.timingSafeEqual(expectedSigBuf, actualSigBuf)
  ) {
    return { valid: false, reason: 'invalid_signature' };
  }

  if (record.consumed) {
    return { valid: false, reason: 'token_already_consumed' };
  }

  if (nowMs > record.expiresAt) {
    return { valid: false, reason: 'token_expired' };
  }

  // Wrong planHash does NOT consume token (mirrors daemon approval-token.ts:133-136)
  if (record.planHash !== planHash) {
    return { valid: false, reason: 'plan_hash_mismatch' };
  }

  if (record.allowedTargets && record.allowedTargets.length > 0 && requestedTargets) {
    const allowedSet = new Set(record.allowedTargets);
    for (const reqTarget of requestedTargets) {
      if (!allowedSet.has(reqTarget.trim())) {
        return { valid: false, reason: 'target_scope_mismatch' };
      }
    }
  }

  if (consume) {
    const updatedEntries = entries.map((item, i) =>
      i === idx ? { ...item, consumed: true } : item
    );
    writeTokenStoreEntries(stateDir, signingKey, updatedEntries, nowMs);
  }
  return { valid: true };
}

export function verifyPersistentApprovalToken(
  explicitStateDir: string | undefined,
  token: string,
  planHash: string,
  requestedTargets?: string[] | undefined,
  nowMs = Date.now()
): PersistentTokenVerifyResult {
  return verifyPersistentApprovalTokenInternal(
    explicitStateDir,
    token,
    planHash,
    requestedTargets,
    nowMs,
    false
  );
}

export function verifyAndConsumePersistentApprovalToken(
  explicitStateDir: string | undefined,
  token: string,
  planHash: string,
  requestedTargets?: string[] | undefined,
  nowMs = Date.now()
): PersistentTokenVerifyResult {
  return verifyPersistentApprovalTokenInternal(
    explicitStateDir,
    token,
    planHash,
    requestedTargets,
    nowMs,
    true
  );
}
