import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getStateDir } from '@routersync/core';

export interface ApplyGrant {
  version: 1;
  id: string;
  combos: string[];
  agents: string[];
  createdAt: string;
  expiresAt: string;
}

export interface GrantFile extends ApplyGrant {
  salt: string;
  secretHash: string;
  mac: string;
}

export const GRANT_FILE_NAME = 'apply-grant.json';

const SALT_HEX_RE = /^[0-9a-f]{32}$/i;
const SECRET_HASH_HEX_RE = /^[0-9a-f]{128}$/i;
const MAC_HEX_RE = /^[0-9a-f]{64}$/i;
const COMBO_NAME_RE = /^test-\d+$/;
const ALLOWED_AGENTS = new Set(['hermes', 'dsh']);
const MAX_ALLOWED_DURATION_MS = 8 * 3600 * 1000 + 1000;

export function getGrantFilePath(stateDir?: string): string {
  const dir = stateDir || process.env.ROUTERSYNC_STATE_DIR || getStateDir();
  return path.join(dir, GRANT_FILE_NAME);
}

export type GrantFailureReason =
  | 'grant-invalid'
  | 'grant-expired'
  | 'grant-secret-missing'
  | 'grant-secret-wrong'
  | 'grant-mac-invalid';

export type GrantValidationResult =
  | { valid: true; grant: ApplyGrant }
  | {
      valid: false;
      reason: GrantFailureReason;
      notFound?: boolean;
    };

export type ReadGrantResult =
  | { ok: true; grant: ApplyGrant; grantFile: GrantFile }
  | { ok: false; reason: 'grant-invalid' | 'grant-expired'; notFound?: boolean };

export type VerifyGrantSecretResult =
  | { ok: true; valid: true }
  | {
      ok: false;
      valid: false;
      reason: 'grant-secret-missing' | 'grant-invalid' | 'grant-secret-wrong' | 'grant-mac-invalid';
    };

export function grantCanonical(
  grant: ApplyGrant,
  authFields?: { salt: string; secretHash: string }
): string {
  return JSON.stringify({
    version: grant.version,
    id: grant.id,
    combos: grant.combos,
    agents: grant.agents,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    ...(authFields ? { salt: authFields.salt, secretHash: authFields.secretHash } : {}),
  });
}

export function generateGrantSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function createGrantFile(grant: ApplyGrant, secret: string): GrantFile {
  const salt = crypto.randomBytes(16).toString('hex');
  const secretHash = crypto.scryptSync(secret, salt + ':hash', 64).toString('hex');
  const macKey = crypto.scryptSync(secret, salt + ':mac', 32);
  const mac = crypto
    .createHmac('sha256', macKey)
    .update(grantCanonical(grant, { salt, secretHash }))
    .digest('hex');
  return { ...grant, salt, secretHash, mac };
}

function parseApplyGrantFields(
  raw: Record<string, unknown>
): { ok: true; grant: ApplyGrant } | { ok: false; reason: 'grant-invalid' | 'grant-expired' } {
  if (raw.version !== 1) {
    return { ok: false, reason: 'grant-invalid' };
  }

  if (typeof raw.id !== 'string' || !/^[0-9a-f]+$/i.test(raw.id)) {
    return { ok: false, reason: 'grant-invalid' };
  }

  if (!Array.isArray(raw.combos) || raw.combos.length === 0) {
    return { ok: false, reason: 'grant-invalid' };
  }

  for (const c of raw.combos) {
    if (typeof c !== 'string' || !COMBO_NAME_RE.test(c)) {
      return { ok: false, reason: 'grant-invalid' };
    }
  }

  if (!Array.isArray(raw.agents)) {
    return { ok: false, reason: 'grant-invalid' };
  }

  for (const a of raw.agents) {
    if (typeof a !== 'string' || !ALLOWED_AGENTS.has(a)) {
      return { ok: false, reason: 'grant-invalid' };
    }
  }

  if (typeof raw.createdAt !== 'string' || Number.isNaN(Date.parse(raw.createdAt))) {
    return { ok: false, reason: 'grant-invalid' };
  }

  if (typeof raw.expiresAt !== 'string' || Number.isNaN(Date.parse(raw.expiresAt))) {
    return { ok: false, reason: 'grant-invalid' };
  }

  const createdMs = new Date(raw.createdAt).getTime();
  const expiresMs = new Date(raw.expiresAt).getTime();
  const durationMs = expiresMs - createdMs;

  if (durationMs <= 0 || durationMs > MAX_ALLOWED_DURATION_MS) {
    return { ok: false, reason: 'grant-invalid' };
  }

  const now = Date.now();
  if (expiresMs - now > MAX_ALLOWED_DURATION_MS) {
    return { ok: false, reason: 'grant-invalid' };
  }

  if (expiresMs <= now) {
    return { ok: false, reason: 'grant-expired' };
  }

  return {
    ok: true,
    grant: {
      version: 1,
      id: raw.id,
      combos: raw.combos as string[],
      agents: raw.agents as string[],
      createdAt: raw.createdAt,
      expiresAt: raw.expiresAt,
    },
  };
}

