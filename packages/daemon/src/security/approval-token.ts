/**
 * packages/daemon/src/security/approval-token.ts
 *
 * Human Approval Token Management (Phase 3b / T3-DAEMON-SEC / M2-01 / C45-WP4 / SPEC §03).
 *
 * Invariant: AI/MCP clients can never approve changes; only human-granted
 * HMAC-SHA256 signed tokens (`<nonceHex>.<sigHex>`) tied to a matching planHash
 * can authorize write actions. Tokens are single-use nonces with strict TTL.
 *
 * Cross-process mirroring (C45-WP4): When `ROUTERSYNC_STATE_DIR` points to an
 * existing state directory, issued tokens are also mirrored/consumed atomically
 * in `<stateDir>/approval-tokens.json` using `<stateDir>/consent-signing.key`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ApprovalTokenRecord {
  token: string;
  planHash: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

interface StoredApprovalNonceRecord {
  nonceHex: string;
  sigHex: string;
  planHash: string;
  allowedTargets?: string[] | undefined;
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
const CONSENT_SIGNING_KEY_FILE = 'consent-signing.key';
const APPROVAL_TOKENS_FILE = 'approval-tokens.json';
const MAX_PERSISTED_TOKENS = 250;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function atomicWriteStateFile(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(
    dir,
    `${path.basename(targetPath)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  );
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, targetPath);
}

function resolveExistingStateDir(): string | null {
  const raw = process.env['ROUTERSYNC_STATE_DIR']?.trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
  } catch {
    return null;
  }
  return null;
}

export class ApprovalTokenManager {
  readonly #signingKey: Buffer = crypto.randomBytes(32);
  readonly #tokens = new Map<string, StoredApprovalNonceRecord>();

  #computeCanonicalPayload(
    nonceHex: string,
    planHash: string,
    createdAt: number,
    expiresAt: number,
    allowedTargets?: string[] | undefined
  ): string {
    const suffix =
      allowedTargets && allowedTargets.length > 0
        ? `:${[...allowedTargets].sort().join(',')}`
        : '';
    return `${nonceHex}:${planHash}:${createdAt}:${expiresAt}${suffix}`;
  }

  #readPersistentKeyIfPresent(stateDir: string): Buffer | null {
    const keyPath = path.join(stateDir, CONSENT_SIGNING_KEY_FILE);
    try {
      if (!fs.existsSync(keyPath)) return null;
      const hex = fs.readFileSync(keyPath, 'utf8').trim();
      if (!HEX_64_RE.test(hex)) return null;
      return Buffer.from(hex.toLowerCase(), 'hex');
    } catch {
      return null;
    }
  }

  #ensurePersistentKey(stateDir: string): Buffer {
    const existing = this.#readPersistentKeyIfPresent(stateDir);
    if (existing) return existing;
    const generated = crypto.randomBytes(32);
    const keyPath = path.join(stateDir, CONSENT_SIGNING_KEY_FILE);
    atomicWriteStateFile(keyPath, `${generated.toString('hex')}\n`);
    return generated;
  }

  #readPersistedTokens(stateDir: string, keyBuf: Buffer): StoredApprovalNonceRecord[] | null {
    const storePath = path.join(stateDir, APPROVAL_TOKENS_FILE);
    if (!fs.existsSync(storePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Record<string, unknown>;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        parsed['version'] !== 1 ||
        typeof parsed['updatedAt'] !== 'string' ||
        !Array.isArray(parsed['tokens']) ||
        typeof parsed['hmacSha256'] !== 'string' ||
        !HEX_64_RE.test(parsed['hmacSha256'])
      ) {
        return null;
      }
      const canonical = canonicalJson({
        version: 1,
        updatedAt: parsed['updatedAt'],
        tokens: parsed['tokens'],
      });
      const expectedMac = crypto.createHmac('sha256', keyBuf).update(canonical, 'utf8').digest();
      const actualMac = Buffer.from(parsed['hmacSha256'].toLowerCase(), 'hex');
      if (expectedMac.length !== actualMac.length || !crypto.timingSafeEqual(expectedMac, actualMac)) {
        return null;
      }
      return parsed['tokens'] as StoredApprovalNonceRecord[];
    } catch {
      return null;
    }
  }

  #writePersistedTokens(
    stateDir: string,
    keyBuf: Buffer,
    tokens: StoredApprovalNonceRecord[]
  ): void {
    const bounded = tokens.slice(-MAX_PERSISTED_TOKENS);
    const updatedAt = new Date().toISOString();
    const canonical = canonicalJson({
      version: 1,
      updatedAt,
      tokens: bounded,
    });
    const hmacSha256 = crypto.createHmac('sha256', keyBuf).update(canonical, 'utf8').digest('hex');
    atomicWriteStateFile(
      path.join(stateDir, APPROVAL_TOKENS_FILE),
      `${JSON.stringify({ version: 1, updatedAt, tokens: bounded, hmacSha256 }, null, 2)}\n`
    );
  }

  #signPayloadBuf(payload: string, keyBuf: Buffer): Buffer {
    return crypto.createHmac('sha256', keyBuf).update(payload, 'utf8').digest();
  }

  issueToken(planHash: string, ttlMs = DEFAULT_TTL_MS): ApprovalTokenRecord {
    const nonceHex = crypto.randomBytes(32).toString('hex');
    const createdAt = Date.now();
    const expiresAt = createdAt + ttlMs;
    const stateDir = resolveExistingStateDir();
    const activeKey = stateDir ? this.#ensurePersistentKey(stateDir) : this.#signingKey;

    const payload = this.#computeCanonicalPayload(nonceHex, planHash, createdAt, expiresAt);
    const sigHex = this.#signPayloadBuf(payload, activeKey).toString('hex');

    const stored: StoredApprovalNonceRecord = {
      nonceHex,
      sigHex,
      planHash,
      createdAt,
      expiresAt,
      consumed: false,
    };
    this.#tokens.set(nonceHex, stored);

    if (stateDir) {
      try {
        const existing = this.#readPersistedTokens(stateDir, activeKey) ?? [];
        this.#writePersistedTokens(stateDir, activeKey, [...existing, stored]);
      } catch {
        // Fallback to in-memory registry if state directory is read-only
      }
    }

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

    const stateDir = resolveExistingStateDir();
    const persistentKey = stateDir ? this.#readPersistentKeyIfPresent(stateDir) : null;
    const activeKey = persistentKey ?? this.#signingKey;

    let diskTokens: StoredApprovalNonceRecord[] | null = null;
    let diskIdx = -1;
    if (stateDir && persistentKey) {
      diskTokens = this.#readPersistedTokens(stateDir, persistentKey);
      if (diskTokens) {
        diskIdx = diskTokens.findIndex((t) => t.nonceHex.toLowerCase() === nonceHex);
      }
    }

    const memRecord = this.#tokens.get(nonceHex);
    const diskRecord = diskIdx >= 0 && diskTokens ? diskTokens[diskIdx] : undefined;
    const record = diskRecord ?? memRecord;

    // Step 3: Constant-time HMAC verification BEFORE any state mutation
    if (!record) {
      const dummySigBuf = this.#signPayloadBuf(nonceHex, activeKey);
      crypto.timingSafeEqual(dummySigBuf, actualSigBuf);
      return { valid: false, reason: 'invalid_signature' };
    }

    const expectedPayload = this.#computeCanonicalPayload(
      record.nonceHex,
      record.planHash,
      record.createdAt,
      record.expiresAt,
      record.allowedTargets
    );
    const expectedSigBuf = this.#signPayloadBuf(expectedPayload, activeKey);
    if (
      expectedSigBuf.length !== actualSigBuf.length ||
      !crypto.timingSafeEqual(expectedSigBuf, actualSigBuf)
    ) {
      return { valid: false, reason: 'invalid_signature' };
    }

    // Step 4: Replay check across both memory and persistent ledger
    if (record.consumed || memRecord?.consumed || diskRecord?.consumed) {
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

    // Step 7: Atomically mark consumed in memory and persistent store
    if (memRecord) {
      memRecord.consumed = true;
    } else {
      this.#tokens.set(nonceHex, { ...record, consumed: true });
    }

    if (stateDir && persistentKey && diskTokens && diskIdx >= 0) {
      try {
        const nextDisk = diskTokens.map((item, idx) =>
          idx === diskIdx ? { ...item, consumed: true } : item
        );
        this.#writePersistedTokens(stateDir, persistentKey, nextDisk);
      } catch {
        // ignore read-only fs errors
      }
    }

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
    const stateDir = resolveExistingStateDir();
    if (stateDir) {
      const storePath = path.join(stateDir, APPROVAL_TOKENS_FILE);
      try {
        if (fs.existsSync(storePath)) {
          fs.unlinkSync(storePath);
        }
      } catch {
        // ignore cleanup errors
      }
    }
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
