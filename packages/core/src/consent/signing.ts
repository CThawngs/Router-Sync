/**
 * packages/core/src/consent/signing.ts
 *
 * Local CSPRNG HMAC-SHA256 signing & constant-time verification for
 * standing-consent.json, apply-history.json, and approval-tokens.json.
 *
 * Invariant: Read-only checks MUST NEVER create `consent-signing.key` or `stateDir`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../paths/atomic.js';

export const CONSENT_SIGNING_KEY_FILENAME = 'consent-signing.key';
const HEX_64_RE = /^[0-9a-f]{64}$/i;

/**
 * Deterministic recursive key-sorted JSON serialization for HMAC signing.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(record[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Strictly read-only lookup of `<stateDir>/consent-signing.key`.
 * Returns `null` if missing or malformed; NEVER creates files or directories.
 */
export function readConsentSigningKeyIfPresent(stateDir: string): Buffer | null {
  const keyPath = path.join(path.resolve(stateDir), CONSENT_SIGNING_KEY_FILENAME);
  try {
    if (!fs.existsSync(keyPath)) {
      return null;
    }
    const raw = fs.readFileSync(keyPath, 'utf8').trim();
    if (!HEX_64_RE.test(raw)) {
      return null;
    }
    return Buffer.from(raw.toLowerCase(), 'hex');
  } catch {
    return null;
  }
}

/**
 * Ensures `<stateDir>/consent-signing.key` exists (32 CSPRNG bytes as 64-char hex, mode 0o600).
 * Call ONLY during explicit write operations!
 */
export function ensureConsentSigningKey(stateDir: string): Buffer {
  const existing = readConsentSigningKeyIfPresent(stateDir);
  if (existing) {
    return existing;
  }
  const keyBuf = crypto.randomBytes(32);
  const keyPath = path.join(path.resolve(stateDir), CONSENT_SIGNING_KEY_FILENAME);
  atomicWriteFileSync(keyPath, `${keyBuf.toString('hex')}\n`, { mode: 0o600 });
  return keyBuf;
}

export function computeHmacSha256Hex(signingKey: Buffer, canonicalPayload: string): string {
  return crypto.createHmac('sha256', signingKey).update(canonicalPayload, 'utf8').digest('hex');
}

export function verifyHmacSha256Hex(
  signingKey: Buffer,
  canonicalPayload: string,
  actualHex: string
): boolean {
  if (typeof actualHex !== 'string' || !HEX_64_RE.test(actualHex)) {
    return false;
  }
  const expectedBuf = crypto.createHmac('sha256', signingKey).update(canonicalPayload, 'utf8').digest();
  const actualBuf = Buffer.from(actualHex.toLowerCase(), 'hex');
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
