// R1.1: combos probe --concurrency <1|2>, promptTokens từ usageHistory trong os.tmpdir(), 0 chạm router thật.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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
