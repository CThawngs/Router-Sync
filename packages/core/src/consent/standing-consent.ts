/**
 * packages/core/src/consent/standing-consent.ts
 *
 * Standing Consent policy engine (`<stateDir>/standing-consent.json`, Phục vụ: S3, S4, S9):
 *  - Default empty policy `[]` when absent (zero hardcoded `^test-\d+$`)
 *  - Canonical target grammar (`router:<routerId>/<comboName>` | `harness:<harnessId>`)
 *  - Rejects wildcards and `report-only` / unknown harnesses
 *  - 30-day default TTL (max 90 days) + constant-time HMAC-SHA256 verification
 *  - Enforces C45 §3.2 promotion gate at both grant time and runtime execution
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHarnessCapability } from '../harness/matrix.js';
import { atomicWriteFileSync } from '../paths/atomic.js';
import { assertEligibleForAutoSafe, findVerifiedProposeReceipt } from './apply-history.js';
import { readFreezeState } from './freeze.js';
import {
  canonicalJsonStringify,
  computeHmacSha256Hex,
  ensureConsentSigningKey,
  readConsentSigningKeyIfPresent,
  verifyHmacSha256Hex,
} from './signing.js';
import {
  type AuthorizeTargetWriteResult,
  type ConsentLevel,
  ConsentValidationError,
  DEFAULT_CONSENT_TTL_DAYS,
  MAX_CONSENT_TTL_DAYS,
  type ParsedTargetScope,
  type ReadStandingConsentResult,
  type StandingConsentEntry,
  type StandingConsentEntryView,
  type StandingConsentPolicyFile,
  resolveControlStateDir,
} from './types.js';

export const STANDING_CONSENT_FILENAME = 'standing-consent.json';

const ROUTER_TARGET_RE =
  /^router:([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/;
const HARNESS_TARGET_RE = /^harness:([a-z0-9][a-z0-9-]{0,31})$/;
const ALLOWED_LEVELS = new Set<ConsentLevel>(['propose', 'auto-safe', 'off']);

/**
 * Parses and validates a canonical target scope identifier.
 * Rejects wildcards (`WILDCARD_TARGET_FORBIDDEN`) and non-writable harnesses (`TARGET_NOT_WRITABLE`).
 */
export function parseTargetScope(rawTarget: string): ParsedTargetScope {
  if (typeof rawTarget !== 'string') {
    throw new ConsentValidationError('INVALID_TARGET_SYNTAX', 'Target scope must be a string.');
  }
  const trimmed = rawTarget.trim();
  if (trimmed.includes('*')) {
    throw new ConsentValidationError(
      'WILDCARD_TARGET_FORBIDDEN',
      `Wildcard target '${trimmed}' is forbidden; specify explicit router:<id>/<combo> or harness:<id>.`
    );
  }

  const routerMatch = ROUTER_TARGET_RE.exec(trimmed);
  if (routerMatch) {
    const routerId = routerMatch[1]!;
    const comboName = routerMatch[2]!;
    return {
      target: `router:${routerId}/${comboName}`,
      targetKind: 'router',
      routerId,
      comboName,
    };
  }

  const harnessMatch = HARNESS_TARGET_RE.exec(trimmed);
  if (harnessMatch) {
    const harnessId = harnessMatch[1]!;
    const cap = getHarnessCapability(harnessId);
    if (!cap || cap.directionAMode !== 'write-adapter') {
      throw new ConsentValidationError(
        'TARGET_NOT_WRITABLE',
        `Harness '${harnessId}' does not support verified lossless write-adapter mode.`
      );
    }
    return {
      target: `harness:${harnessId}`,
      targetKind: 'harness',
      harnessId,
    };
  }

  throw new ConsentValidationError(
    'INVALID_TARGET_SYNTAX',
    `Invalid target '${trimmed}'. Expected 'router:<routerId>/<comboName>' or 'harness:<harnessId>'.`
  );
}

