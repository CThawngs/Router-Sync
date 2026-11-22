// C35 R1.4: router watch — đo /v1/models, bucket RAM, dừng sớm, mutation.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureModels, runRouterWatch, summarize, type WatchSample } from '../src/commands/router-watch.js';

function sample(partial: Partial<WatchSample>): WatchSample {
  return {
    t: '2026-11-22T00:00:00.000Z',
    freeMemMB: 1000,
    load1: 0,
    routerRssMB: 100,
    routerCpuSec: 10,
    routerAgeSec: 1000,
    modelsMs: 100,
    modelsStatus: 200,
    ...partial,
  };
}

describe('C35 R1: đo /v1/models', () => {
  it('đo được cả khi fetch lỗi', async () => {
    const res = await measureModels('http://x', (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch);
    expect(res.status).toBeNull();
    expect(typeof res.ms).toBe('number');
  });

  it('đo thời gian phản hồi 200', async () => {
    const res = await measureModels('http://x', (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch);
    expect(res.status).toBe(200);
  });
});

describe('C35 R1.5: summarize', () => {
  it('tính phân vị theo khoảng RAM và để trống khi < 5 mẫu', () => {
    const samples = [
      ...Array.from({ length: 6 }, (_, i) => sample({ freeMemMB: 500, modelsMs: 100 + i })),
      ...Array.from({ length: 2 }, () => sample({ freeMemMB: 2000, modelsMs: 10 })),
    ];
    const s = summarize(samples);
    const low = s.rows.find((r) => r.bucket === 'ram <600 MB');
    const high = s.rows.find((r) => r.bucket === 'ram >1500 MB');
    expect(low?.n).toBe(6);
    // p50 theo nearest-rank: ceil(0.5*6)=3 -> phần tử thứ 3 (100,101,102,...)
    expect(low?.modelsP50).toBe(102);
    expect(high?.n).toBe(2);
    expect(high?.modelsP50).toBeNull();
  });

  it('mutation: nếu ô thiếu mẫu vẫn tính p50 thì test đỏ', () => {
    const samples = [sample({ freeMemMB: 2000, modelsMs: 10 }), sample({ freeMemMB: 2000, modelsMs: 20 })];
    const s = summarize(samples);
    const high = s.rows.find((r) => r.bucket === 'ram >1500 MB');
    expect(high?.n).toBe(2);
    expect(high?.modelsP50).toBeNull();
  });
});

describe('C35 R1: watch ghi JSONL và dừng đúng hạn', () => {
  it('ghi mỗi dòng là một JSON hợp lệ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-watch-'));
    const out = join(dir, 'watch.jsonl');
    try {
      // Đồng hồ giả: mỗi lần "ngủ" tiến 1 giây, nên 1 phút = 60 mẫu mà không chờ thật.
      // Trỏ launcher.pid sang file không tồn tại: bỏ qua việc spawn Get-Process mỗi mẫu.
      const prev = process.env['ROUTERSYNC_9ROUTER_LAUNCHER_PID'];
      process.env['ROUTERSYNC_9ROUTER_LAUNCHER_PID'] = join(dir, 'no-such-pid.json');
      let clock = 0;
      const res = await runRouterWatch({
        minutes: 1,
        intervalSec: 1,
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
        sleep: async () => {
          clock += 1_000;
        },
        now: () => clock,
        log: () => undefined,
        out,
      });
      expect(res.samples).toBeGreaterThan(0);
      expect(res.samples).toBeLessThanOrEqual(61);
      if (prev === undefined) delete process.env['ROUTERSYNC_9ROUTER_LAUNCHER_PID'];
      else process.env['ROUTERSYNC_9ROUTER_LAUNCHER_PID'] = prev;
      const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean);
      expect(lines.length).toBe(res.samples);
      for (const l of lines) expect(typeof JSON.parse(l).freeMemMB).toBe('number');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('tổng số mẫu bị chặn bởi thời gian', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-watch-'));
    try {
      let clock = 0;
      const res = await runRouterWatch({
        minutes: 1,
        intervalSec: 10,
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
        sleep: async () => {
          clock += 10_000;
        },
        now: () => clock,
        log: () => undefined,
        out: join(dir, 'w.jsonl'),
      });
      // 60 s / 10 s = 6 mẫu tối đa
      expect(res.samples).toBeLessThanOrEqual(7);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});