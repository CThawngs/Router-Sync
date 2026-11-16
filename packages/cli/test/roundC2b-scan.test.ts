import { describe, it, expect } from 'vitest';
import { fetchModelList } from '../src/sync/providers.js';
import { buildScanCompleteness, dropDecision, isPossibleCap, scanCompleteness } from '../src/sync/confirm.js';

function fakeRes(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload, headers: { get: (_k: string) => null } } as unknown as Response;
}
function listPayload(n: number) {
  return { data: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })), total: n };
}

describe('C2b scan count == raw array (no 200 cut)', () => {
  it('419 models stays 419, not cut to 200', async () => {
    const target = { id: 't', label: 't', prefix: 't', baseUrl: 'https://api.test' } as never;
    const out = await fetchModelList(target, { fetchFn: (async () => fakeRes(listPayload(419))) as never });
    expect(out.models).toHaveLength(419);
    expect(out.incomplete).toBeFalsy();
  });
  it('200 models stays 200', async () => {
    const target = { id: 't', label: 't', prefix: 't', baseUrl: 'https://api.test' } as never;
    const out = await fetchModelList(target, { fetchFn: (async () => fakeRes(listPayload(200))) as never });
    expect(out.models).toHaveLength(200);
  });
  it('SCAN-COMPLETENESS: đếm==mảng thô PASS + POSSIBLE-CAP 200 + guard HOLD', () => {
    expect(isPossibleCap(200)).toBe(true);
    expect(isPossibleCap(419)).toBe(false);
    expect(scanCompleteness({ controlStatus: 200, httpStatus: 200, hasTopLevelJson: true, paginationExhausted: false, modelCount: 200, bytes: 60000 })).toBe('POSSIBLE-CAP');
    const text = buildScanCompleteness([{ router: '9router', prefix: 'hf', host: 'h', path: '/models', key: '9router-key', status: 200, countR1: 200, countR2: 200, pagination: 'none', conclusion: 'POSSIBLE-CAP', rawCount: 200, controlStatus: 200 }]);
    expect(text).toContain('PASS');
    expect(text).toContain('POSSIBLE-CAP');
    expect(text).toContain('OWN-KEY');
    expect(dropDecision('CONFIRMED-ABSENT', 'POSSIBLE-CAP', { controlsOk: true, secondSourceAbsent: true, possibleCap: true })).toBe('DROP-HOLD');
    expect(dropDecision('CONFIRMED-ABSENT', 'COMPLETE', { controlsOk: true, secondSourceAbsent: true })).toBe('DROP-DEAD');
  });
});