function isValidConsentEntryShape(item: unknown): item is StandingConsentEntry {
  if (!item || typeof item !== 'object') return false;
  const e = item as Record<string, unknown>;
  if (typeof e['target'] !== 'string') return false;
  if (e['targetKind'] !== 'router' && e['targetKind'] !== 'harness') return false;
  if (!ALLOWED_LEVELS.has(e['level'] as ConsentLevel)) return false;
  if (typeof e['grantedAt'] !== 'string' || typeof e['expiresAt'] !== 'string') return false;
  if (e['grantedBy'] !== 'interactive-tty') return false;
  try {
    const parsed = parseTargetScope(e['target']);
    if (parsed.target !== e['target'] || parsed.targetKind !== e['targetKind']) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Strictly read-only load of `<stateDir>/standing-consent.json`.
 * Never creates files, directories, or `consent-signing.key` (preserves AT-157 & M7).
 */
export function readStandingConsent(
  explicitStateDir?: string | undefined,
  nowMs = Date.now()
): ReadStandingConsentResult {
  const stateDir = resolveControlStateDir(explicitStateDir);
  const consentPath = path.join(stateDir, STANDING_CONSENT_FILENAME);
  if (!fs.existsSync(consentPath)) {
    return {
      present: false,
      valid: true,
      targets: [],
      activeTargets: [],
    };
  }

  const signingKey = readConsentSigningKeyIfPresent(stateDir);
  if (!signingKey) {
    return {
      present: true,
      valid: false,
      errorCode: 'CONSENT_HMAC_INVALID',
      targets: [],
      activeTargets: [],
    };
  }

  try {
    const raw = fs.readFileSync(consentPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed['version'] !== 1 ||
      typeof parsed['policyId'] !== 'string' ||
      typeof parsed['updatedAt'] !== 'string' ||
      !Array.isArray(parsed['targets']) ||
      typeof parsed['hmacSha256'] !== 'string'
    ) {
      return {
        present: true,
        valid: false,
        errorCode: 'CONSENT_SCHEMA_INVALID',
        targets: [],
        activeTargets: [],
      };
    }

    const rawTargets = parsed['targets'] as unknown[];
    if (!rawTargets.every(isValidConsentEntryShape)) {
      return {
        present: true,
        valid: false,
        errorCode: 'CONSENT_SCHEMA_INVALID',
        targets: [],
        activeTargets: [],
      };
    }

    const canonicalPayload = canonicalJsonStringify({
      version: 1,
      policyId: parsed['policyId'],
      updatedAt: parsed['updatedAt'],
      targets: rawTargets,
    });

    if (!verifyHmacSha256Hex(signingKey, canonicalPayload, parsed['hmacSha256'])) {
      return {
        present: true,
        valid: false,
        errorCode: 'CONSENT_HMAC_INVALID',
        targets: [],
        activeTargets: [],
      };
    }

    const entries = rawTargets as StandingConsentEntry[];
    const views: StandingConsentEntryView[] = entries.map((entry) => {
      const expMs = Date.parse(entry.expiresAt);
      const expired = !Number.isFinite(expMs) || expMs <= nowMs;
      return {
        ...entry,
        expired,
      };
    });

    const activeTargets = views
      .filter((v) => !v.expired && (v.level === 'propose' || v.level === 'auto-safe'))
      .map(({ expired: _expired, ...rest }) => rest);

    return {
      present: true,
      valid: true,
      policyId: parsed['policyId'],
      updatedAt: parsed['updatedAt'],
      targets: views,
      activeTargets,
    };
  } catch {
    return {
      present: true,
      valid: false,
      errorCode: 'CONSENT_SCHEMA_INVALID',
      targets: [],
      activeTargets: [],
    };
  }
}

export interface UpsertStandingConsentInput {
  target: string;
  level: ConsentLevel;
  ttlDays?: number | undefined;
  nowMs?: number | undefined;
}

/**
 * Grants or updates a standing consent target entry atomically with HMAC signing.
 * Enforces C45 §3.2 promotion gate (`assertEligibleForAutoSafe`) when `level === 'auto-safe'`.
 */
export function upsertStandingConsentTarget(
  explicitStateDir: string | undefined,
  input: UpsertStandingConsentInput
): StandingConsentEntry {
  const stateDir = resolveControlStateDir(explicitStateDir);
  const scope = parseTargetScope(input.target);
  if (!ALLOWED_LEVELS.has(input.level)) {
    throw new ConsentValidationError(
      'INVALID_CONSENT_LEVEL',
      `Invalid consent level '${String(input.level)}'. Expected 'propose', 'auto-safe', or 'off'.`
    );
  }

  const ttlDays = input.ttlDays ?? DEFAULT_CONSENT_TTL_DAYS;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > MAX_CONSENT_TTL_DAYS) {
    throw new ConsentValidationError(
      'INVALID_CONSENT_TTL',
      `Consent TTL days must be between 1 and ${MAX_CONSENT_TTL_DAYS} (got ${String(ttlDays)}).`
    );
  }

  let verifiedProposeReceiptId: string | undefined;
  if (input.level === 'auto-safe') {
    const receipt = assertEligibleForAutoSafe(stateDir, scope.target);
    verifiedProposeReceiptId = receipt.receiptId;
  }

  const nowMs = input.nowMs ?? Date.now();
  const grantedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlDays * 24 * 3600 * 1000).toISOString();

  const entry: StandingConsentEntry = {
    target: scope.target,
    targetKind: scope.targetKind,
    ...(scope.routerId !== undefined ? { routerId: scope.routerId } : {}),
    ...(scope.comboName !== undefined ? { comboName: scope.comboName } : {}),
    ...(scope.harnessId !== undefined ? { harnessId: scope.harnessId } : {}),
    level: input.level,
    grantedAt,
    expiresAt,
    grantedBy: 'interactive-tty',
    ...(verifiedProposeReceiptId !== undefined ? { verifiedProposeReceiptId } : {}),
  };

  const signingKey = ensureConsentSigningKey(stateDir);
  const current = readStandingConsent(stateDir, nowMs);
  const existingEntries: StandingConsentEntry[] = current.valid
    ? current.targets.map(({ expired: _expired, ...rest }) => rest)
    : [];

  const filtered = existingEntries.filter((e) => e.target !== scope.target);
  const nextTargets = [...filtered, entry].sort((a, b) => a.target.localeCompare(b.target));
  const policyId = current.valid && current.policyId ? current.policyId : crypto.randomBytes(16).toString('hex');
  const updatedAt = grantedAt;

  const canonicalPayload = canonicalJsonStringify({
    version: 1,
    policyId,
    updatedAt,
    targets: nextTargets,
  });
  const hmacSha256 = computeHmacSha256Hex(signingKey, canonicalPayload);

  const policyFile: StandingConsentPolicyFile = {
    version: 1,
    policyId,
    updatedAt,
    targets: nextTargets,
    hmacSha256,
  };
  const consentPath = path.join(stateDir, STANDING_CONSENT_FILENAME);
  atomicWriteFileSync(consentPath, `${JSON.stringify(policyFile, null, 2)}\n`, { mode: 0o600 });
  return entry;
}

