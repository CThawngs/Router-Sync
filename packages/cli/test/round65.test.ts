import { describe, it, expect } from 'vitest';
import { confirmAbsent, dropDecision, verdictForStatus, normalizeKey, nearestLive } from '../src/sync/confirm.js';
import { applyKeepHead } from '../src/commands/autopilot.js';
import { canonicalKey, canonicalProvider, providerWideZero } from '../src/commands/discover.js';
import { classifyLock, sanitizeError } from '../src/commands/health.js';

function fakeFetch(map: Record<string, number>) {
  return async (url: string) => {
    const id = decodeURIComponent(url.split('/models/')[1] ?? '');
    return { ok: (map[id] ?? 404) < 400, status: map[id] ?? 404 } as any;
  };
}
const target = { id: 'hf', label: 'hf', prefix: 'hf', baseUrl: 'https://api.test' } as any;

describe('confirmAbsent ROUND65', () => {
  it('control 200 + 404 => CONFIRMED-ABSENT, 200 => STILL-EXISTS', async () => {
    const r = await confirmAbsent(target, ['gone', 'here'], 'control', { fetchFn: fakeFetch({ control: 200, gone: 404, here: 200 }) as any });
    expect(r.supported).toBe(true);
    expect(r.results.map((x) => x.verdict)).toEqual(['CONFIRMED-ABSENT', 'STILL-EXISTS']);
  });
  it('control not 200 => UNSUPPORTED, no verdicts', async () => {
    const r = await confirmAbsent(target, ['a'], 'control', { fetchFn: fakeFetch({ control: 401, a: 404 }) as any });
    expect(r.supported).toBe(false); expect(r.results[0]!.verdict).toBe('UNSUPPORTED');
  });
  it('429 => QUOTA, 401 => AUTH', () => {
    expect(verdictForStatus(429)).toBe('QUOTA'); expect(verdictForStatus(401)).toBe('AUTH'); expect(verdictForStatus(0)).toBe('UNKNOWN');
  });
  it('caps at 30 ids', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `m${i}`);
    const r = await confirmAbsent(target, ids, 'control', { fetchFn: fakeFetch({ control: 200 }) as any });
    expect(r.results.length).toBe(30);
  });
  it('normalize strips . and -free; nearestLive picks close id', () => {
    expect(normalizeKey('A.B-free')).toBe('a-b'); expect(normalizeKey('x:free')).toBe('x');
    const near = nearestLive('claude-sonnet-4-6', ['claude-sonnet-4-5', 'gpt-5']);
    expect(near[0]).toBe('claude-sonnet-4-5');
  });
});

describe('dropDecision ROUND65', () => {
  it('CONFIRMED-ABSENT => DROP-DEAD; UNKNOWN+UNKNOWN => HOLD; UNSUPPORTED+COMPLETE => DEAD; UNSUPPORTED+PARTIAL => HOLD', () => {
    expect(dropDecision('CONFIRMED-ABSENT', 'UNKNOWN')).toBe('DROP-DEAD');
    expect(dropDecision('UNKNOWN', 'UNKNOWN')).toBe('DROP-HOLD');
    expect(dropDecision('STILL-EXISTS', 'COMPLETE')).toBe('DROP-HOLD');
    expect(dropDecision('UNSUPPORTED', 'COMPLETE')).toBe('DROP-DEAD');
    expect(dropDecision('UNSUPPORTED', 'PARTIAL')).toBe('DROP-HOLD');
  });
});

describe('applyKeepHead ROUND65', () => {
  it('keepHead=0 keeps old behavior (all orderable)', () => {
    const r = applyKeepHead(['a', 'b', 'c'], 0);
    expect(r.head).toEqual([]); expect(r.orderable).toEqual(['a', 'b', 'c']);
  });
  it('keepHead=7 keeps first 7, head never reordered', () => {
    const m = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const r = applyKeepHead(m, 7);
    expect(r.head).toEqual(m.slice(0, 7)); expect(r.orderable).toEqual(['8', '9']);
  });
});

describe('discover ROUND65', () => {
  it('alias oc/opencode same canonical; -free stripped for dedupe', () => {
    expect(canonicalProvider('oc')).toBe('opencode'); expect(canonicalProvider('hf')).toBe('huggingface');
    expect(canonicalKey('oc', 'Crouton-Alpha-Free')).toBe(canonicalKey('opencode', 'crouton-alpha'));
  });
  it('PRICE-PROVIDER-WIDE-ZERO at 60% zero', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, inputPrice: i < 3 ? 0 : 1, outputPrice: i < 3 ? 0 : 1, priceFields: ['pricing'] })) as any[];
    const r = providerWideZero(entries);
    expect(r.ratio).toBeCloseTo(0.6); expect(r.wideZero).toBe(true);
  });
  it('not wide-zero at 40% zero', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, inputPrice: i < 2 ? 0 : 1, outputPrice: i < 2 ? 0 : 1, priceFields: ['pricing'] })) as any[];
    expect(providerWideZero(entries).wideZero).toBe(false);
  });
});

describe('health ROUND65', () => {
  it('classifyLock QUOTA when rateLimitedUntil future', () => {
    const future = Date.now() + 3600_000;
    expect(classifyLock({ modelLock_x: { rateLimitedUntil: future } })).toBe('QUOTA');
  });
  it('classifyLock LOCK-EXPIRED / OK / KHONG CÓ KHÓA', () => {
    expect(classifyLock({ modelLock_x: { until: Date.now() - 1000 } })).toBe('LOCK-EXPIRED');
    expect(classifyLock({})).toBe('KHONG CÓ KHÓA');
    expect(classifyLock({ modelLock_x: {} })).toBe('OK');
  });
  it('sanitizeError masks sk- keys, truncates 80', () => {
    const s = sanitizeError(`err sk-abcd1234 done`);
    expect(s).not.toContain('abcd1234'); expect(s.length).toBeLessThanOrEqual(80);
  });
});
