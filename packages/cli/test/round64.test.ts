import { describe, it, expect } from 'vitest';
import { computeProviderMatch, isRemovalBlocked, R2_MIN_MATCH } from '../src/commands/autopilot.js';
import { detectNextPage, fetchModelList, SCAN_MAX_PAGES } from '../src/sync/providers.js';

function keys(n: number, prefix = 'a'): string[] { return Array.from({length: n}, (_,i)=>`${prefix}/m${i}`); }
function fakeRes(payload: unknown, headers: Record<string,string> = {}) {
  return { ok: true, status: 200, json: async () => payload, headers: { get: (k:string)=> headers[k.toLowerCase()] ?? null } } as any;
}

describe('R2 ratio ROUND64', () => {
  it('90/100 not skipped', () => { const r = computeProviderMatch(keys(100), new Set(keys(90))); expect(r.ratio).toBeCloseTo(0.9); expect(r.ratio >= R2_MIN_MATCH).toBe(true); });
  it('40/100 skipped', () => { const r = computeProviderMatch(keys(100), new Set(keys(40))); expect(r.ratio < R2_MIN_MATCH).toBe(true); });
  it('denominator counted once (no double count)', () => {
    // 9 combos x 116 instances = 1044 steps; all present -> ratio 1, not 936/2088
    const stepKeys = Array.from({length: 1044}, (_,i)=>`hf/m${i%116}`);
    const live = new Set(Array.from({length:116}, (_,i)=>`hf/m${i}`));
    const r = computeProviderMatch(stepKeys, live);
    expect(r.steps).toBe(1044); expect(r.matched).toBe(1044); expect(r.ratio).toBe(1);
  });
  it('numerator uses r2 only, not union', () => {
    // m0 only in r1; denominator 100, r2 has 50 -> ratio 0.5 if m0 excluded
    const stepKeys = keys(100);
    const r2live = new Set([...keys(49), 'a/m99']); // 50 distinct, includes m99
    // m0 not in r2 => matched 50? stepKeys includes m0..m99; r2live has m0? no (0..48 +99) so 50 matched
    const r = computeProviderMatch(stepKeys, r2live);
    expect(r.matched).toBe(50);
  });
  it('BLOCKED exactly 10% not blocked, >10% blocked', () => {
    expect(isRemovalBlocked(35, 350)).toBe(false);
    expect(isRemovalBlocked(36, 350)).toBe(true);
    expect(isRemovalBlocked(39, 350)).toBe(true);
  });
});

describe('pagination ROUND64', () => {
  it('detectNextPage reads next, Link, has_more', () => {
    expect(detectNextPage({next:'https://x/models?cursor=2'}).url).toBe('https://x/models?cursor=2');
    expect(detectNextPage({data:[]}, { get:(k:string)=> k==='link' ? '<https://x/2>; rel="next"' : null } as any).url).toBe('https://x/2');
    expect(detectNextPage({has_more:true, next_cursor:'c2'}).url).toBe('c2');
    expect(detectNextPage({data:[]}).url).toBeNull();
  });
  it('fetch follows next to second page', async () => {
    let calls = 0;
    const target = { id:'hf', label:'hf', prefix:'hf', baseUrl:'https://api.test', } as any;
    const fetchFn = async (url: string) => { calls++; return calls===1 ? fakeRes({data:[{id:'m1'}], next:'https://api.test/models?cursor=2'}) : fakeRes({data:[{id:'m2'}]}); };
    const out = await fetchModelList(target, { fetchFn: fetchFn as any });
    expect(out.models).toEqual(['m1','m2']); expect(out.pages).toBe(2); expect(out.incomplete).toBeFalsy(); expect(calls).toBe(2);
  });
  it('fetch marks INCOMPLETE when total exceeds fetched without next', async () => {
    const target = { id:'hf', label:'hf', prefix:'hf', baseUrl:'https://api.test' } as any;
    const fetchFn = async () => fakeRes({data:[{id:'m1'}], total: 74764});
    const out = await fetchModelList(target, { fetchFn: fetchFn as any });
    expect(out.incomplete).toBe(true); expect(out.error).toBe('incomplete-pagination');
  });
  it('SCAN_MAX_PAGES cap exists', () => { expect(SCAN_MAX_PAGES).toBe(20); });
});
