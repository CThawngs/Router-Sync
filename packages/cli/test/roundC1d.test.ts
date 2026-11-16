import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertWritePathAllowed, liveRouterDirs, grantLiveWriteToken, revokeLiveWriteToken } from '../src/sync/write.js';
import {
  buildModelProbeUrl,
  hfModelUrl,
  isInScannedList,
  confirmAbsent,
  dropDecision,
} from '../src/sync/confirm.js';
import { keySourceLabel } from '../src/sync/providers.js';
import { isSharedConnectionError, liveSuccessLabel, noLogsLabel, classifyModelLock } from '../src/commands/health.js';

// Fake fetch: map url -> status. Control 200, candidate theo bảng truyền vào.
function fakeFetch(table: Record<string, number>) {
  return async (url: string) => {
    const status = table[url] ?? 0;
    return { status, text: async () => (status === 200 ? '{"id":"x"}' : '') } as Response;
  };
}

describe('C1d D1.2 WRITE-GUARD canary', () => {
  it('chan path trong thu muc router that (frozen luc load)', () => {
    const dirs = liveRouterDirs();
    expect(dirs.length).toBeGreaterThan(0);
    const omni = dirs.find((d) => d.includes('omniroute'));
    expect(omni).toBeTruthy();
    expect(() => assertWritePathAllowed(path.join(omni!, 'storage.sqlite'))).toThrow(/WRITE-GUARD/);
  });
  it('cho phep path temp ngoai thu muc that', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c1d-'));
    try {
      expect(() => assertWritePathAllowed(path.join(tmp, 'db.sqlite'))).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it('test mode tu choi cung du co token (VITEST=1 gan san trong vitest)', () => {
    grantLiveWriteToken('x');
    const dirs = liveRouterDirs();
    expect(() => assertWritePathAllowed(path.join(dirs[0]!, 'x.sqlite'))).toThrow(/WRITE-GUARD/);
    revokeLiveWriteToken();
  });
});

describe('C1d D2 buildModelProbeUrl + PROBE-INVALID', () => {
  it('groq: bo tien to provider, candidate URL giong cach dung control', () => {
    expect(buildModelProbeUrl('https://api.groq.com/openai/v1', 'groq', 'groq/allam-2-7b'))
      .toBe('https://api.groq.com/openai/v1/models/allam-2-7b');
  });
  it('gemini: bo models/ thua lap lai', () => {
    expect(buildModelProbeUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini', 'gemini/models/models/gemini-2.5-flash'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash');
  });
  it('ma hoa tung doan, giu dau / cua id', () => {
    expect(buildModelProbeUrl('https://huggingface.co/api', 'hf', 'org/repo name'))
      .toBe('https://huggingface.co/api/models/org/repo%20name');
  });
  it('candidate trung id quet ma 404 => PROBE-INVALID, khong DROP-DEAD', () => {
    const target = { prefix: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k' } as never;
    const ctrl = buildModelProbeUrl('https://api.groq.com/openai/v1', 'groq', 'llama-3.3-70b-versatile');
    const cand = buildModelProbeUrl('https://api.groq.com/openai/v1', 'groq', 'groq/allam-2-7b');
    const table: Record<string, number> = { [ctrl]: 200, [cand]: 404 };
    return confirmAbsent(target, ['groq/allam-2-7b'], 'llama-3.3-70b-versatile', {
      fetchFn: fakeFetch(table) as never,
      controlIds: ['llama-3.3-70b-versatile'],
      knownIds: ['allam-2-7b', 'llama-3.3-70b-versatile'],
    }).then((res) => {
      expect(res.probeInvalid).toBe(true);
      expect(res.results[0]!.verdict).toBe('PROBE-INVALID');
      expect(dropDecision('PROBE-INVALID', 'COMPLETE', { controlsOk: true, secondSourceAbsent: true, probeInvalid: true })).toBe('DROP-HOLD');
    });
  });
  it('dedupe: moi id mot dong', () => {
    const target = { prefix: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k' } as never;
    const ctrl = buildModelProbeUrl('https://api.groq.com/openai/v1', 'groq', 'llama-3.3-70b-versatile');
    const cand = buildModelProbeUrl('https://api.groq.com/openai/v1', 'groq', 'some-id');
    const table: Record<string, number> = { [ctrl]: 200, [cand]: 404 };
    return confirmAbsent(target, ['some-id', 'some-id'], 'llama-3.3-70b-versatile', {
      fetchFn: fakeFetch(table) as never,
      controlIds: ['llama-3.3-70b-versatile'],
      knownIds: ['llama-3.3-70b-versatile'],
    }).then((res) => {
      expect(res.results).toHaveLength(1);
    });
  });
});

describe('C1d D3 hf nguon thu hai', () => {
  it('URL dung /api/models/{id}?expand[]=inferenceProviderMapping', () => {
    expect(hfModelUrl('Meta-Llama/Llama-3')).toBe(
      'https://huggingface.co/api/models/Meta-Llama/Llama-3?expand[]=inferenceProviderMapping'
    );
  });
  it('isInScannedList khong phan biet hoa thuong', () => {
    expect(isInScannedList('GPT-OSS-120B', ['gpt-oss-120b'])).toBe(true);
    expect(isInScannedList('zzz-missing', ['gpt-oss-120b'])).toBe(false);
  });
});

describe('C1d D4.2 BORROWED-KEY', () => {
  it('9router-key+9router la OWN-KEY, +omniroute la BORROWED-KEY', () => {
    expect(keySourceLabel('9router-key', '9router')).toContain('OWN-KEY');
    expect(keySourceLabel('9router-key', 'omniroute')).toContain('BORROWED-KEY');
    expect(keySourceLabel('omniroute-key')).toBe('omniroute-key');
  });
});

describe('C1d D5 nhan CONNECTION-ERROR / LIVE-SUCCESS / UNKNOWN', () => {
  it('n model cung dau 404 => CONNECTION-ERROR', () => {
    const errs = [
      { model: 'a', errorCode: 404, lastErrorAt: '2026-11-04T03:02:34.500Z' },
      { model: 'b', errorCode: 404, lastErrorAt: '2026-11-04T03:02:34.500Z' },
      { model: 'c', errorCode: 404, lastErrorAt: '2026-11-04T03:02:34.500Z' },
    ];
    expect(isSharedConnectionError(errs)).toBe(true);
    expect(isSharedConnectionError(errs.slice(0, 1))).toBe(false);
  });
  it('LIVE-SUCCESS tu usageHistory, khong UNKNOWN khi co lich su', () => {
    expect(liveSuccessLabel(486, '2026-11-04T08:44:00Z')).toContain('LIVE-SUCCESS');
    expect(liveSuccessLabel(0, null)).toBeNull();
  });
  it('thong nhat NO-LOGS -> UNKNOWN', () => {
    expect(noLogsLabel()).toBe('UNKNOWN');
  });
  it('khoa het han => LOCK-EXPIRED (khong co ma chet moi)', () => {
    const now = Date.parse('2026-11-04T04:00:00Z');
    const r = classifyModelLock(
      { modelLock_m: '2026-11-04T03:04:34.500Z' },
      'm',
      { now }
    );
    expect(r.label).toBe('LOCK-EXPIRED');
  });
});
