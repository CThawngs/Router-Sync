// V3 + R2 + W2: phân loại độ ổn định từng bước, LOW-SAMPLE, và bảo vệ apiKey='' / chuẩn hoá #2 trong combos-reliability.
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { labelStep, runReliability, summarizeAttempts, RELIABLE_OK_MIN } from '../src/commands/combos-reliability.js';
import type { ComboProbeRow } from '../src/commands/combos-probe.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

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

describe('W2: combos-reliability bảo toàn quota=1 khi apiKey === "", chuẩn hoá #2 từ --from và dừng sớm theo maxConsecutive429', () => {
  it('bảo toàn quota=1 trên phản hồi 429 FreeUsageLimitError ngay cả khi apiKey === "" (diệt lỗi RegExp rỗng)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-rel-empty-key-'));
    tempDirs.push(dir);
    const prevAppData = process.env['APPDATA'];
    process.env['APPDATA'] = join(dir, 'no-appdata');
    const fromFile = join(dir, 'single.out.txt');
    writeFileSync(fromFile, 'oc/free-model\tOK\thttp=200\ttotal=15ms\tusage=-\n', 'utf8');

    const server = http.createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'FreeUsageLimitError: free usage limit reached' } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const logs: string[] = [];
      await runReliability({
        from: fromFile,
        apiKey: '',
        dbPath: join(dir, 'missing.sqlite'),
        baseUrl: `http://127.0.0.1:${port}`,
        repeat: 1,
        rounds: 1,
        gapSec: 0,
        sleepImpl: async () => undefined,
        log: (l) => logs.push(l),
      });
      const quotaLine = logs.find((l) => l.startsWith('oc/free-model\tRATE-LIMITED\t'));
      expect(quotaLine).toBeDefined();
      expect(quotaLine).toContain('\tquota=1\tat=');
    } finally {
      if (prevAppData === undefined) delete process.env['APPDATA'];
      else process.env['APPDATA'] = prevAppData;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('gộp hậu tố #1/#2 trong --from, bỏ qua qua --skip-quota-from với 0 HTTP call và dừng sớm theo maxConsecutive429', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-rel-w2-'));
    tempDirs.push(dir);
    const fromFile = join(dir, 'probe-step.out.txt');
    writeFileSync(
      fromFile,
      [
        'oc/free-model#1\tOK\thttp=200\ttotal=15ms\tusage=-',
        'oc/free-model#2\tOK\thttp=200\ttotal=16ms\tusage=-',
        'groq/fast-model#2\tOK\thttp=200\ttotal=12ms\tusage=-',
      ].join('\n'),
      'utf8'
    );

    const calledModels: string[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(raw) as { model: string };
        calledModels.push(parsed.model);
        if (parsed.model === 'oc/free-model') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'FreeUsageLimitError: free usage limit reached' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    expect(port).not.toBe(20128);
    expect(port).not.toBe(30128);
    const baseUrl = `http://127.0.0.1:${port}`;
    const fixedNow = Date.parse('2026-11-23T12:00:00.000Z');

    try {
      const logs1: string[] = [];
      const res1 = await runReliability({
        from: fromFile,
        apiKey: '',
        dbPath: join(dir, 'missing.sqlite'),
        baseUrl,
        repeat: 1,
        rounds: 1,
        gapSec: 0,
        now: () => fixedNow,
        sleepImpl: async () => undefined,
        log: (l) => logs1.push(l),
      });

      expect(calledModels.sort()).toEqual(['groq/fast-model', 'oc/free-model']);
      expect(res1.steps.map((s) => s.step).sort()).toEqual(['groq/fast-model', 'oc/free-model']);

      const skipFile = join(dir, 'prior-step.out.txt');
      writeFileSync(
        skipFile,
        `oc/free-model#2\tRATE-LIMITED\thttp=429\ttotal=10ms\tusage=-\tquota=1\tat=2026-11-23T11:55:00.000Z\n`,
        'utf8'
      );
      calledModels.length = 0;
      const logs2: string[] = [];
      const res2 = await runReliability({
        from: fromFile,
        apiKey: '',
        dbPath: join(dir, 'missing.sqlite'),
        baseUrl,
        repeat: 1,
        rounds: 1,
        gapSec: 0,
        skipQuotaFrom: [skipFile],
        now: () => fixedNow,
        sleepImpl: async () => undefined,
        log: (l) => logs2.push(l),
      });

      expect(calledModels).toEqual(['groq/fast-model']);
      expect(res2.skippedQuota).toContain('oc/free-model');
      expect(logs2.some((l) => l.includes('oc/free-model\tSKIPPED-QUOTA\thttp=-\ttotal=0ms\tusage=-\tquota=1'))).toBe(true);

      const onlyQuotaFile = join(dir, 'only-quota.out.txt');
      writeFileSync(onlyQuotaFile, 'oc/free-model\tOK\thttp=200\ttotal=10ms\tusage=-\n', 'utf8');
      calledModels.length = 0;
      await runReliability({
        from: onlyQuotaFile,
        apiKey: '',
        dbPath: join(dir, 'missing.sqlite'),
        baseUrl,
        repeat: 4,
        rounds: 1,
        gapSec: 0,
        maxConsecutive429: 2,
        now: () => fixedNow,
        sleepImpl: async () => undefined,
        log: () => undefined,
      });
      expect(calledModels).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
