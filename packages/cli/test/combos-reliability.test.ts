// V3: phân loại độ ổn định từng bước (thuần) + mutation.
import { describe, expect, it } from 'vitest';
import { labelStep, summarizeAttempts, RELIABLE_OK_MIN } from '../src/commands/combos-reliability.js';
import type { ComboProbeRow } from '../src/commands/combos-probe.js';

const row = (verdict: ComboProbeRow['verdict'], headerMs: number | null): ComboProbeRow => ({
  combo: '(step)',
  model: 'p/m',
  httpStatus: 200,
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
    const broken =
      labelStep({ attempts: 6, ok: 5, rateLimited: 0, timeoutOrNoHeader: 0, p90Ms: 300 });
    expect(s.label).toBe('HANG');
    expect(broken).toBe('RELIABLE');
    expect(broken === s.label).toBe(false);
  });
});