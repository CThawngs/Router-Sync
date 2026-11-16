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

export function getGrantFilePath(stateDir?: string): string {
  const dir = stateDir || process.env.ROUTERSYNC_STATE_DIR || getStateDir();
  return path.join(dir, GRANT_FILE_NAME);
}

export type GrantValidationResult =
  | { valid: true; grant: ApplyGrant }
  | {
      valid: false;
      reason:
        | 'grant-invalid'
        | 'grant-expired'
        | 'grant-secret-missing'
        | 'grant-secret-wrong'
        | 'grant-mac-invalid';
      notFound?: boolean;
    };

export function grantCanonical(grant: ApplyGrant): string {
  return JSON.stringify({
    version: grant.version,
    id: grant.id,
    combos: grant.combos,
    agents: grant.agents,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
  });
}

export function generateGrantSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function createGrantFile(grant: ApplyGrant, secret: string): GrantFile {
  const salt = crypto.randomBytes(16).toString('hex');
  const secretHash = crypto.scryptSync(secret, salt + ':hash', 64).toString('hex');
  const macKey = crypto.scryptSync(secret, salt + ':mac', 32);
  const mac = crypto.createHmac('sha256', macKey).update(grantCanonical(grant)).digest('hex');
  return { ...grant, salt, secretHash, mac };
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verifyGrantSecret(
  raw: Record<string, unknown>,
  grant: ApplyGrant,
  secret: string | undefined
): GrantValidationResult | null {
  const { salt, secretHash, mac } = raw;
  if (typeof salt !== 'string' || typeof secretHash !== 'string' || typeof mac !== 'string') {
    return { valid: false, reason: 'grant-secret-missing' };
  }
  if (secret === undefined || secret === '') {
    return { valid: false, reason: 'grant-secret-missing' };
  }
  const computedHash = crypto.scryptSync(secret, salt + ':hash', 64).toString('hex');
  if (!safeEqualHex(computedHash, secretHash)) {
    return { valid: false, reason: 'grant-secret-wrong' };
  }
  const macKey = crypto.scryptSync(secret, salt + ':mac', 32);
  const computedMac = crypto.createHmac('sha256', macKey).update(grantCanonical(grant)).digest('hex');
  if (!safeEqualHex(computedMac, mac)) {
    return { valid: false, reason: 'grant-mac-invalid' };
  }
  return null;
}

export function validateGrantFile(
  filePath: string,
  secret?: string,
  options?: { requireSecret?: boolean }
): GrantValidationResult {
  if (!fs.existsSync(filePath)) {
    return { valid: false, reason: 'grant-invalid', notFound: true };
  }

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { valid: false, reason: 'grant-invalid' };
  }

  if (!raw || typeof raw !== 'object') {
    return { valid: false, reason: 'grant-invalid' };
  }

  if (raw.version !== 1) {
    return { valid: false, reason: 'grant-invalid' };
  }

  if (typeof raw.id !== 'string' || !/^[0-9a-f]+$/i.test(raw.id)) {
    return { valid: false, reason: 'grant-invalid' };
  }

  if (!Array.isArray(raw.combos) || raw.combos.length === 0) {
    return { valid: false, reason: 'grant-invalid' };
  }

  for (const c of raw.combos) {
    if (typeof c !== 'string' || !/^test-\d+$/.test(c)) {
      return { valid: false, reason: 'grant-invalid' };
    }
  }

  if (!Array.isArray(raw.agents)) {
    return { valid: false, reason: 'grant-invalid' };
  }

  for (const a of raw.agents) {
    if (typeof a !== 'string' || !['hermes', 'dsh'].includes(a)) {
      return { valid: false, reason: 'grant-invalid' };
    }
  }

  if (typeof raw.createdAt !== 'string' || isNaN(Date.parse(raw.createdAt))) {
    return { valid: false, reason: 'grant-invalid' };
  }

  if (typeof raw.expiresAt !== 'string' || isNaN(Date.parse(raw.expiresAt))) {
    return { valid: false, reason: 'grant-invalid' };
  }

  const createdMs = new Date(raw.createdAt).getTime();
  const expiresMs = new Date(raw.expiresAt).getTime();
  const durationMs = expiresMs - createdMs;

  // Max grant lifetime is 8 hours (with 1s clock tolerance for test suites)
  const maxAllowedDurationMs = 8 * 3600 * 1000 + 1000;
  if (durationMs <= 0 || durationMs > maxAllowedDurationMs) {
    return { valid: false, reason: 'grant-invalid' };
  }

  const now = Date.now();
  if (expiresMs - now > maxAllowedDurationMs) {
    return { valid: false, reason: 'grant-invalid' };
  }

  if (expiresMs <= now) {
    return { valid: false, reason: 'grant-expired' };
  }

  const grant: ApplyGrant = {
    version: 1,
    id: raw.id,
    combos: raw.combos,
    agents: raw.agents,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
  };

  if (options?.requireSecret !== false) {
    const secretFailure = verifyGrantSecret(raw, grant, secret);
    if (secretFailure) {
      return secretFailure;
    }
  }

  return { valid: true, grant };
}

export function resolveGrantSecret(): string | undefined {
  const fromEnv = process.env.ROUTERSYNC_GRANT_SECRET;
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return fromEnv;
  }
  if (!process.stdin.isTTY) {
    return undefined;
  }
  // Hidden TTY prompt: raw mode, byte-by-byte via readSync, echo '*'.
  const fd = 0;
  const prevRaw = typeof (process.stdin as { setRawMode?: unknown }).setRawMode === 'function'
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

export function checkGrantScope(
  grant: ApplyGrant,
  requiredCombos: string[],
  requiredAgents?: string[]
): { valid: true } | { valid: false; reason: 'grant-scope' } {
  for (const combo of requiredCombos) {
    if (!grant.combos.includes(combo)) {
      return { valid: false, reason: 'grant-scope' };
    }
  }

  if (requiredAgents && requiredAgents.length > 0) {
    for (const agent of requiredAgents) {
      if (!grant.agents.includes(agent)) {
        return { valid: false, reason: 'grant-scope' };
      }
    }
  }

  return { valid: true };
}
