/**
 * test/acceptance/at-165-daemon-threat-model-approval.test.ts
 *
 * Acceptance test for AT-165: Daemon Threat Model & Plan Approval Tokens (Phase 3b / T3-DAEMON-SEC / SPEC §03).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
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
});
