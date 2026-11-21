// C33 N1.3 / N2.3: perComboConclusion và nhãn 503 mới.
import { describe, expect, it } from 'vitest';
import { perComboConclusion, perStepConclusion } from '../src/commands/combos-probe.js';

const base = { headerReceived: true, usageRowAdded: false, timedOut: false, body: '' };

describe('C33 N1: perComboConclusion', () => {
  it('header sớm → OK', () => {
    expect(perComboConclusion({ headerMs: 1200, deadlineMs: 120_000, firstUsageMs: null, timedOut: false })).toBe('OK');
  });

  it('header sau ngưỡng 120 s → SLOW-OK', () => {
    expect(perComboConclusion({ headerMs: 150_000, deadlineMs: 300_000, firstUsageMs: 30_000, timedOut: false })).toBe('SLOW-OK');
  });

  it('hết hạn, có dòng usage → HANG-AFTER-USAGE', () => {
    expect(perComboConclusion({ headerMs: null, deadlineMs: 120_000, firstUsageMs: 8_000, timedOut: true })).toBe('HANG-AFTER-USAGE');
  });

  it('hết hạn, không dòng usage → HANG-NO-USAGE', () => {
    expect(perComboConclusion({ headerMs: null, deadlineMs: 120_000, firstUsageMs: null, timedOut: true })).toBe('HANG-NO-USAGE');
  });

  it('mutation: nếu HANG-AFTER-USAGE trả OK thì test đỏ', () => {
    const broken = (i: Parameters<typeof perComboConclusion>[0]) =>
      i.headerMs === null && i.firstUsageMs !== null ? 'OK' : perComboConclusion(i);
    expect(broken({ headerMs: null, deadlineMs: 120_000, firstUsageMs: 5_000, timedOut: true })).not.toBe('HANG-AFTER-USAGE');
    expect(perComboConclusion({ headerMs: null, deadlineMs: 120_000, firstUsageMs: 5_000, timedOut: true })).toBe('HANG-AFTER-USAGE');
  });
});

describe('C33 N2: 503 phân biệt NO-PROVIDER và ERROR-5XX', () => {
  it('503 có thông điệp "no provider" → NO-PROVIDER', () => {
    expect(
      perStepConclusion({ ...base, status: 503, body: '{"error":"no provider serves this model anymore"}' })
    ).toBe('NO-PROVIDER');
  });

  it('503 không có thông điệp → ERROR-5XX (không được vào danh sách đề xuất gỡ)', () => {
    expect(perStepConclusion({ ...base, status: 503 })).toBe('ERROR-5XX');
    expect(perStepConclusion({ ...base, status: 503, body: '{"error":"upstream unavailable"}' })).toBe('ERROR-5XX');
  });

  it('500 và 502 → ERROR-5XX', () => {
    expect(perStepConclusion({ ...base, status: 500 })).toBe('ERROR-5XX');
    expect(perStepConclusion({ ...base, status: 502 })).toBe('ERROR-5XX');
  });

  it('410 và thông điệp end of life → EOL-GONE', () => {
    expect(perStepConclusion({ ...base, status: 410 })).toBe('EOL-GONE');
    expect(perStepConclusion({ ...base, status: 400, body: 'has reached its end of life' })).toBe('EOL-GONE');
  });

  it('mutation: nếu 503 trơn trả NO-PROVIDER thì test đỏ', () => {
    const broken = (s: number, body: string) =>
      s === 503 ? 'NO-PROVIDER' : perStepConclusion({ ...base, status: s, body });
    expect(broken(503, '')).not.toBe(perStepConclusion({ ...base, status: 503 }));
    expect(perStepConclusion({ ...base, status: 503 })).toBe('ERROR-5XX');
  });
});