import { describe, it, expect } from 'vitest';
import { quotaStatus } from '../src/sync/confirm.js';

// C3r R3a: cặp status 429 -> COVERAGE gọi QUOTA (không phải chưa quét).
describe('quotaStatus shared classifier', () => {
  it('429 la QUOTA', () => {
    expect(quotaStatus(429)).toBe(true);
  });
  it('200/404/0 khong phai QUOTA', () => {
    expect(quotaStatus(200)).toBe(false);
    expect(quotaStatus(404)).toBe(false);
    expect(quotaStatus(0)).toBe(false);
  });
});
