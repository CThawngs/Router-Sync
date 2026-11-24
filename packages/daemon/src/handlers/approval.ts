/**
 * packages/daemon/src/handlers/approval.ts
 *
 * Handler for POST /api/v1/changes/approve (Phase 3b / T3-DAEMON-SEC / M2-01 / C45-WP4 / SPEC §03).
 *
 * Verifies emergency freeze state, human approval token HMAC signature, and planHash
 * before granting plan approval.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../security/network.js';
import { verifyAndConsumeApprovalToken } from '../security/approval-token.js';

const REJECTION_HTTP_STATUS: Record<string, number> = {
  token_not_found: 401,
  token_expired: 401,
  invalid_signature: 403,
  token_already_consumed: 403,
  plan_hash_mismatch: 403,
};

function isDaemonEmergencyFrozen(): boolean {
  const envState = process.env['ROUTERSYNC_STATE_DIR']?.trim();
  const envHome = process.env['ROUTERSYNC_HOME']?.trim();
  const stateDir = envState
    ? path.resolve(envState)
    : envHome
      ? path.resolve(envHome, 'state')
      : path.join(os.homedir(), '.routersync');
  const freezePath = path.join(stateDir, 'freeze.json');
  if (!fs.existsSync(freezePath)) {
    return false;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(freezePath, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed['frozen'] !== 'boolean') {
      return true; // Fail closed on corrupt freeze.json
    }
    return parsed['frozen'] === true;
  } catch {
    return true; // Fail closed on unreadable/malformed freeze.json
  }
}

export async function handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const nowIso = new Date().toISOString();

  // Read request body (limit 8KB)
  let rawBody = '';
  for await (const chunk of req) {
    rawBody += chunk;
    if (rawBody.length > 8192) {
      sendJson(res, 413, {
        meta: { source: 'unavailable', reason: 'payload_too_large', generatedAt: nowIso },
        error: 'Payload size limit exceeded',
      });
      return;
    }
  }

  // Emergency Freeze Gate (C45-WP4): fail closed before evaluating or consuming tokens
  if (isDaemonEmergencyFrozen()) {
    sendJson(res, 403, {
      meta: { source: 'unavailable', reason: 'write_frozen', generatedAt: nowIso },
      error: 'Approval blocked: system is frozen',
      approved: false,
    });
    return;
  }

  let parsed: { planHash?: unknown; token?: unknown };
  try {
    parsed = JSON.parse(rawBody || '{}');
  } catch {
    sendJson(res, 400, {
      meta: { source: 'unavailable', reason: 'invalid_json', generatedAt: nowIso },
      error: 'Malformed JSON payload',
    });
    return;
  }

  const { planHash, token } = parsed;

  if (typeof planHash !== 'string' || !planHash.trim() || typeof token !== 'string' || !token.trim()) {
    sendJson(res, 400, {
      meta: { source: 'unavailable', reason: 'missing_fields', generatedAt: nowIso },
      error: 'Missing required fields: planHash and token',
    });
    return;
  }

  const verification = verifyAndConsumeApprovalToken(token.trim(), planHash.trim());

  if (!verification.valid) {
    const reason = verification.reason ?? 'unauthorized';
    const statusCode = REJECTION_HTTP_STATUS[reason] ?? 403;
    sendJson(res, statusCode, {
      meta: {
        source: 'unavailable',
        reason,
        generatedAt: nowIso,
      },
      error: reason === 'invalid_signature' ? 'invalid_signature' : `Approval token rejected: ${reason}`,
      message: `Approval token rejected: ${reason}`,
      approved: false,
    });
    return;
  }

  sendJson(res, 200, {
    meta: {
      source: 'live',
      generatedAt: nowIso,
    },
    approved: true,
    planHash: planHash.trim(),
    message: 'Plan successfully approved for execution',
  });
}