function hasValidCryptoHexFields(raw: Record<string, unknown>): raw is Record<string, unknown> & {
  salt: string;
  secretHash: string;
  mac: string;
} {
  return (
    typeof raw.salt === 'string' &&
    SALT_HEX_RE.test(raw.salt) &&
    typeof raw.secretHash === 'string' &&
    SECRET_HASH_HEX_RE.test(raw.secretHash) &&
    typeof raw.mac === 'string' &&
    MAC_HEX_RE.test(raw.mac)
  );
}

export function readGrant(filePath: string): ReadGrantResult {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'grant-invalid', notFound: true };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { ok: false, reason: 'grant-invalid' };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'grant-invalid' };
  }

  const record = raw as Record<string, unknown>;
  if (!hasValidCryptoHexFields(record)) {
    return { ok: false, reason: 'grant-invalid' };
  }

  const parsed = parseApplyGrantFields(record);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    ok: true,
    grant: parsed.grant,
    grantFile: {
      ...parsed.grant,
      salt: record.salt,
      secretHash: record.secretHash,
      mac: record.mac,
    },
  };
}

export function verifyGrantSecret(
  grantInput: GrantFile | Record<string, unknown>,
  candidateSecret: string | undefined
): VerifyGrantSecretResult {
  if (typeof candidateSecret !== 'string' || candidateSecret.length === 0) {
    return { ok: false, valid: false, reason: 'grant-secret-missing' };
  }

  if (grantInput === null || typeof grantInput !== 'object' || Array.isArray(grantInput)) {
    return { ok: false, valid: false, reason: 'grant-invalid' };
  }

  const raw = grantInput as Record<string, unknown>;
  if (raw.salt === undefined && raw.secretHash === undefined && raw.mac === undefined) {
    return { ok: false, valid: false, reason: 'grant-secret-missing' };
  }

  if (!hasValidCryptoHexFields(raw)) {
    return { ok: false, valid: false, reason: 'grant-invalid' };
  }

  if (
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    !Array.isArray(raw.combos) ||
    !Array.isArray(raw.agents) ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.expiresAt !== 'string'
  ) {
    return { ok: false, valid: false, reason: 'grant-invalid' };
  }

  const grant: ApplyGrant = {
    version: 1,
    id: raw.id,
    combos: raw.combos as string[],
    agents: raw.agents as string[],
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
  };

  const computedHashBuf = crypto.scryptSync(candidateSecret, raw.salt + ':hash', 64);
  const expectedHashBuf = Buffer.from(raw.secretHash, 'hex');
  if (
    computedHashBuf.length !== expectedHashBuf.length ||
    !crypto.timingSafeEqual(computedHashBuf, expectedHashBuf)
  ) {
    return { ok: false, valid: false, reason: 'grant-secret-wrong' };
  }

  const macKey = crypto.scryptSync(candidateSecret, raw.salt + ':mac', 32);
  const expectedMacBuf = Buffer.from(raw.mac, 'hex');
  const computedMacWithAuthBuf = crypto
    .createHmac('sha256', macKey)
    .update(grantCanonical(grant, { salt: raw.salt, secretHash: raw.secretHash }))
    .digest();

  if (
    computedMacWithAuthBuf.length === expectedMacBuf.length &&
    crypto.timingSafeEqual(computedMacWithAuthBuf, expectedMacBuf)
  ) {
    return { ok: true, valid: true };
  }

  // Backward-compatible fallback for grants whose canonical HMAC covered ApplyGrant fields only
  const computedLegacyMacBuf = crypto
    .createHmac('sha256', macKey)
    .update(grantCanonical(grant))
    .digest();
  if (
    computedLegacyMacBuf.length === expectedMacBuf.length &&
    crypto.timingSafeEqual(computedLegacyMacBuf, expectedMacBuf)
  ) {
    return { ok: true, valid: true };
  }

  return { ok: false, valid: false, reason: 'grant-mac-invalid' };
}

