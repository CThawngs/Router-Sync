// R1.1 + W2: combos probe --concurrency <1|2>, promptTokens + đối chiếu usageHistory trong os.tmpdir(), 0 chạm router thật.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openBetterSqlite3 } from '@routersync/core';
import { runCombosProbeCommand } from '../src/commands/combos-probe.js';
import { createCliProgram } from '../src/index.js';

const tempDirs: string[] = [];
const prevEnvDb = process.env['ROUTERSYNC_9ROUTER_DB'];

beforeEach(() => {
  // Đảm bảo ngay cả khi chạy Red-First hay đột biến M2 cũng không bao giờ rơi về DB thật của máy chủ.
  process.env['ROUTERSYNC_9ROUTER_DB'] = join(tmpdir(), 'rs-nonexistent-hermetic-guard.sqlite');
});

function makeTemp9RouterDb(opts: { apiKey?: string; combos?: Array<{ name: string; models: string[] }> } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'rs-probe-r1-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'data.sqlite');
  const db = openBetterSqlite3(dbPath, { restrictToDir: dir });
  try {
    db.exec(`
      CREATE TABLE combos (name TEXT PRIMARY KEY, models TEXT NOT NULL);
      CREATE TABLE apiKeys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, key TEXT NOT NULL, isActive INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL);
      CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE usageHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT,
        promptTokens INTEGER,
        completionTokens INTEGER
      );
    `);
    const combos = opts.combos ?? [{ name: 'rs-fast', models: ['cf/m1', 'groq/m2'] }];
    for (const c of combos) {
      db.prepare('INSERT INTO combos (name, models) VALUES (?, ?)').run(c.name, JSON.stringify(c.models));
    }
    db.prepare('INSERT INTO apiKeys (name, key, isActive, createdAt) VALUES (?, ?, 1, ?)').run(
      'temp-key',
      opts.apiKey ?? 'key-r1-isolated',
      '2026-11-23T00:00:00.000Z'
    );
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({ ponytailEnabled: true }));
  } finally {
    db.close();
  }
  return dbPath;
}

