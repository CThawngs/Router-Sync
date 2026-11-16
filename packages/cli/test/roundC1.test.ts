import { describe, it, expect } from 'vitest';
import { classifyLock } from '../src/commands/health.js';
import { scanCompleteness, buildScanCompleteness } from '../src/sync/confirm.js';

describe('ROUND C1 W0', () => {
  it('classifyLock: 429 QUOTA, 401/403/404 DEAD-CANDIDATE', () => {
    expect(classifyLock({ errorCode: 429 })).toBe('QUOTA');
    expect(classifyLock({ errorCode: 401 })).toBe('DEAD-CANDIDATE');
    expect(classifyLock({ errorCode: 403 })).toBe('DEAD-CANDIDATE');
    expect(classifyLock({ errorCode: 404 })).toBe('DEAD-CANDIDATE');
  });
  it('scanCompleteness unique rule (R1 C3c: single-page alone NOT COMPLETE)', () => {
    const base = { controlStatus: 200, httpStatus: 200, hasTopLevelJson: true, paginationExhausted: true, modelCount: 10 };
    expect(scanCompleteness(base)).toBe('STABLE-UNCONFIRMED');
    expect(scanCompleteness({ ...base, controlStatus: 429 })).toBe('QUOTA');
    expect(scanCompleteness({ ...base, controlStatus: 404 })).toBe('UNSUPPORTED');
    expect(scanCompleteness({ ...base, modelCount: 0 })).toBe('UNKNOWN-NO-SIGNAL');
    expect(scanCompleteness({ ...base, paginationExhausted: false })).toBe('STABLE-UNCONFIRMED');
    expect(scanCompleteness({ ...base, hasTopLevelJson: false })).toBe('UNKNOWN-NO-SIGNAL');
    expect(scanCompleteness({ ...base, trustComplete: true, paginationExhausted: false })).toBe('COMPLETE');
    expect(scanCompleteness({ ...base, trustComplete: true, controlStatus: 404 })).toBe('UNSUPPORTED');
  });
  it('buildScanCompleteness code-generated', () => {
    const out = buildScanCompleteness([{ router: '9router', prefix: 'hf', host: 'router.huggingface.co', path: '/v1/models', key: 'router-key', status: 200, countR1: 100, countR2: 100, pagination: 'none', conclusion: 'COMPLETE' }]);
    expect(out).toContain('sinh bằng mã');
    expect(out).toContain('9router|hf|router.huggingface.co');
    expect(out).toContain('COMPLETE');
  });
});
