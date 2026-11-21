// C32 M1.6: `perStepConclusion` phân loại từng nhánh, và dry-run không gọi mạng.
import { describe, expect, it, vi } from 'vitest';
import {
  perStepConclusion,
  runCombosProbeCommand,
  redact,
  type ProbeReport,
} from '../src/commands/combos-probe.js';

const base = { headerReceived: true, usageRowAdded: false, timedOut: false, body: '' };

describe('C32 M1: phân loại một lần thử', () => {
  it('200 → OK', () => {
    expect(perStepConclusion({ ...base, status: 200 })).toBe('OK');
  });

  it('429 → RATE-LIMITED', () => {
    expect(perStepConclusion({ ...base, status: 429 })).toBe('RATE-LIMITED');
  });

  it('401 và 403 → AUTH', () => {
    expect(perStepConclusion({ ...base, status: 401 })).toBe('AUTH');
    expect(perStepConclusion({ ...base, status: 403 })).toBe('AUTH');
  });

  it('410 → EOL-GONE', () => {
    expect(perStepConclusion({ ...base, status: 410 })).toBe('EOL-GONE');
  });

  it('nội dung "end of life" → EOL-GONE dù mã khác', () => {
    const body = '{"title":"Gone","detail":"The model x has reached its end of life on 2026-08-26"}';
    expect(perStepConclusion({ ...base, status: 400, body })).toBe('EOL-GONE');
  });

  it('503 "không còn provider" → NO-PROVIDER', () => {
    const body = 'no provider serves this model anymore';
    expect(perStepConclusion({ ...base, status: 503, body })).toBe('NO-PROVIDER');
  });

  // C33 N2.1: 503 trơn không còn là NO-PROVIDER (xem combos-probe-c33.test.ts).
  it('503 không có nội dung → ERROR-5XX', () => {
    expect(perStepConclusion({ ...base, status: 503 })).toBe('ERROR-5XX');
  });

  it('hết hạn, không header, có dòng usage → HANG-AFTER-USAGE', () => {
    expect(
      perStepConclusion({ status: null, headerReceived: false, usageRowAdded: true, timedOut: true })
    ).toBe('HANG-AFTER-USAGE');
  });

  it('hết hạn, không header, không dòng usage → TIMEOUT-NO-HEADER', () => {
    expect(
      perStepConclusion({ status: null, headerReceived: false, usageRowAdded: false, timedOut: true })
    ).toBe('TIMEOUT-NO-HEADER');
  });

  it('còn lại → ERROR', () => {
    expect(perStepConclusion({ ...base, status: 400 })).toBe('ERROR');
  });

  it('mutation: nếu 410 trả OK thì test đỏ', () => {
    const broken = (s: number) => (s === 410 ? 'OK' : perStepConclusion({ ...base, status: s }));
    expect(broken(410)).not.toBe(perStepConclusion({ ...base, status: 410 }));
    expect(perStepConclusion({ ...base, status: 410 })).toBe('EOL-GONE');
  });

  it('che chuỗi dài và khoá trong thân lỗi', () => {
    // Chuỗi giả: không phải key thật (guard đọc mọi chuỗi dạng sk-...).
    // no-secrets:allow: synthetic token used to prove redact() masks long strings
    const fakeToken = 'sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789';
    const out = redact(`key=${fakeToken}`, [fakeToken]);
    assertNotLeak(out);
  });

  it('dry-run: không gọi mạng và không cần --yes-spend-tokens', async () => {
    const fetchImpl = vi.fn();
    const log = vi.fn();
    const report: ProbeReport = await runCombosProbeCommand({
      mode: 'combo',
      all: true,
      // Dry-run không được mở DB router: trên máy CI không có 9Router.
      state: { combos: [{ name: 'c1', steps: ['p/m1', 'p/m2'] }], apiKey: 'k', apiKeyName: 'fake' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.stoppedEarly).toBe('dry-run');
    expect(report.rows).toEqual([]);
    expect(log.mock.calls.flat().join('\n')).toMatch(/không có request nào được gửi/);
  });
});

function assertNotLeak(out: string): void {
  expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
}