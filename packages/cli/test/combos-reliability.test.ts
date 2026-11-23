// V3 + R2: phân loại độ ổn định từng bước (thuần) + LOW-SAMPLE cho mẫu nhỏ < 5 lượt 100% OK.
import { describe, expect, it } from 'vitest';
import { labelStep, summarizeAttempts, RELIABLE_OK_MIN } from '../src/commands/combos-reliability.js';
import type { ComboProbeRow } from '../src/commands/combos-probe.js';

const row = (verdict: ComboProbeRow['verdict'], headerMs: number | null): ComboProbeRow => ({
  combo: '(step)',
  model: 'p/m',
  httpStatus: verdict === 'RATE-LIMITED' ? 429 : verdict === 'OK' ? 200 : 500,
  headerMs,
  firstByteMs: headerMs,
  totalMs: headerMs ?? 30_000,
  verdict,
  detail: '',
  usageServedBy: null,
});

describe('V3: label bước', () => {
  it('RELIABLE: >=5/6 OK, p90 dưới 5 s', () => {
    const rows = Array.from({ length: 6 }, () => row('OK', 300));
    const s = summarizeAttempts('p/m', rows);
    expect(s.label).toBe('RELIABLE');
    expect(s.ok).toBe(6);
    expect(RELIABLE_OK_MIN).toBe(5);
  });

  it('SLOW: OK đủ nhưng p90 >= 5 s', () => {
    const rows = Array.from({ length: 6 }, () => row('OK', 6000));
    expect(summarizeAttempts('p/m', rows).label).toBe('SLOW');
  });

  it('RATE-LIMITED: có 429 nhưng không timeout', () => {
    const rows = [...Array.from({ length: 5 }, () => row('OK', 300)), row('RATE-LIMITED', 200)];
    expect(summarizeAttempts('p/m', rows).label).toBe('RATE-LIMITED');
  });

  it('HANG: có một lần timeout dù các lần khác OK', () => {
    const rows = [...Array.from({ length: 5 }, () => row('OK', 300)), row('TIMEOUT-NO-HEADER', null)];
    expect(summarizeAttempts('p/m', rows).label).toBe('HANG');
  });

  it('DEAD: OK dưới 3/6 và không phải 429', () => {
    const rows = [row('OK', 300), row('OK', 300), ...Array.from({ length: 4 }, () => row('ERROR-5XX', 20))];
    expect(summarizeAttempts('p/m', rows).label).toBe('DEAD');
  });

  it('mutation: đổi ngưỡng HANG thì test đỏ', () => {
    const rows = [...Array.from({ length: 5 }, () => row('OK', 300)), row('TIMEOUT-NO-HEADER', null)];
    const s = summarizeAttempts('p/m', rows);
    // Giả sử bỏ kiểm tra timeout: cùng dữ liệu sẽ ra RELIABLE thay vì HANG.
    const broken = labelStep({ attempts: 6, ok: 5, rateLimited: 0, timeoutOrNoHeader: 0, p90Ms: 300 });
    expect(s.label).toBe('HANG');
    expect(broken).toBe('RELIABLE');
    expect(broken === s.label).toBe(false);
  });
});

describe('R2: nhãn LOW-SAMPLE trên mẫu nhỏ (< 5 lượt, 100% OK, không 429/timeout)', () => {
  it('1/1, 2/2, 3/3, 4/4 OK không lỗi -> LOW-SAMPLE (không gán nhầm DEAD)', () => {
    for (const n of [1, 2, 3, 4]) {
      const rows = Array.from({ length: n }, () => row('OK', 845));
      const s = summarizeAttempts('openrouter/openrouter/free', rows);
      expect(s.label).toBe('LOW-SAMPLE');
      expect(labelStep({ attempts: n, ok: n, rateLimited: 0, timeoutOrNoHeader: 0, p90Ms: 845 })).toBe('LOW-SAMPLE');
    }
  });

  it('ok=0/1 kèm rateLimited=1 vẫn giữ nguyên RATE-LIMITED (các dòng oc/* của x2-remaining)', () => {
    expect(summarizeAttempts('oc/big-pickle', [row('RATE-LIMITED', 1597)]).label).toBe('RATE-LIMITED');
    expect(labelStep({ attempts: 1, ok: 0, rateLimited: 1, timeoutOrNoHeader: 0, p90Ms: 1597 })).toBe('RATE-LIMITED');
  });

  it('ok=0/1 lỗi cứng không phải 429 vẫn là DEAD (inclusionai/ling-3.2-flash:free)', () => {
    expect(summarizeAttempts('openrouter/inclusionai/ling-3.2-flash:free', [row('ERROR-5XX', 5584)]).label).toBe('DEAD');
    expect(labelStep({ attempts: 1, ok: 0, rateLimited: 0, timeoutOrNoHeader: 0, p90Ms: 5584 })).toBe('DEAD');
  });

  it('mẫu < 5 lượt nhưng có lỗi cứng không phải 429 (1/3, 2/4) vẫn là DEAD', () => {
    expect(labelStep({ attempts: 3, ok: 1, rateLimited: 0, timeoutOrNoHeader: 0, p90Ms: 500 })).toBe('DEAD');
    expect(labelStep({ attempts: 4, ok: 2, rateLimited: 0, timeoutOrNoHeader: 0, p90Ms: 500 })).toBe('DEAD');
  });

  it('mẫu < 5 lượt có timeout vẫn ưu tiên HANG', () => {
    expect(labelStep({ attempts: 4, ok: 3, rateLimited: 0, timeoutOrNoHeader: 1, p90Ms: 500 })).toBe('HANG');
  });
});
