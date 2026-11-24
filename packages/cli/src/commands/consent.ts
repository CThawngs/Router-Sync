/**
 * packages/cli/src/commands/consent.ts
 *
 * Implements `routersync consent <grant|status|revoke>` (C45-WP4 §3.3.1, Phục vụ: S3, S4, S9).
 *  - `consent grant`: rejects `--yes`, requires interactive TTY + typed `'consent'`,
 *    enforces C45 §3.2 `auto-safe` promotion gate (`>= 1` verified `propose` receipt),
 *    and writes HMAC-signed `<stateDir>/standing-consent.json` (default 30d TTL).
 *  - `consent status`: strictly read-only (`0` disk writes, `0` key/HMAC leakage).
 *  - `consent revoke`: removes target or clears all targets atomically.
 */

import * as readline from 'node:readline';
import {
  DEFAULT_CONSENT_TTL_DAYS,
  MAX_CONSENT_TTL_DAYS,
  ConsentValidationError,
  assertEligibleForAutoSafe,
  parseTargetScope,
  readFreezeState,
  readStandingConsent,
  resolveControlStateDir,
  revokeStandingConsentTarget,
  upsertStandingConsentTarget,
  type ConsentLevel,
  type StandingConsentEntry,
} from '@routersync/core';

export interface ConsentGrantOptions {
  target?: string | undefined;
  level?: string | undefined;
  days?: number | string | undefined;
  stateDir?: string | undefined;
  yes?: boolean | undefined;
  json?: boolean | undefined;
  /** Programmatic test seam only — never exposed as CLI flag in index.ts */
  isTTY?: boolean | undefined;
  promptFn?: ((promptText: string) => Promise<string>) | undefined;
}

export interface ConsentStatusOptions {
  stateDir?: string | undefined;
  json?: boolean | undefined;
}

export interface ConsentRevokeOptions {
  target?: string | undefined;
  all?: boolean | undefined;
  stateDir?: string | undefined;
  json?: boolean | undefined;
}

