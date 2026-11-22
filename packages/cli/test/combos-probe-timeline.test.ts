// C34 Q2.5: timeline ghi mọi dòng usage, max_tokens tới hạn, repeat ở mode step.
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { callComboWithUsage, MAX_TOKENS_LIMIT, perComboConclusion } from '../src/commands/combos-probe.js';

let server: http.Server;
let baseUrl = '';

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': slow\n\n');
        setTimeout(() => res.end('data: [DONE]\n\n'), 300);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

const body = { model: 'x', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: true };

describe('C34 Q2.5: timeline và trần max_tokens', () => {
  it('trần max_tokens là 64', () => {
    expect(MAX_TOKENS_LIMIT).toBe(64);
  });

  it('timeline: ghi nhiều dòng usage mới, không chỉ dòng đầu', async () => {
    await startServer();
    try {
      const rows = [
        { atMs: 10, provider: 'p1', model: 'm1', status: 'ok', completionTokens: 3 },
        { atMs: 20, provider: 'p2', model: 'm2', status: 'ok', completionTokens: 5 },
        { atMs: 30, provider: 'p3', model: 'm3', status: 'error', completionTokens: null },
      ];
      // Trả về cả ba dòng: timeline phải giữ mọi dòng, không chỉ dòng đầu.
      const usageRows = () => rows;
      const res = await callComboWithUsage(
        `${baseUrl}/v1/chat/completions`,
        'k',
        body,
        3000,
        globalThis.fetch,
        () => 10 + rows.length,
        20,
        undefined,
        undefined,
        usageRows,
        true
      );
      expect(res.usage.length).toBeGreaterThanOrEqual(2);
      expect(res.row.usageRows?.length).toBe(res.usage.length);
      expect(res.row.verdict === 'OK' || res.row.verdict === 'SLOW-OK').toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('mutation: nếu perComboConclusion trả OK khi không có header thì test đỏ', () => {
    const hang = perComboConclusion({ headerMs: null, deadlineMs: 100, firstUsageMs: 10, timedOut: true });
    expect(hang).toBe('HANG-AFTER-USAGE');
    expect(hang === 'OK').toBe(false);
  });
});