afterEach(() => {
  if (prevEnvDb === undefined) delete process.env['ROUTERSYNC_9ROUTER_DB'];
  else process.env['ROUTERSYNC_9ROUTER_DB'] = prevEnvDb;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('R1.1: combos probe --concurrency <1|2> và promptTokens từ usageHistory', () => {
  it('từ chối mọi giá trị concurrency ngoài 1 hoặc 2 ngay cả khi dry-run (0 request)', async () => {
    const fetchImpl = vi.fn();
    for (const bad of [0, 3, -1, 1.5, Number.NaN]) {
      await expect(
        runCombosProbeCommand({
          mode: 'combo',
          concurrency: bad,
          state: { combos: [{ name: 'c1', steps: ['p/m'] }], apiKey: 'k', apiKeyName: 'fake' },
          fetchImpl: fetchImpl as unknown as typeof fetch,
          log: () => undefined,
        })
      ).rejects.toThrow('--concurrency must be 1 or 2');
    }
    expect(fetchImpl).not.toHaveBeenCalled();

    const program = createCliProgram();
    program.exitOverride();
    await expect(
      program.parseAsync(['node', 'routersync', 'combos', 'probe', '--combo', 'c1', '--concurrency', '3'])
    ).rejects.toThrow('--concurrency must be 1 or 2');
  });

  it('ghi nhận promptTokens và completionTokens từ DB tạm ngay cả khi timeline=false, không lộ apiKey', async () => {
    const secretKey = 'key-secret-do-not-leak';
    const dbPath = makeTemp9RouterDb({ apiKey: secretKey });
    let reqCount = 0;

    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        reqCount += 1;
        const parsed = JSON.parse(raw) as { stream?: boolean };
        const db = openBetterSqlite3(dbPath);
        try {
          db.prepare(
            'INSERT INTO usageHistory (timestamp, provider, model, status, promptTokens, completionTokens) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(
            new Date().toISOString(),
            'cf',
            'm1',
            'ok',
            parsed.stream === false ? 18 : 2912,
            5
          );
        } finally {
          db.close();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"choices":[{"message":{"content":"ok"}}]}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    expect(port).not.toBe(20128);
    expect(port).not.toBe(30128);

    try {
      const logs: string[] = [];
      const reportOn = await runCombosProbeCommand({
        mode: 'combo',
        combos: ['rs-fast'],
        dbPath,
        baseUrl: `http://127.0.0.1:${port}`,
        yesSpendTokens: true,
        stream: true,
        log: (l) => logs.push(l),
      });
      expect(reqCount).toBe(1);
      expect(reportOn.rows).toHaveLength(1);
      expect(reportOn.rows[0]?.promptTokens).toBe(2912);
      expect(reportOn.rows[0]?.completionTokens).toBe(5);
      expect(reportOn.rows[0]?.usageServedBy).toBe('cf/m1');
      expect(logs.join('\n')).toContain('tokens_in=2912');
      expect(logs.join('\n')).not.toContain(secretKey);

      const timelineLogs: string[] = [];
      const reportOff = await runCombosProbeCommand({
        mode: 'combo',
        combos: ['rs-fast'],
        dbPath,
        baseUrl: `http://127.0.0.1:${port}`,
        yesSpendTokens: true,
        stream: false,
        timeline: true,
        log: (l) => timelineLogs.push(l),
      });
      expect(reportOff.rows[0]?.promptTokens).toBe(18);
      expect(reportOff.rows[0]?.usageRows?.[0]?.promptTokens).toBe(18);
      expect(timelineLogs.join('\n')).toContain('tokens_in=18 tokens_out=5');
      expect(timelineLogs.join('\n')).not.toContain(secretKey);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('concurrency=2 bắn cặp song song thật (peakInFlight === 2) và không gửi nửa cặp khi thiếu ngân sách', async () => {
    const dbPath = makeTemp9RouterDb();
    let inFlight = 0;
    let peakInFlight = 0;
    let totalHits = 0;

    const server = http.createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        totalHits += 1;
        inFlight += 1;
        if (inFlight > peakInFlight) peakInFlight = inFlight;
        setTimeout(() => {
          inFlight -= 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"choices":[{"message":{"content":"ok"}}]}');
        }, 60);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const report = await runCombosProbeCommand({
        mode: 'combo',
        combos: ['rs-fast'],
        dbPath,
        baseUrl,
        yesSpendTokens: true,
        concurrency: 2,
        repeat: 2,
        budget: 3,
        log: () => undefined,
      });
      expect(peakInFlight).toBe(2);
      expect(totalHits).toBe(2);
      expect(report.rows).toHaveLength(2);
      expect(report.stoppedEarly).toBe('budget=3');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('W2: stream=true ghi 0 dòng usageHistory, đếm ngân sách phía client, đối chiếu delta và SKIPPED-QUOTA mode combo', () => {
  it('dừng đúng --budget khi stream=true ghi 0 dòng usageHistory, in quota=1 cho combo 429 FreeUsageLimitError và bỏ qua ở lần chạy sau', async () => {
    const dbPath = makeTemp9RouterDb({
      combos: [
        { name: '9Router-Agent-1', models: ['cf/m1'] },
        { name: 'rs-fast', models: ['oc/quota-step'] },
      ],
    });
    const hits: Array<{ model: string; stream: boolean }> = [];

    // Mô phỏng đúng hành vi 9router@0.5.123 (C44 §1.2):
    // stream=true (200 OK hoặc 429) ghi 0 dòng vào usageHistory; stream=false ghi 1 dòng.
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(raw) as { model: string; stream?: boolean };
        const isStream = parsed.stream !== false;
        hits.push({ model: parsed.model, stream: isStream });
        if (!isStream) {
          const db = openBetterSqlite3(dbPath);
          try {
            db.prepare(
              'INSERT INTO usageHistory (timestamp, provider, model, status, promptTokens, completionTokens) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(new Date().toISOString(), 'cf', 'm1', 'ok', 18, 4);
          } finally {
            db.close();
          }
        }
        if (parsed.model === 'rs-fast') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'FreeUsageLimitError: free usage limit reached' } }));
          return;
        }
        res.writeHead(200, { 'content-type': isStream ? 'text/event-stream' : 'application/json' });
        res.end(isStream ? 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n' : '{"choices":[{"message":{"content":"ok"}}]}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    expect(port).not.toBe(20128);
    expect(port).not.toBe(30128);
    expect(port).not.toBe(3128);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Lượt 1: stream=true (0 dòng usageHistory), repeat=2 cho 2 combo (4 lượt tiềm năng), budget=3 -> dừng đúng ở 3.
      const run1Logs: string[] = [];
      const report1 = await runCombosProbeCommand({
        mode: 'combo',
        combos: ['9Router-Agent-1', 'rs-fast'],
        repeat: 2,
        budget: 3,
        stream: true,
        comboTimeoutMs: 5_000,
        yesSpendTokens: true,
        dbPath,
        baseUrl,
        log: (l) => run1Logs.push(l),
      });

      expect(hits).toHaveLength(3);
      expect(report1.stoppedEarly).toBe('budget=3');
      expect(report1.requests).toEqual({
        total: 3,
        limit: 3,
        byProvider: { '9Router-Agent-1': 2, 'rs-fast': 1 },
      });
      expect(report1.reconciliation).toEqual({
        sentRequests: 3,
        usageHistoryRows: 0,
        delta: 3,
      });
      const rsFastRow = report1.rows.find((r) => r.combo === 'rs-fast');
      expect(rsFastRow?.httpStatus).toBe(429);
      expect(rsFastRow?.quota).toBe(true);
      expect(run1Logs.some((l) => l.startsWith('rs-fast\t') && l.includes('http=429') && l.includes('\tquota=1\tat='))).toBe(true);
      expect(run1Logs.join('\n')).toContain('đối chiếu usage: sent=3 usageHistory=0 lệch=3');

      // Lượt 2: lưu log lượt 1 và chạy lại với --skip-quota-from cho rs-fast -> 0 HTTP request được gửi!
      const dir = mkdtempSync(join(tmpdir(), 'rs-probe-skip-'));
      tempDirs.push(dir);
      const priorLog = join(dir, 'run1.out.txt');
      writeFileSync(priorLog, run1Logs.join('\n'), 'utf8');

      const hitsBeforeRun2 = hits.length;
      const run2Logs: string[] = [];
      const report2 = await runCombosProbeCommand({
        mode: 'combo',
        combos: ['rs-fast'],
        comboTimeoutMs: 5_000,
        yesSpendTokens: true,
        skipQuotaFrom: [priorLog],
        dbPath,
        baseUrl,
        log: (l) => run2Logs.push(l),
      });

      expect(hits.length).toBe(hitsBeforeRun2);
      expect(report2.requests?.total).toBe(0);
      expect(report2.skippedQuota).toContain('rs-fast');
      expect(run2Logs.some((l) => l.includes('rs-fast\tSKIPPED-QUOTA\thttp=-\ttotal=0ms\tusage=-\tquota=1'))).toBe(true);

      // Lượt 3: stream=false ghi 1 dòng vào usageHistory -> đối chiếu delta = 0.
      const run3Logs: string[] = [];
      const report3 = await runCombosProbeCommand({
        mode: 'combo',
        combos: ['9Router-Agent-1'],
        stream: false,
        comboTimeoutMs: 5_000,
        yesSpendTokens: true,
        dbPath,
        baseUrl,
        log: (l) => run3Logs.push(l),
      });
      expect(report3.reconciliation).toEqual({
        sentRequests: 1,
        usageHistoryRows: 1,
        delta: 0,
      });
      expect(run3Logs.join('\n')).toContain('đối chiếu usage: sent=1 usageHistory=1 lệch=0');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
