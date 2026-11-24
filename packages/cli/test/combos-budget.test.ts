import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_REQUEST_BUDGET,
  RequestBudget,
  classifyStep,
  interleaveProviders,
  maxConsecutiveSameProvider,
  providerDelayMs,
  providerOf,
  recentQuotaSteps,
  reconcileSentVsUsage,
} from '../src/commands/combos-budget.js';
import { runCombosProbeCommand } from '../src/commands/combos-probe.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('C40 X0: phân loại quota', () => {
  it('429 FreeUsageLimitError là RATE-LIMITED có chú thích quota', () => {
    const result = classifyStep({ verdict: 'RATE-LIMITED', body: 'FreeUsageLimitError: free usage limit reached' });
    expect(result.verdict).toBe('RATE-LIMITED');
    expect(result.quota).toBe(true);
  });

  it('429 thường không có chú thích quota', () => {
    const result = classifyStep({ verdict: 'RATE-LIMITED', body: 'too many requests' });
    expect(result.quota).toBe(false);
  });

  it('OK thì không gắn quota dù thân có chữ quota', () => {
    expect(classifyStep({ verdict: 'OK', body: 'quota hidden in text' }).quota).toBe(false);
  });
});

describe('C40 X0: ngân sách và nhịp provider', () => {
  it('mặc định 40 request', () => {
    expect(DEFAULT_REQUEST_BUDGET).toBe(40);
  });

  it('dừng đúng ngân sách, đếm theo provider', () => {
    const b = new RequestBudget(2);
    expect(b.reserve('oc')).toBe(true);
    expect(b.reserve('oc')).toBe(true);
    expect(b.reserve('groq')).toBe(false);
    expect(b.count).toBe(2);
    expect(b.tally()).toContain('requests=2/2');
    expect(b.tally()).toContain('oc:2');
    expect(b.unmeasured(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd']);
  });

  it('xen kẽ provider, không quá 3 bước liên tiếp', () => {
    const steps = ['oc/a', 'oc/b', 'oc/c', 'oc/d', 'groq/e', 'cf/f'];
    const out = interleaveProviders(steps);
    expect(out).toHaveLength(steps.length);
    expect([...out].sort()).toEqual([...steps].sort());
    expect(maxConsecutiveSameProvider(out)).toBeLessThanOrEqual(3);
    expect(providerOf('nvidia/nvidia/x')).toBe('nvidia');
  });

  it('cách 3 giây giữa hai request cùng provider', () => {
    expect(providerDelayMs('oc', 'oc', 1_000, 2_000)).toBe(2000);
    expect(providerDelayMs('oc', 'groq', 1_000, 2_000)).toBe(0);
    expect(providerDelayMs(null, 'oc', null, 2_000)).toBe(0);
  });

  it('bỏ qua bước 429/quota trong cửa sổ 30 phút', () => {
    const now = Date.parse('2026-11-22T10:00:00Z');
    const text = [
      `oc/a\tRATE-LIMITED\thttp=429\ttotal=1ms\tusage=-\tquota=1\tat=2026-11-22T09:55:00Z`,
      `oc/old\tRATE-LIMITED\thttp=429\ttotal=1ms\tusage=-\tquota=1\tat=2026-11-22T08:00:00Z`,
      'groq/ok\tOK\thttp=200\ttotal=3ms\tusage=-',
    ].join('\n');
    expect(recentQuotaSteps(text, now)).toEqual(['oc/a']);
  });
});

describe('W2: chuẩn hoá recentQuotaSteps (#<attempt> + combo http=429) và reconcileSentVsUsage', () => {
  it('recentQuotaSteps cắt hậu tố #1/#2 và nhận diện dòng combo http=429 + quota=1 trong cửa sổ 30 phút', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    const text = [
      `oc/a#1\tRATE-LIMITED\thttp=429\ttotal=10ms\tusage=-\tquota=1\tat=2026-11-23T11:50:00Z`,
      `oc/a#2\tRATE-LIMITED\thttp=429\ttotal=11ms\tusage=-\tquota=1\tat=2026-11-23T11:51:00Z`,
      `rs-fast\tOK\thttp=429\theader=14ms\tfirstByte=15ms\ttotal=15ms\ttokens_in=-\tusageAt=-ms\tusage=không có dòng usage\tquota=1\tat=2026-11-23T11:52:00Z`,
      `9Router-Agent-1#2\tSLOW-OK\thttp=429\ttotal=20ms\tFreeUsageLimitError: limit reached\tat=2026-11-23T11:55:00Z`,
      `rs-old\tOK\thttp=429\ttotal=12ms\tusage=-\tquota=1\tat=2026-11-23T10:00:00Z`,
      `rs-plain-429\tOK\thttp=429\ttotal=12ms\tusage=-\ttoo many requests\tat=2026-11-23T11:58:00Z`,
    ].join('\n');
    expect(recentQuotaSteps(text, now)).toEqual(['oc/a', 'rs-fast', '9Router-Agent-1']);
  });

  it('reconcileSentVsUsage tính đúng độ lệch giữa client sent và usageHistory rows, kèm byProviderObject', () => {
    expect(reconcileSentVsUsage(9, 0)).toEqual({
      sentRequests: 9,
      usageHistoryRows: 0,
      delta: 9,
    });
    expect(reconcileSentVsUsage(18, 9)).toEqual({
      sentRequests: 18,
      usageHistoryRows: 9,
      delta: 9,
    });

    const b = new RequestBudget(5);
    expect(b.reserve('oc')).toBe(true);
    expect(b.reserve('cf')).toBe(true);
    expect(b.reserve('oc')).toBe(true);
    expect(b.byProviderObject()).toEqual({ cf: 1, oc: 2 });
  });
});

describe('C40 X0: thử thật với máy chủ giả', () => {
  it('dừng ở budget, bước SKIPPED-QUOTA không gửi request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-budget-'));
    tempDirs.push(dir);
    const skip = join(dir, 'prior.out.txt');
    writeFileSync(
      skip,
      `oc/skipped\tRATE-LIMITED\thttp=429\ttotal=1ms\tusage=-\tquota=1\tat=${new Date().toISOString()}\n`,
      'utf8'
    );

    const hits: string[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const model = String((JSON.parse(raw) as { model: string }).model);
        hits.push(model);
        const quota = model.includes('quota') || model.includes('normal');
        res.writeHead(quota ? 429 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: quota ? 'FreeUsageLimitError' : 'ok' } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const lines: string[] = [];
      const report = await runCombosProbeCommand({
        mode: 'step',
        combos: [],
        state: {
          combos: [{ name: 'c', steps: ['oc/skipped', 'oc/quota', 'oc/normal', 'groq/last'] }],
          apiKey: 'not-a-real-key',
          apiKeyName: 'test',
        },
        yesSpendTokens: true,
        budget: 2,
        skipQuotaFrom: [skip],
        baseUrl: `http://127.0.0.1:${port}`,
        sleepImpl: async () => undefined,
        log: (line) => lines.push(line),
      });
      expect(hits).toHaveLength(2);
      expect(hits).not.toContain('oc/skipped');
      expect([...hits].sort()).toEqual(['groq/last', 'oc/normal']);
      expect(report.rows).toHaveLength(2);
      expect(report.requests?.total).toBe(2);
      expect(report.skippedQuota).toContain('oc/skipped');
      expect(lines.some((l) => l.includes('SKIPPED-QUOTA'))).toBe(true);
      expect(lines.some((l) => l.includes('quota=1'))).toBe(true);
      expect(lines.some((l) => l.includes('dừng sớm: budget=2'))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('mutation: bỏ kiểm tra --budget thì test đỏ', () => {
    const source = readFileSync(
      new URL('../src/commands/combos-probe.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain('if (!budget.reserve(provider))');
    expect(source).toContain('if (!budget.reserve(combo.name))');
  });
});
