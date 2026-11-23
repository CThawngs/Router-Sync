/**
 * test/acceptance/at-165-daemon-threat-model-approval.test.ts
 *
 * Acceptance test for AT-165: Daemon Threat Model & Plan Approval Tokens (Phase 3b / T3-DAEMON-SEC / SPEC §03).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as daemonPkg from '@routersync/daemon';
import {
  createDaemonServer,
  createApprovalToken,
  resetTokenRegistry,
} from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('AT-165: Daemon Threat Model & Plan Approval Tokens (T3-DAEMON-SEC)', () => {
  let fixture: DaemonFixture;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    fixture = await setupDaemonFixture();
    server = createDaemonServer({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fixture.restore();
  });

  beforeEach(() => {
    resetTokenRegistry();
  });

  it('rejects POST /api/v1/changes/approve from foreign Origin (CSRF Mitigation)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/changes/approve`, {
      method: 'POST',
      headers: {
        Origin: 'http://malicious-attacker.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ planHash: 'abc', token: 'xyz' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe('invalid_origin');
    expect(body.message).toContain('Cross-origin');
  });

  it('rejects request with missing or invalid fields', async () => {
    const res = await fetch(`${baseUrl}/api/v1/changes/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planHash: 'only-hash' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.meta?.reason).toBe('missing_fields');
  });

  it('rejects non-existent approval tokens with 401 Unauthorized', async () => {
    const res = await fetch(`${baseUrl}/api/v1/changes/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planHash: 'hash-123',
        token: 'non-existent-token-hex',
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.meta?.reason).toBe('token_not_found');
    expect(body.approved).toBe(false);
  });

  it('rejects approval when planHash does not match the token (Tampering Guard)', async () => {
    const tokenRecord = createApprovalToken('expected-hash-456');

    const res = await fetch(`${baseUrl}/api/v1/changes/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planHash: 'tampered-hash-789',
        token: tokenRecord.token,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.meta?.reason).toBe('plan_hash_mismatch');
    expect(body.approved).toBe(false);
  });

  it('rejects expired approval tokens with 401 Unauthorized', async () => {
    // Token with -1ms TTL is already expired
    const tokenRecord = createApprovalToken('valid-hash', -100);

    const res = await fetch(`${baseUrl}/api/v1/changes/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planHash: 'valid-hash',
        token: tokenRecord.token,
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.meta?.reason).toBe('token_expired');
  });

  it('approves plan with valid token and enforces single-use (Nonce Replay Protection)', async () => {
    const targetPlanHash = 'plan-hash-production-verified-99';
    const tokenRecord = createApprovalToken(targetPlanHash);

    // First attempt: should succeed
    const firstRes = await fetch(`${baseUrl}/api/v1/changes/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planHash: targetPlanHash,
        token: tokenRecord.token,
      }),
    });

    expect(firstRes.status).toBe(200);
    const firstBody = (await firstRes.json()) as any;
    expect(firstBody.approved).toBe(true);
    expect(firstBody.meta?.source).toBe('live');
    expect(firstBody.planHash).toBe(targetPlanHash);

    // Second attempt with the SAME token: must be rejected (single-use)
    const replayRes = await fetch(`${baseUrl}/api/v1/changes/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planHash: targetPlanHash,
        token: tokenRecord.token,
      }),
    });

    expect(replayRes.status).toBe(403);
    const replayBody = (await replayRes.json()) as any;
    expect(replayBody.meta?.reason).toBe('token_already_consumed');
    expect(replayBody.approved).toBe(false);
  });

  it('M2-01-T5: issues HMAC-signed <64hex>.<64hex> tokens, rejects flipped signature without consuming original token, and rejects forged unknown-nonce tokens with 403 invalid_signature', async () => {
    const targetPlanHash = 'plan-hash-hmac-signed-m201';
    const tokenRecord = createApprovalToken(targetPlanHash);

    // 1. Structural <nonceHex>.<sigHex> format & zero signingKey leakage
    expect(tokenRecord.token).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
    const ManagerCtor = (daemonPkg as Record<string, unknown>)['ApprovalTokenManager'] as
      | (new () => Record<string, unknown>)
      | undefined;
    expect(typeof ManagerCtor).toBe('function');
    const isolatedMgr = new ManagerCtor!();
    expect(JSON.stringify(isolatedMgr)).not.toContain('signingKey');

    // 2. Flip 1 hex character in sigHex -> 403 invalid_signature AND does NOT consume original token
    const [nonceHex, sigHex] = tokenRecord.token.split('.') as [string, string];
    const flippedFirstChar = sigHex[0] === '0' ? '1' : '0';
    const tamperedToken = `${nonceHex}.${flippedFirstChar}${sigHex.slice(1)}`;

    const tamperedRes = await fetch(`${baseUrl}/api/v1/changes/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planHash: targetPlanHash,
        token: tamperedToken,
      }),
    });

    expect(tamperedRes.status).toBe(403);
    const rawTamperedText = await tamperedRes.text();
    expect(rawTamperedText).not.toContain(sigHex);
    expect(rawTamperedText).not.toContain(tamperedToken);
    const tamperedBody = JSON.parse(rawTamperedText) as any;
    expect(tamperedBody.error).toBe('invalid_signature');
    expect(tamperedBody.meta?.reason).toBe('invalid_signature');
    expect(tamperedBody.approved).toBe(false);

    // 3. Forged <64hex>.<64hex> with unknown nonce -> 403 invalid_signature
    const forgedUnknown = `${'a'.repeat(64)}.${'b'.repeat(64)}`;
    const forgedRes = await fetch(`${baseUrl}/api/v1/changes/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planHash: targetPlanHash,
        token: forgedUnknown,
      }),
    });

    expect(forgedRes.status).toBe(403);
    const forgedBody = (await forgedRes.json()) as any;
    expect(forgedBody.error).toBe('invalid_signature');
    expect(forgedBody.meta?.reason).toBe('invalid_signature');
    expect(forgedBody.approved).toBe(false);

    // 4. Malformed dot-containing token -> 403 invalid_signature
    const malformedDotRes = await fetch(`${baseUrl}/api/v1/changes/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planHash: targetPlanHash,
        token: 'short.sig',
      }),
    });
    expect(malformedDotRes.status).toBe(403);
    const malformedDotBody = (await malformedDotRes.json()) as any;
    expect(malformedDotBody.error).toBe('invalid_signature');

    // 5. Original unmodified token MUST remain valid and unconsumed!
    const validRes = await fetch(`${baseUrl}/api/v1/changes/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planHash: targetPlanHash,
        token: tokenRecord.token,
      }),
    });
    expect(validRes.status).toBe(200);
    const validBody = (await validRes.json()) as any;
    expect(validBody.approved).toBe(true);
    expect(validBody.planHash).toBe(targetPlanHash);
  });
});