/**
 * Revokes standing consent for a single canonical target or `--all`.
 */
export function revokeStandingConsentTarget(
  explicitStateDir: string | undefined,
  targetOrAll: string,
  nowMs = Date.now()
): StandingConsentPolicyFile {
  const stateDir = resolveControlStateDir(explicitStateDir);
  const signingKey = ensureConsentSigningKey(stateDir);
  const current = readStandingConsent(stateDir, nowMs);
  const existingEntries: StandingConsentEntry[] = current.valid
    ? current.targets.map(({ expired: _expired, ...rest }) => rest)
    : [];

  const trimmed = targetOrAll.trim();
  let nextTargets: StandingConsentEntry[];
  if (trimmed === '--all' || trimmed === 'all') {
    nextTargets = [];
  } else {
    const scope = parseTargetScope(trimmed);
    nextTargets = existingEntries.filter((e) => e.target !== scope.target);
  }

  const policyId = current.valid && current.policyId ? current.policyId : crypto.randomBytes(16).toString('hex');
  const updatedAt = new Date(nowMs).toISOString();
  const canonicalPayload = canonicalJsonStringify({
    version: 1,
    policyId,
    updatedAt,
    targets: nextTargets,
  });
  const hmacSha256 = computeHmacSha256Hex(signingKey, canonicalPayload);

  const policyFile: StandingConsentPolicyFile = {
    version: 1,
    policyId,
    updatedAt,
    targets: nextTargets,
    hmacSha256,
  };
  const consentPath = path.join(stateDir, STANDING_CONSENT_FILENAME);
  atomicWriteFileSync(consentPath, `${JSON.stringify(policyFile, null, 2)}\n`, { mode: 0o600 });
  return policyFile;
}

