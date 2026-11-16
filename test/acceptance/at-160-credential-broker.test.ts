/**
 * test/acceptance/at-160-credential-broker.test.ts
 *
 * Acceptance test for AT-160: Secure Credential Broker (Phase 3a / P1-DEBT-02 / SPEC §31).
 */

import { describe, it, expect } from 'vitest';
import { CredentialBroker, CredentialReferenceSchema } from '@routersync/core';

describe('AT-160: Secure Credential Broker', () => {
  it('resolves valid env reference { env: VAR } with correct raw and masked secret', () => {
    const mockEnv = {
      MY_API_KEY: 'synthetic-test-secret-key-1234567890',
    };
    const broker = new CredentialBroker(mockEnv);
    const res = broker.resolve({ env: 'MY_API_KEY' });

    expect(res).toBeDefined();
    expect(res?.sourceEnv).toBe('MY_API_KEY');
    expect(res?.raw).toBe('synthetic-test-secret-key-1234567890');
    expect(res?.masked).toBe('synt...7890');
  });

  it('supports string formats env:VAR and ${VAR}', () => {
    const mockEnv = {
      TOGETHER_API_KEY: 'together-token-xyz-9999',
    };
    const broker = new CredentialBroker(mockEnv);

    const res1 = broker.resolve('env:TOGETHER_API_KEY');
    expect(res1?.raw).toBe('together-token-xyz-9999');

    const res2 = broker.resolve('${TOGETHER_API_KEY}');
    expect(res2?.raw).toBe('together-token-xyz-9999');

    const res3 = broker.resolve('TOGETHER_API_KEY');
    expect(res3?.raw).toBe('together-token-xyz-9999');
  });

  it('returns undefined when environment variable is not present or empty', () => {
    const mockEnv = {
      EMPTY_KEY: '   ',
    };
    const broker = new CredentialBroker(mockEnv);

    expect(broker.resolve({ env: 'MISSING_KEY' })).toBeUndefined();
    expect(broker.resolve({ env: 'EMPTY_KEY' })).toBeUndefined();
    expect(broker.resolve('env:MISSING_KEY')).toBeUndefined();
  });

  it('masks short keys (<= 8 characters) completely with asterisks', () => {
    expect(CredentialBroker.mask('12345678')).toBe('***');
    expect(CredentialBroker.mask('short')).toBe('***');
    expect(CredentialBroker.mask('')).toBe('***');
  });

  it('validates env variable name schema rejecting invalid characters', () => {
    expect(CredentialReferenceSchema.safeParse({ env: 'VALID_ENV_NAME_1' }).success).toBe(true);
    expect(CredentialReferenceSchema.safeParse({ env: 'invalid-name-with-dash' }).success).toBe(false);
    expect(CredentialReferenceSchema.safeParse({ env: 'INVALID NAME WITH SPACES' }).success).toBe(false);
  });
});