function askPrompt(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function sanitizeEntryForOutput(
  entry: StandingConsentEntry & { expired?: boolean | undefined }
): Record<string, unknown> {
  return {
    target: entry.target,
    targetKind: entry.targetKind,
    ...(entry.routerId ? { routerId: entry.routerId } : {}),
    ...(entry.comboName ? { comboName: entry.comboName } : {}),
    ...(entry.harnessId ? { harnessId: entry.harnessId } : {}),
    level: entry.level,
    grantedAt: entry.grantedAt,
    expiresAt: entry.expiresAt,
    ...(entry.expired !== undefined ? { expired: entry.expired } : {}),
    ...(entry.verifiedProposeReceiptId
      ? { verifiedProposeReceiptId: entry.verifiedProposeReceiptId }
      : {}),
  };
}

export async function runConsentGrantCommand(options: ConsentGrantOptions): Promise<void> {
  if (options.yes) {
    console.error('consent grant does not allow --yes');
    console.error('CONSENT_REFUSED reason=yes-flag');
    process.exit(1);
  }

  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    console.error('consent grant requires an interactive TTY');
    console.error('CONSENT_REFUSED reason=no-tty');
    process.exit(1);
  }

  const rawTarget = options.target?.trim() ?? '';
  if (!rawTarget) {
    console.error('consent grant requires --target <router:id/combo|harness:id>');
    console.error('CONSENT_REFUSED reason=missing-target');
    process.exit(1);
  }

  const rawLevel = (options.level ?? 'propose').trim() as ConsentLevel;
  if (rawLevel !== 'propose' && rawLevel !== 'auto-safe' && rawLevel !== 'off') {
    console.error(`Invalid --level '${options.level}'. Expected propose | auto-safe | off.`);
    console.error('CONSENT_REFUSED reason=invalid-level');
    process.exit(1);
  }

  const ttlDays =
    options.days === undefined
      ? DEFAULT_CONSENT_TTL_DAYS
      : typeof options.days === 'number'
        ? options.days
        : Number(String(options.days).trim());
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > MAX_CONSENT_TTL_DAYS) {
    console.error(
      `Invalid --days '${options.days}'. Expected integer between 1 and ${MAX_CONSENT_TTL_DAYS}.`
    );
    console.error('CONSENT_REFUSED reason=days-range');
    process.exit(1);
  }

  const sDir = resolveControlStateDir(options.stateDir);
  const freeze = readFreezeState(sDir);
  if (freeze.frozen) {
    console.error('CONSENT_REFUSED reason=frozen (unfreeze before modifying standing consent)');
    process.exit(1);
  }

  let parsedScope: ReturnType<typeof parseTargetScope>;
  try {
    parsedScope = parseTargetScope(rawTarget);
    if (rawLevel === 'auto-safe') {
      assertEligibleForAutoSafe(sDir, parsedScope.target);
    }
  } catch (err) {
    if (err instanceof ConsentValidationError) {
      console.error(`${err.code}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const prompt = options.promptFn ?? askPrompt;
  const answer = (
    await prompt(
      `Grant standing consent for '${parsedScope.target}' at level '${rawLevel}' (${ttlDays} days)? Type 'consent' to confirm: `
    )
  ).trim();

  if (answer !== 'consent') {
    console.error(`Confirmation rejected (received '${answer}', expected 'consent').`);
    console.error('CONSENT_REFUSED reason=confirmation-mismatch');
    process.exit(1);
  }

  try {
    const entry = upsertStandingConsentTarget(sDir, {
      target: parsedScope.target,
      level: rawLevel,
      ttlDays,
    });
    const statusAfter = readStandingConsent(sDir);
    const safeEntry = sanitizeEntryForOutput(entry);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            policyId: statusAfter.policyId ?? null,
            updatedAt: statusAfter.updatedAt ?? entry.grantedAt,
            entry: safeEntry,
          },
          null,
          2
        )
      );
      return;
    }

    console.log(
      `CONSENT-GRANTED target=${entry.target} level=${entry.level} expiresAt=${entry.expiresAt}`
    );
  } catch (err) {
    if (err instanceof ConsentValidationError) {
      console.error(`${err.code}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export async function runConsentStatusCommand(options: ConsentStatusOptions = {}): Promise<void> {
  const sDir = resolveControlStateDir(options.stateDir);
  const freeze = readFreezeState(sDir);
  const status = readStandingConsent(sDir);

  const sanitizedTargets = status.targets.map((entry) => sanitizeEntryForOutput(entry));

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          present: status.present,
          valid: status.valid,
          ...(status.errorCode ? { errorCode: status.errorCode } : {}),
          frozen: freeze.frozen,
          ...(freeze.reason ? { freezeReason: freeze.reason } : {}),
          activeCount: status.activeTargets.length,
          targets: sanitizedTargets,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `CONSENT-STATUS present=${status.present ? 'yes' : 'no'} valid=${status.valid ? 'yes' : 'no'} frozen=${freeze.frozen ? 'yes' : 'no'} active=${status.activeTargets.length}`
  );
  for (const t of status.targets) {
    const expTag = t.expired ? ' [EXPIRED]' : '';
    console.log(`  - ${t.target} level=${t.level} expiresAt=${t.expiresAt}${expTag}`);
  }
}

export async function runConsentRevokeCommand(options: ConsentRevokeOptions): Promise<void> {
  const sDir = resolveControlStateDir(options.stateDir);
  const rawTarget = options.target?.trim();
  const revokeAll = Boolean(options.all || rawTarget === '--all' || rawTarget === 'all');

  if (revokeAll) {
    const policy = revokeStandingConsentTarget(sDir, '--all');
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            revokedAll: true,
            policyId: policy.policyId,
            updatedAt: policy.updatedAt,
          },
          null,
          2
        )
      );
      return;
    }
    console.log('CONSENT-REVOKED target=--all');
    return;
  }

  if (!rawTarget) {
    console.error('consent revoke requires --target <target> or --all');
    console.error('CONSENT_REFUSED reason=missing-target');
    process.exit(1);
  }

  try {
    const parsed = parseTargetScope(rawTarget);
    const before = readStandingConsent(sDir);
    const existed = before.targets.some((t) => t.target === parsed.target);
    const policy = revokeStandingConsentTarget(sDir, parsed.target);
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            target: parsed.target,
            revoked: existed,
            policyId: policy.policyId,
            updatedAt: policy.updatedAt,
          },
          null,
          2
        )
      );
      return;
    }
    console.log(`CONSENT-REVOKED target=${parsed.target} changed=${existed ? 'yes' : 'no'}`);
  } catch (err) {
    if (err instanceof ConsentValidationError) {
      console.error(`${err.code}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
