// C32 M1.6: chạy `combos probe` trên máy chủ HTTP giả (không chạm router thật).
//
// Các nhánh: 200, 410, 503, 429, 401, treo không header, header rồi treo;
// kiểm hạn thời gian; kiểm dừng sau 5 lần 429 liên tiếp.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runCombosProbeCommand, type RouterDb } from '../src/commands/combos-probe.js';

let server: http.Server;
let baseUrl = '';

const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let model = '';
      try {
        model = JSON.parse(body).model ?? '';
      } catch {
        model = '';
      }
      hits.push(model);

      // Không header, không thân: client phải tự hết hạn.
      if (model === 'hang/model') return;
      // Header 200 rồi treo.
      if (model === 'headershang/model') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': ping\n\n');
        return;
      }
      // Mọi model "limited/*" đều trả 429.
      if (model.startsWith('limited/')) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('{"error":"Too Many Requests"}');
        return;
      }
      const byModel: Record<string, [number, string]> = {
        'ok/model': [200, '{"choices":[{"message":{"content":"ok"}}]}'],
        'gone/model': [410, '{"title":"Gone","detail":"has reached its end of life"}'],
        'noprov/model': [503, '{"error":"no provider serves this model anymore"}'],
        'limited/model': [429, '{"error":"Too Many Requests"}'],
        'auth/model': [401, '{"error":"unauthorized"}'],
      };
      const [status, payload] = byModel[model] ?? [500, '{"error":"boom"}'];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function stateFor(steps: string[]): RouterDb {
  return { combos: [{ name: 'probe-combo', steps }], apiKey: 'test-key-not-real', apiKeyName: 'fake' };
}

const noopLog = () => undefined;

describe('C32 M1.6: combos probe trên máy chủ giả', () => {
  it('phân loại 200/410/503/429/401', async () => {
    const report = await runCombosProbeCommand({
      mode: 'step',
      baseUrl,
      state: stateFor(['ok/model', 'gone/model', 'noprov/model', 'limited/model', 'auth/model']),
      yesSpendTokens: true,
      stepTimeoutMs: 5000,
      log: noopLog,
    });
    const byModel = new Map(report.rows.map((r) => [r.model, r.verdict]));
    expect(byModel.get('ok/model')).toBe('OK');
    expect(byModel.get('gone/model')).toBe('EOL-GONE');
    expect(byModel.get('noprov/model')).toBe('NO-PROVIDER');
    expect(byModel.get('limited/model')).toBe('RATE-LIMITED');
    expect(byModel.get('auth/model')).toBe('AUTH');
  });

  it('treo không header → TIMEOUT-NO-HEADER và có hạn', async () => {
    const t0 = Date.now();
    const report = await runCombosProbeCommand({
      mode: 'step',
      baseUrl,
      state: stateFor(['hang/model']),
      yesSpendTokens: true,
      stepTimeoutMs: 1200,
      log: noopLog,
    });
    const elapsed = Date.now() - t0;
    expect(report.rows[0]?.verdict).toBe('TIMEOUT-NO-HEADER');
    expect(elapsed).toBeLessThan(10_000);
  });

  it('header rồi treo → vẫn kết thúc, không kẹt', async () => {
    const report = await runCombosProbeCommand({
      mode: 'step',
      baseUrl,
      state: stateFor(['headershang/model']),
      yesSpendTokens: true,
      stepTimeoutMs: 1200,
      log: noopLog,
    });
    expect(report.rows.length).toBe(1);
  });

  it('dừng sau 5 lần 429 liên tiếp', async () => {
    const steps = Array.from({ length: 8 }, (_, i) => `limited/${i}`);
    const report = await runCombosProbeCommand({
      mode: 'step',
      baseUrl,
      state: stateFor(steps),
      yesSpendTokens: true,
      stepTimeoutMs: 3000,
      log: noopLog,
    });
    expect(report.rows.length).toBe(5);
    expect(report.stoppedEarly).toMatch(/429/);
  });

  it('mode combo: gửi model = tên combo', async () => {
    const before = hits.length;
    const report = await runCombosProbeCommand({
      mode: 'combo',
      baseUrl,
      state: stateFor(['ok/model']),
      yesSpendTokens: true,
      comboTimeoutMs: 5000,
      log: noopLog,
    });
    expect(report.mode).toBe('combo');
    expect(report.rows.length).toBe(1);
    expect(hits.slice(before)).toContain('probe-combo');
  });

  it('dry-run không gọi mạng', async () => {
    const before = hits.length;
    const report = await runCombosProbeCommand({
      mode: 'step',
      baseUrl,
      state: stateFor(['ok/model']),
      log: noopLog,
    });
    expect(report.stoppedEarly).toBe('dry-run');
    expect(hits.length).toBe(before);
  });
});