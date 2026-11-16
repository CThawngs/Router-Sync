import { describe, it, expect } from 'vitest';
import { parseLockExpiry, classifyModelLock, classifyLock, headStepLabel } from '../src/commands/health.js';
import { verdictForStatus, dropDecision, scanCompleteness } from '../src/sync/confirm.js';
import { classifyPrice, canonicalKey, providerWideZero } from '../src/commands/discover.js';
import { canonicalPrefix, hostOf, looksEncrypted, detectNextPage } from '../src/sync/providers.js';

describe('ROUND C1b 2.1 lock classification', () => {
  it('parseLockExpiry xu ly ISO string va so', () => {
    expect(parseLockExpiry('2026-11-04T15:41:07.308Z').expiry).toBe('2026-11-04T15:41:07.308Z');
    expect(parseLockExpiry(1799999999999).ms).toBe(1799999999999);
    expect(parseLockExpiry(null).expiry).toBeNull();
  });
  it('classifyModelLock: lock con hieu luc => QUOTA', () => {
    const now = Date.parse('2026-11-04T08:00:00Z');
    const v = classifyModelLock({ modelLock_m: new Date(now + 60000).toISOString(), errorCode: 429, lastErrorAt: new Date(now).toISOString() }, 'm', { now });
    expect(v.label).toBe('QUOTA');
  });
  it('classifyModelLock: lock het han + loi chet cu >12h => LOCK-EXPIRED', () => {
    const now = Date.parse('2026-11-04T08:00:00Z');
    const v = classifyModelLock({ modelLock_m: new Date(now - 3600000).toISOString(), errorCode: 404, lastErrorAt: new Date(now - 13 * 3600000).toISOString() }, 'm', { now });
    expect(v.label).toBe('LOCK-EXPIRED');
  });
  it('classifyModelLock: 404/401/403 khong co hoi gan day => DEAD-CANDIDATE', () => {
    const now = Date.parse('2026-11-04T08:00:00Z');
    for (const code of [404, 401, 403]) {
      expect(classifyModelLock({ errorCode: code, lastErrorAt: '2026-11-04T03:02:33Z' }, 'x', { now }).label).toBe('DEAD-CANDIDATE');
    }
  });
  it('classifyLock: 429 QUOTA, 404 DEAD-CANDIDATE', () => {
    expect(classifyLock({ errorCode: 429 })).toBe('QUOTA');
    expect(classifyLock({ errorCode: 404 })).toBe('DEAD-CANDIDATE');
    const future = new Date(Date.now() + 60000).toISOString();
    expect(classifyLock({ modelLock_m: future })).toBe('QUOTA');
  });
  it('headStepLabel: khong log thi UNKNOWN (khong ghi OK)', () => {
    expect(headStepLabel('ag/claude-sonnet-5-5-medium', undefined, undefined)).toBe('UNKNOWN');
    expect(headStepLabel('ag/claude-sonnet-5-5-medium', { errorCode: 404 }, { lastSuccess: null })).toBe('DEAD-CANDIDATE');
  });
});

describe('ROUND C1b 2.2 confirm / drop', () => {
  it('verdictForStatus map dung', () => {
    expect(verdictForStatus(404)).toBe('CONFIRMED-ABSENT');
    expect(verdictForStatus(200)).toBe('STILL-EXISTS');
    expect(verdictForStatus(401)).toBe('AUTH');
    expect(verdictForStatus(429)).toBe('QUOTA');
  });
  it('dropDecision chi DROP-DEAD khi CONFIRMED-ABSENT hoac UNSUPPORTED+COMPLETE', () => {
    expect(dropDecision('CONFIRMED-ABSENT', 'UNKNOWN-NO-SIGNAL')).toBe('DROP-DEAD');
    expect(dropDecision('UNSUPPORTED', 'COMPLETE')).toBe('DROP-DEAD');
    expect(dropDecision('UNSUPPORTED', 'UNKNOWN-NO-SIGNAL')).toBe('DROP-HOLD');
    expect(dropDecision('STILL-EXISTS', 'COMPLETE')).toBe('DROP-HOLD');
  });
});

describe('ROUND C1b 2.4/2.5 discover price', () => {
  it('canonicalKey dung prefix chuyen doi', () => {
    expect(canonicalKey('ag', 'M1')).toContain('m1');
  });
  it('classifyPrice khong suy FREE khi thieu nguon hai', () => {
    expect(classifyPrice('model-x', undefined, undefined, false).label).not.toBe('FREE-BY-PRICE');
    expect(classifyPrice('model-x-free', undefined, undefined, false).label).toBe('FREE-BY-SUFFIX');
  });
  it('providerWideZero phat hien gia 0 day', () => {
    const entries = [{ priceFields: ['cost'], inputPrice: 0, outputPrice: 0 } as any];
    expect(providerWideZero(entries).ratio).toBe(1);
  });
});

describe('ROUND C1b 2.6/2.7 providers', () => {
  it('canonicalPrefix ag -> antigravity', () => {
    expect(canonicalPrefix('ag')).toBe('antigravity');
  });
  it('hostOf lay host dung tu baseUrl', () => {
    expect(hostOf('https://api.provider-b.ai/v1')).toBe('api.provider-b.ai');
  });
  it('looksEncrypted nhan key ma hoa (dai >100)', () => {
    expect(looksEncrypted('a'.repeat(101))).toBe(true);
    expect(looksEncrypted('enc:abc')).toBe(false);
  });
  it('detectNextPage tra null khi khong co tin hieu phan trang', () => {
    expect(detectNextPage({ data: [] }).url).toBeNull();
  });
});