/**
 * Evaluates fail-closed runtime write authorization for a single canonical target:
 *  1. Emergency freeze (`WRITE_FROZEN`)
 *  2. Target grammar validation
 *  3. Standing consent HMAC & schema integrity (`CONSENT_HMAC_INVALID` / `CONSENT_SCHEMA_INVALID`)
 *  4. Presence & `'off'` check (`UNAUTHORIZED_TARGET` / `TARGET_CONSENT_OFF`)
 *  5. Expiry check (`CONSENT_EXPIRED`)
 *  6. Defense-in-depth `auto-safe` receipt re-verification (`AUTO_SAFE_RECEIPT_MISSING`)
 */
export function authorizeTargetWrite(
  explicitStateDir: string | undefined,
  target: string,
  nowMs = Date.now()
): AuthorizeTargetWriteResult {
  const stateDir = resolveControlStateDir(explicitStateDir);
  const freeze = readFreezeState(stateDir);
  if (freeze.frozen) {
    return {
      authorized: false,
      errorCode: 'WRITE_FROZEN',
      message: `Writes are emergency-frozen (${freeze.reason ?? 'frozen'}).`,
    };
  }

  let scope: ParsedTargetScope;
  try {
    scope = parseTargetScope(target);
  } catch (err) {
    if (err instanceof ConsentValidationError) {
      return {
        authorized: false,
        errorCode: err.code,
        message: err.message,
      };
    }
    return {
      authorized: false,
      errorCode: 'INVALID_TARGET_SYNTAX',
      message: String(err),
    };
  }

  const consent = readStandingConsent(stateDir, nowMs);
  if (!consent.valid) {
    const code = consent.errorCode ?? 'CONSENT_HMAC_INVALID';
    return {
      authorized: false,
      errorCode: code,
      message: `Standing consent policy failed integrity verification (${code}).`,
    };
  }

  const found = consent.targets.find((t) => t.target === scope.target);
  if (!found) {
    return {
      authorized: false,
      errorCode: 'UNAUTHORIZED_TARGET',
      message: `Target '${scope.target}' has no standing consent (default policy is []).`,
    };
  }

  if (found.level === 'off') {
    return {
      authorized: false,
      errorCode: 'TARGET_CONSENT_OFF',
      message: `Target '${scope.target}' is explicitly set to 'off'.`,
    };
  }

  if (found.expired) {
    return {
      authorized: false,
      errorCode: 'CONSENT_EXPIRED',
      message: `Standing consent for '${scope.target}' expired at ${found.expiresAt}.`,
    };
  }

  if (found.level === 'auto-safe') {
    const verifiedReceipt = findVerifiedProposeReceipt(stateDir, scope.target);
    if (!verifiedReceipt) {
      return {
        authorized: false,
        errorCode: 'AUTO_SAFE_RECEIPT_MISSING',
        message: `Runtime auto-safe check failed for '${scope.target}': apply-history.json is missing, tampered, or lacks a verified propose receipt.`,
      };
    }
  }

  const { expired: _expired, ...cleanEntry } = found;
  return {
    authorized: true,
    level: cleanEntry.level as 'propose' | 'auto-safe',
    entry: cleanEntry,
  };
}

/**
 * Strictly read-only helper returning the set of router combo names currently covered
 * by active (`propose` or `auto-safe`) standing consent. Returns empty `Set` (`[]`) when absent.
 */
export function getConsentedRouterCombos(
  explicitStateDir?: string | undefined,
  routerId?: string | undefined,
  nowMs = Date.now()
): Set<string> {
  const stateDir = resolveControlStateDir(explicitStateDir);
  const consent = readStandingConsent(stateDir, nowMs);
  const result = new Set<string>();
  if (!consent.valid) {
    return result;
  }
  const normalizedRouter = routerId?.trim();
  for (const entry of consent.activeTargets) {
    if (entry.targetKind !== 'router' || !entry.comboName) continue;
    if (normalizedRouter && entry.routerId !== normalizedRouter) {
      // Allow matching either configured router id (e.g. 'nine') or adapter name ('9router') if caller passes router filter
      continue;
    }
    result.add(entry.comboName);
  }
  return result;
}
