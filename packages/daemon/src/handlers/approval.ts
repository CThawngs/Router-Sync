/**
 * packages/daemon/src/handlers/approval.ts
 *
 * Handler for POST /api/v1/changes/approve (Phase 3b / T3-DAEMON-SEC / SPEC §03).
 *
 * Verifies human approval token and planHash before granting plan approval.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../security/network.js';
import { verifyAndConsumeApprovalToken } from '../security/approval-token.js';

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
    const statusCode = verification.reason === 'token_not_found' || verification.reason === 'token_expired' ? 401 : 403;
    sendJson(res, statusCode, {
      meta: {
        source: 'unavailable',
        reason: verification.reason ?? 'unauthorized',
        generatedAt: nowIso,
      },
      error: `Approval token rejected: ${verification.reason}`,
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
