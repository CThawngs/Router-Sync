import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { createDaemonServer, clearProbeCache, sanitizeObject, sanitizeString } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('Acceptance Test AT-120: Zero Secret Leak & Canary Sanitization (AT-120)', () => {
  it('redacts canary tokens and raw API keys in strings', () => {
    const canary = 'Token CANARY_TEST_SUITE_12345 found';
    expect(sanitizeString(canary)).toBe('Token [REDACTED_CANARY] found');

    const openAiKey = 'Key sk-proj-1234567890abcdef12345 active'; // no-secrets:allow: synthetic test key for redaction check
    expect(sanitizeString(openAiKey)).toBe('Key [REDACTED_SECRET] active');

    const authHeader = 'Authorization: Bearer my-secret-jwt-token-123';
    expect(sanitizeString(authHeader)).toBe('Authorization: Bearer [REDACTED]');
  });

  it('strips terminal escape codes and control characters to prevent prompt/log injection', () => {
    const maliciousInput = 'Normal text\x1b[31mInjected Red\x00Nullbyte\x07Bell';
    const cleaned = sanitizeString(maliciousInput);
    expect(cleaned).not.toContain('\x1b');
    expect(cleaned).not.toContain('\x00');
    expect(cleaned).not.toContain('\x07');
    expect(cleaned).toContain('Normal text');
    expect(cleaned).toContain('Injected Red');
  });

  it('recursively sanitizes objects and redacts sensitive field keys', () => {
    const sensitivePayload = {
      user: 'admin',
      password: 'super-secret-password-123',
      key_value: 'secret-api-key',
      raw_key: 'another-secret',
      nested: {
        note: 'Debug log with CANARY_ALERT_01 inside',
      },
      list: ['safe', 'contains sk-abcdef1234567890123'], // no-secrets:allow: synthetic test key for redaction check
    };

    const sanitized = sanitizeObject(sensitivePayload);
    expect(sanitized.user).toBe('admin');
    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.key_value).toBe('[REDACTED]');
    expect(sanitized.raw_key).toBe('[REDACTED]');
    expect(sanitized.nested.note).toBe('Debug log with [REDACTED_CANARY] inside');
    expect(sanitized.list[1]).toBe('contains [REDACTED_SECRET]');
  });

  describe('Daemon Live Response Canary Scan', () => {
    let server: http.Server;
    let port: number;
    let fixture: DaemonFixture | undefined;

    beforeAll(async () => {
      // R11-0: hermetic fixture — env overrides point config/DBs/probe URLs at tmp state.
      fixture = await setupDaemonFixture();
      clearProbeCache();
      server = createDaemonServer({ host: '127.0.0.1' });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            port = addr.port;
          }
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fixture?.restore();
    });

    it('verifies live daemon endpoints emit ZERO raw secrets or canary patterns', async () => {
      const endpoints = [
        '/api/v1/health',
        '/api/v1/overview',
        '/api/v1/targets',
        '/api/v1/combos',
        '/api/v1/doctor',
        '/api/v1/settings',
      ];

      for (const endpoint of endpoints) {
        const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
          headers: { Host: `127.0.0.1:${port}` },
        });
        const text = await res.text();

        expect(text).not.toMatch(/CANARY_[a-zA-Z0-9_-]+/);
        expect(text).not.toMatch(/sk-[a-zA-Z0-9_-]{10,}/);
        expect(text).not.toMatch(/Bearer\s+(?!\[REDACTED\])[a-zA-Z0-9._-]+/);
      }
    }, 15000);
  });
});
