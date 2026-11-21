// C33 N1.2: `callComboWithUsage` với máy chủ giả — chậm, treo, header muộn.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { callComboWithUsage } from '../src/commands/combos-probe.js';

let server: http.Server;
let baseUrl = '';

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
      // header sau 400 ms: chậm vừa phải
      if (model === 'slow/model') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"choices":[{"message":{"content":"ok"}}]}');
        }, 400);
        return;
      }
      // không bao giờ trả header
      if (model === 'hang/model') return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[{"message":{"content":"ok"}}]}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const body = { model: 'x', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: true };

describe('C33 N1.2: callComboWithUsage', () => {
  it('header sớm → OK, firstUsageMs = null khi không có dòng usage', async () => {
    const res = await callComboWithUsage(
      `${baseUrl}/v1/chat/completions`,
      'k',
      { ...body, model: 'ok/model' },
      2000,
      globalThis.fetch,
      () => 10,
      20
    );
    expect(res.row.verdict).toBe('OK');
    expect(res.row.headerMs).not.toBeNull();
    expect(res.firstUsageMs).toBeNull();
  });

  it('header sau 400 ms → vẫn OK (dưới ngưỡng 120 s)', async () => {
    const res = await callComboWithUsage(
      `${baseUrl}/v1/chat/completions`,
      'k',
      { ...body, model: 'slow/model' },
      3000,
      globalThis.fetch,
      () => 10,
      20
    );
    expect(res.row.verdict).toBe('OK');
    expect(res.row.headerMs ?? 0).toBeGreaterThanOrEqual(350);
  });

  it('treo + có dòng usage trước hạn → HANG-AFTER-USAGE, ghi firstUsageMs', async () => {
    let n = 10;
    const usage = () => {
      n += 1;
      return n;
    };
    const res = await callComboWithUsage(
      `${baseUrl}/v1/chat/completions`,
      'k',
      { ...body, model: 'hang/model' },
      300,
      globalThis.fetch,
      usage,
      50
    );
    expect(res.row.verdict).toBe('HANG-AFTER-USAGE');
    expect(res.row.headerMs).toBeNull();
    expect(res.firstUsageMs).not.toBeNull();
  });

  it('treo + không có dòng usage → HANG-NO-USAGE', async () => {
    const res = await callComboWithUsage(
      `${baseUrl}/v1/chat/completions`,
      'k',
      { ...body, model: 'hang/model' },
      300,
      globalThis.fetch,
      () => 10,
      50
    );
    expect(res.row.verdict).toBe('HANG-NO-USAGE');
    expect(res.firstUsageMs).toBeNull();
  });
});