export function validateGrantFile(
  filePath: string,
  secret?: string,
  options?: { requireSecret?: boolean }
): GrantValidationResult {
  if (!fs.existsSync(filePath)) {
    return { valid: false, reason: 'grant-invalid', notFound: true };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { valid: false, reason: 'grant-invalid' };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reason: 'grant-invalid' };
  }

  const record = raw as Record<string, unknown>;
  const hasAnyCryptoField =
    record.salt !== undefined || record.secretHash !== undefined || record.mac !== undefined;
  if (hasAnyCryptoField && !hasValidCryptoHexFields(record)) {
    return { valid: false, reason: 'grant-invalid' };
  }

  const parsed = parseApplyGrantFields(record);
  if (!parsed.ok) {
    return { valid: false, reason: parsed.reason };
  }

  if (options?.requireSecret === false) {
    if (!hasValidCryptoHexFields(record)) {
      return { valid: false, reason: 'grant-invalid' };
    }
    return { valid: true, grant: parsed.grant };
  }

  const secretCheck = verifyGrantSecret(record, secret);
  if (!secretCheck.ok) {
    return { valid: false, reason: secretCheck.reason };
  }

  return { valid: true, grant: parsed.grant };
}

export interface ResolveGrantSecretOptions {
  isTTY?: boolean | undefined;
  secretResolver?: (() => string | undefined) | undefined;
}

export function resolveGrantSecret(options?: ResolveGrantSecretOptions): string | undefined {
  if (typeof options?.secretResolver === 'function') {
    const injected = options.secretResolver();
    return typeof injected === 'string' && injected !== '' ? injected : undefined;
  }

  const fromEnv =
    process.env.ROUTERSYNC_GRANT_SECRET || process.env.ROUTERSYNC_APPLY_GRANT_SECRET;
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return fromEnv;
  }

  if (!process.stdin.isTTY || options?.isTTY === false) {
    return undefined;
  }

  // Hidden TTY prompt: raw mode, byte-by-byte via readSync, echo '*'.
  const fd = 0;
  const prevRaw =
    typeof (process.stdin as { setRawMode?: unknown }).setRawMode === 'function'
      ? (process.stdin as { setRawMode: (m: boolean) => void }).setRawMode(true)
      : undefined;
  process.stdout.write('Grant secret: ');
  let secret = '';
  const buf = Buffer.alloc(1);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf.toString('utf8');
      if (ch === '\n' || ch === '\r') break;
      if (ch === '\x03') break; // Ctrl-C
      if (ch === '\x7f' || ch === '\b') {
        secret = secret.slice(0, -1);
        process.stdout.write('\b \b');
      } else {
        secret += ch;
        process.stdout.write('*');
      }
    }
  } finally {
    process.stdout.write('\n');
    if (prevRaw !== undefined) {
      (process.stdin as { setRawMode: (m: boolean) => void }).setRawMode(false);
    }
  }
  return secret === '' ? undefined : secret;
}

export type GrantScopeCheckResult =
  | { valid: true }
  | {
      valid: false;
      reason: 'grant-scope';
      detail: 'grant-scope-combo' | 'grant-scope-agent';
    };

export function checkGrantScope(
  grant: ApplyGrant,
  requiredCombos: string[],
  requiredAgents?: string[]
): GrantScopeCheckResult {
  for (const combo of requiredCombos) {
    if (!grant.combos.includes(combo)) {
      return { valid: false, reason: 'grant-scope', detail: 'grant-scope-combo' };
    }
  }

  if (requiredAgents && requiredAgents.length > 0) {
    for (const agent of requiredAgents) {
      if (!grant.agents.includes(agent)) {
        return { valid: false, reason: 'grant-scope', detail: 'grant-scope-agent' };
      }
    }
  }

  return { valid: true };
}
