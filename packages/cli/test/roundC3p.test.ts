/**
 * packages/cli/test/roundC3p.test.ts
 * C3p: khóa P1 (perNodeConclusion/hostSkewLines), P3 (computeCoverage),
 * P4c (classifyNetworkError + refused cổng đóng thật + stepExistsLabel UNSTABLE).
 */
import { describe, it, expect } from 'vitest';
import * as net from 'node:net';
import { perNodeConclusion, hostSkewLines } from '../src/commands/scan.js';
import { computeCoverage } from '../src/commands/health.js';
import { classifyNetworkError, fetchModelList } from '../src/sync/providers.js';
import { stepExistsLabel } from '../src/sync/step-exists.js';

describe('C3p P1 perNodeConclusion', () => {
  it('stable 3 vòng giống nhau -> STABLE-UNCONFIRMED, diff rỗng', () => {
    const r = perNodeConclusion([['a', 'b'], ['b', 'a'], ['a', 'b']]);
    expect(r.conclusion).toBe('STABLE-UNCONFIRMED');
    expect(r.stable).toBe(true);
    expect(r.diff).toEqual([]);
  });
  it('khác nhau -> UNSTABLE + hiệu đối xứng (tối đa 30)', () => {
    const many = Array.from({ length: 40 }, (_, i) => `m${i}`);
    const r = perNodeConclusion([many, ['a-x'], many]);
    expect(r.conclusion).toBe('UNSTABLE');
    expect(r.diff.length).toBe(30);
    expect(r.diff).toContain('a-x');
  });
});

describe('C3p P1 hostSkewLines', () => {
  it('cùng host băm khác -> HOST-LỆCH + conclusion=UNSTABLE', () => {
    const lines = hostSkewLines([
      { id: '9router:provider-o', host: 'h1', hash: 'aaa' },
      { id: 'omniroute:provider-o', host: 'h1', hash: 'bbb' },
    ]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('HOST-LỆCH');
    expect(lines[0]).toContain('conclusion=UNSTABLE');
  });
  it('cùng host băm giống -> không dòng', () => {
    expect(hostSkewLines([
      { id: 'a', host: 'h1', hash: 'aaa' },
      { id: 'b', host: 'h1', hash: 'aaa' },
      { id: 'c', host: 'h2', hash: 'zzz' },
    ])).toEqual([]);
  });
});

describe('C3p P3 computeCoverage', () => {
  it('tập rời nhau, tổng = số cặp', () => {
    const pairs = new Set(['a:1', 'a:2', 'a:3', 'a:4', 'a:5']);
    const c = computeCoverage(pairs, new Set(['a:1', 'a:2']), new Set(['a:3']));
    expect(c.ok).toEqual(['a:1', 'a:2']);
    expect(c.quota).toEqual(['a:3']);
    expect(c.unscanned).toEqual(['a:4', 'a:5']);
    expect(c.rows).toEqual([2, 1, 2]);
    expect(c.ok.length + c.quota.length + c.unscanned.length).toBe(5);
  });
  it('không chồng chéo ok/quota', () => {
    const c = computeCoverage(new Set(['a:1', 'a:2']), new Set(['a:1']), new Set(['a:1', 'a:2']));
    expect(c.ok).toEqual(['a:1']);
    expect(c.quota).toEqual(['a:2']);
    expect(c.unscanned).toEqual([]);
  });
});

describe('C3p P4c classifyNetworkError', () => {
  it('cause.message="bad port" -> unknown (cổng bị chặn của fetch)', () => {
    expect(classifyNetworkError({ cause: { message: 'bad port' } })).toBe('unknown');
  });
  it('cause.errors[].code=ECONNREFUSED -> refused', () => {
    expect(classifyNetworkError({ cause: { errors: [{ code: 'ECONNREFUSED' }] } })).toBe('refused');
  });
  it('cổng đóng thật từ net.createServer().listen(0) -> refused', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const o = await fetchModelList(
      { id: 'x', label: 'x', prefix: 'x', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', keySource: '9router-key' },
      { timeoutMs: 3000, retryDelaysMs: [] },
    );
    expect(o.errorClass).toBe('refused');
  });
});

describe('C3p P1/P4 stepExistsLabel UNSTABLE', () => {
  it('conclusion UNSTABLE -> label UNSTABLE (HOST-LỆCH nối vào)', () => {
    expect(stepExistsLabel(200, new Set(['a']), 'a', 'a', { conclusion: 'UNSTABLE' })).toBe('UNSTABLE');
  });
});
