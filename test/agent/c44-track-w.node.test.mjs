// W1 + W3 + W5: kiểm thử cô lập cho tools/agent/c44-track-w.mjs (127.0.0.1:0 + os.tmpdir(), 0 chạm router thật).
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBetterSqlite3 } from '../../packages/core/dist/index.js';
import { applyPatch, applyPatchV2 } from '../../tools/agent/nine-router-patch.mjs';
import {
  MAX_TRACK_W_CHAT,
  MAX_TRACK_W_MODELS_GET,
  MAX_TRACK_W_CONSECUTIVE_429,
  classifyW1Blocking,
  runTrackWW1,
  runTrackWW3,
  runTrackWW5,
} from '../../tools/agent/c44-track-w.mjs';

const execFileAsync = promisify(execFile);
const TOOL_PATH = fileURLToPath(new URL('../../tools/agent/c44-track-w.mjs', import.meta.url));
const tempDirs = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'rs-track-w-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function buildCustomServerFixture(dir, mode = 'v3') {
  const base = [
    '"use strict";',
    'const http = require("http");',
    'const crypto = require("crypto");',
    'void crypto;',
    'const origCreate = http.createServer.bind(http);',
    'http.createServer = function (handler) {',
    '  return origCreate((req, res) => {',
    '    const viaProxy = false;',
    '    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";',
    '    return handler(req, res);',
    '  });',
    '};',
  ].join('\n');
  const patched = mode === 'v2' ? applyPatchV2(base).source : mode === 'v3' ? applyPatch(base).source : base;
  const target = join(dir, 'custom-server.js');
  const packageJson = join(dir, 'package.json');
  writeFileSync(target, patched, 'utf8');
  writeFileSync(packageJson, JSON.stringify({ name: '9router', version: '0.5.123' }), 'utf8');
  return { target, packageJson, pid: -1 };
}

function buildTempDb(dir, { hasRsFast = false, ponytailEnabled = true } = {}) {
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
    db.prepare('INSERT INTO combos (name, models) VALUES (?, ?)').run('9Router-Agent-1', JSON.stringify(['cf/m1']));
    if (hasRsFast) {
      db.prepare('INSERT INTO combos (name, models) VALUES (?, ?)').run('rs-fast', JSON.stringify(['cf/m1']));
    }
    db.prepare('INSERT INTO apiKeys (name, key, isActive, createdAt) VALUES (?, ?, 1, ?)').run(
      'track-w-key',
      'key-track-w-secret',
      '2026-11-23T00:00:00.000Z'
    );
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({ ponytailEnabled }));
  } finally {
    db.close();
  }
  return dbPath;
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object' && addr.port > 0);
  assert.notEqual(addr.port, 20128);
  assert.notEqual(addr.port, 30128);
  assert.notEqual(addr.port, 3128);
  try {
    return await run(addr.port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

describe('Track W (tools/agent/c44-track-w.mjs): trần cứng, cổng dry-run và bảo vệ 0 /v1/models cho w3', () => {
  test('hằng số trần Track W và cổng dry-run mặc định gửi đúng 0 HTTP request trên cả w1, w3, w5', async () => {
    assert.equal(MAX_TRACK_W_CHAT, 30);
    assert.equal(MAX_TRACK_W_MODELS_GET, 3);
    assert.equal(MAX_TRACK_W_CONSECUTIVE_429, 3);

    const dir = createTempDir();
    const dbPath = buildTempDb(dir, { hasRsFast: true });
    const statusOpts = buildCustomServerFixture(dir, 'v3');
    const ledgerPath = join(dir, 'ledger.json');
    let httpHits = 0;

    await withServer(
      (_req, res) => {
        httpHits += 1;
        res.end('{}');
      },
      async (port) => {
        const baseUrl = `http://127.0.0.1:${port}`;
        const r1 = await runTrackWW1({ baseUrl, dbPath, ledgerPath, statusOpts, log: () => undefined });
        const r3 = await runTrackWW3({
          baseUrl,
          dbPath,
          ledgerPath,
          statusOpts,
          pid: 4242,
          processStartMs: Date.now() - 8 * 3_600_000,
          processInfo: { rssMB: 180, cpuSec: 12.5, ageSec: 8 * 3600 },
          log: () => undefined,
        });
        const r5 = await runTrackWW5({ baseUrl, dbPath, ledgerPath, statusOpts, log: () => undefined });

        assert.equal(httpHits, 0);
        for (const r of [r1, r3, r5]) {
          assert.equal(r.dryRun, true);
          assert.equal(r.sentChat, 0);
          assert.equal(r.sentModelsGet, 0);
        }
      }
    );
  });

  test('classifyW1Blocking ghim đủ 3 kết luận và w1 đo đồng thời GET /v1/models + POST chat, từ chối patchV2=true', async () => {
    assert.equal(
      classifyW1Blocking([
        { modelsStatus: 200, modelsTotalMs: 500, chatStatus: 200, chatHeaderMs: 120 },
        { modelsStatus: 200, modelsTotalMs: 520, chatStatus: 200, chatHeaderMs: 110 },
      ]),
      'không đủ dữ liệu'
    );
    assert.equal(
      classifyW1Blocking([
        { modelsStatus: 200, modelsTotalMs: 500, chatStatus: 429, chatHeaderMs: 90 },
        { modelsStatus: 200, modelsTotalMs: 500, chatStatus: 200, chatHeaderMs: 90 },
        { modelsStatus: 200, modelsTotalMs: 500, chatStatus: 200, chatHeaderMs: 90 },
      ]),
      'không đủ dữ liệu'
    );
    assert.equal(
      classifyW1Blocking([
        { modelsStatus: 200, modelsTotalMs: 3100, chatStatus: 200, chatHeaderMs: 200 },
        { modelsStatus: 200, modelsTotalMs: 600, chatStatus: 200, chatHeaderMs: 150 },
        { modelsStatus: 200, modelsTotalMs: 600, chatStatus: 200, chatHeaderMs: 150 },
      ]),
      'còn nghẽn'
    );
    assert.equal(
      classifyW1Blocking([
        { modelsStatus: 200, modelsTotalMs: 2200, chatStatus: 200, chatHeaderMs: 1800 },
        { modelsStatus: 200, modelsTotalMs: 500, chatStatus: 200, chatHeaderMs: 150 },
        { modelsStatus: 200, modelsTotalMs: 500, chatStatus: 200, chatHeaderMs: 150 },
      ]),
      'còn nghẽn'
    );
    assert.equal(
      classifyW1Blocking([
        { modelsStatus: 200, modelsTotalMs: 2200, chatStatus: 200, chatHeaderMs: 400 },
        { modelsStatus: 200, modelsTotalMs: 800, chatStatus: 200, chatHeaderMs: 750 },
        { modelsStatus: 200, modelsTotalMs: 450, chatStatus: 200, chatHeaderMs: 120 },
      ]),
      'hết nghẽn'
    );

    const dir = createTempDir();
    const dbPath = buildTempDb(dir);
    const v2Status = buildCustomServerFixture(createTempDir(), 'v2');
    const v3Status = buildCustomServerFixture(createTempDir(), 'none');
    let modelsInFlight = 0;
    let chatSawModelsInFlight = 0;

    await withServer(
      (req, res) => {
        if (req.url === '/v1/models') {
          modelsInFlight += 1;
          setTimeout(() => {
            modelsInFlight -= 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'cf/m1' }] }));
          }, 40);
          return;
        }
        if (modelsInFlight > 0) chatSawModelsInFlight += 1;
        req.on('data', () => undefined);
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
        });
      },
      async (port) => {
        const baseUrl = `http://127.0.0.1:${port}`;
        const refusedV2 = await runTrackWW1({
          baseUrl,
          dbPath,
          ledger: {},
          statusOpts: v2Status,
          yesSpendTokens: true,
          sleepImpl: async () => undefined,
          log: () => undefined,
        });
        assert.equal(refusedV2.reason, 'patchV2_present');
        assert.equal(refusedV2.sentChat, 0);
        assert.equal(refusedV2.sentModelsGet, 0);

        const logs = [];
        const live = await runTrackWW1({
          baseUrl,
          dbPath,
          ledger: {},
          statusOpts: v3Status,
          yesSpendTokens: true,
          intervalMs: 0,
          sleepImpl: async () => undefined,
          log: (l) => logs.push(l),
        });
        assert.equal(live.sentModelsGet, 3);
        assert.equal(live.sentChat, 3);
        assert.equal(chatSawModelsInFlight, 3, 'POST chat phải được gửi ngay khi GET /v1/models đang bay');
        assert.equal(live.conclusion, 'hết nghẽn');
        assert.deepEqual(live.reconciliation, { sentRequests: 3, usageHistoryRows: 0, delta: 3 });
        assert.ok(logs.some((l) => l.includes('W1_CONCLUSION=hết nghẽn')));
        assert.equal(logs.join('\n').includes('key-track-w-secret'), false);
      }
    );
  });

  test('w3 tuyệt đối gửi 0 GET /v1/models, bỏ qua khi chưa đủ tuổi hoặc đã khởi động lại, và dừng ngay ở lần treo đầu kèm usageRows', async () => {
    const dir = createTempDir();
    const dbPath = buildTempDb(dir);
    const statusOpts = buildCustomServerFixture(dir, 'none');
    let modelsHits = 0;
    let chatHits = 0;
    let shouldHang = false;

    await withServer(
      (req, res) => {
        if (req.url?.includes('/v1/models')) {
          modelsHits += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          void raw;
          chatHits += 1;
          if (shouldHang) {
            const db = openBetterSqlite3(dbPath);
            try {
              db.prepare(
                'INSERT INTO usageHistory (timestamp, provider, model, status, promptTokens, completionTokens) VALUES (?, ?, ?, ?, ?, ?)'
              ).run(new Date().toISOString(), 'cf', 'm1', 'ok', 2912, 4);
            } finally {
              db.close();
            }
            // Treo sau khi đã ghi usageHistory để kích hoạt HANG-AFTER-USAGE
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
        });
      },
      async (port) => {
        const baseUrl = `http://127.0.0.1:${port}`;
        const ledger = {};
        const tStart = Date.parse('2026-11-23T00:00:00.000Z');

        // 1) Chưa đủ tuổi (2h < 5.5h): thiết lập baseline, gửi 0 chat, 0 /v1/models
        const young = await runTrackWW3({
          baseUrl,
          dbPath,
          ledger,
          statusOpts,
          yesSpendTokens: true,
          minAgeHours: 5.5,
          pid: 7777,
          processStartMs: tStart,
          now: () => tStart + 2 * 3_600_000,
          processInfo: { rssMB: 150, cpuSec: 5, ageSec: 7200 },
          log: () => undefined,
        });
        assert.equal(young.sentChat, 0);
        assert.equal(young.sentModelsGet, 0);
        assert.equal(young.sample.restarted, false);
        assert.equal(chatHits, 0);
        assert.equal(modelsHits, 0);

        // 2) Đổi PID (restarted === true): gửi 0 chat, 0 /v1/models
        const restarted = await runTrackWW3({
          baseUrl,
          dbPath,
          ledger,
          statusOpts,
          yesSpendTokens: true,
          minAgeHours: 5.5,
          pid: 8888,
          processStartMs: tStart + 3 * 3_600_000,
          now: () => tStart + 10 * 3_600_000,
          processInfo: { rssMB: 140, cpuSec: 2, ageSec: 25200 },
          log: () => undefined,
        });
        assert.equal(restarted.sample.restarted, true);
        assert.equal(restarted.sentChat, 0);
        assert.equal(chatHits, 0);
        assert.equal(modelsHits, 0);

        // 3) Đủ tuổi (~6h) với đúng baseline PID 7777 nhưng treo ở ngay lượt 1 -> dừng ngay, không gửi lượt 2-3!
        shouldHang = true;
        const hangLogs = [];
        const hung = await runTrackWW3({
          baseUrl,
          dbPath,
          ledger,
          statusOpts,
          yesSpendTokens: true,
          minAgeHours: 5.5,
          pid: 7777,
          processStartMs: tStart,
          now: () => Date.now(),
          timeoutMs: 80,
          pollMs: 15,
          pollSleepImpl: async (ms) => new Promise((r) => setTimeout(r, ms)),
          processInfo: { rssMB: 210, cpuSec: 30, ageSec: 6 * 3600 },
          log: (l) => hangLogs.push(l),
        });
        assert.equal(modelsHits, 0, 'w3 tuyệt đối không được gọi GET /v1/models');
        assert.equal(hung.sentModelsGet, 0);
        assert.equal(hung.sentChat, 1, 'phải dừng ngay sau lần treo đầu tiên ở mốc tuổi đó');
        assert.equal(chatHits, 1);
        assert.equal(hung.rows[0].verdict, 'HANG-AFTER-USAGE');
        assert.equal(hung.rows[0].usageRows.length, 1);
        assert.ok(hangLogs.some((l) => l.startsWith('W3_HANG_TRACE ') && l.includes('HANG-AFTER-USAGE')));
      }
    );
  });

  test('w5 in W5_RS_FAST=chưa đo reason=combo_not_in_db (0 request) khi thiếu rs-fast, và gộp sổ cái w1+w3+w5 khóa chặt ở 30 chat + 3 GET + dừng ngay khi 3x429', async () => {
    const dir = createTempDir();
    const dbWithoutRsFast = buildTempDb(dir, { hasRsFast: false });
    const dirWithRs = createTempDir();
    const dbWithRsFast = buildTempDb(dirWithRs, { hasRsFast: true });
    const statusOpts = buildCustomServerFixture(dir, 'none');
    const ledgerPath = join(dir, 'track-w-ledger.json');

    let modelsHits = 0;
    let chatHits = 0;

    await withServer(
      (req, res) => {
        if (req.url?.includes('/v1/models')) {
          modelsHits += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'cf/m1' }] }));
          return;
        }
        req.on('data', () => undefined);
        req.on('end', () => {
          chatHits += 1;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
        });
      },
      async (port) => {
        const baseUrl = `http://127.0.0.1:${port}`;

        // Khi thiếu rs-fast -> 0 request, log đúng chuẩn
        const missingLogs = [];
        const w5Missing = await runTrackWW5({
          baseUrl,
          dbPath: dbWithoutRsFast,
          ledgerPath,
          statusOpts,
          yesSpendTokens: true,
          log: (l) => missingLogs.push(l),
        });
        assert.equal(w5Missing.sentChat, 0);
        assert.equal(chatHits, 0);
        assert.ok(missingLogs.includes('W5_RS_FAST=chưa đo reason=combo_not_in_db'));

        // Chạy đủ chu trình Track W dùng chung ledgerPath:
        // 1) w1: 3 GET + 3 chat
        const w1Out = await runTrackWW1({
          baseUrl,
          dbPath: dbWithRsFast,
          ledgerPath,
          statusOpts,
          yesSpendTokens: true,
          intervalMs: 0,
          sleepImpl: async () => undefined,
          log: () => undefined,
        });
        assert.equal(w1Out.sentModelsGet, 3);
        assert.equal(w1Out.sentChat, 3);

        // 2) w3 qua 3 mốc tuổi (~6h, ~24h, ~48h): 3 × 3 = 9 chat, 0 GET /v1/models
        const baseStartMs = Date.parse('2026-11-20T00:00:00.000Z');
        for (const [ageH, minH] of [
          [6, 5.5],
          [24, 23.5],
          [48, 47.5],
        ]) {
          const w3Out = await runTrackWW3({
            baseUrl,
            dbPath: dbWithRsFast,
            ledgerPath,
            statusOpts,
            yesSpendTokens: true,
            minAgeHours: minH,
            pid: 9001,
            processStartMs: baseStartMs,
            now: () => baseStartMs + ageH * 3_600_000,
            processInfo: { rssMB: 190, cpuSec: ageH * 3, ageSec: ageH * 3600 },
            log: () => undefined,
          });
          assert.equal(w3Out.sentChat, 3);
          assert.equal(w3Out.sentModelsGet, 0);
        }
        assert.equal(modelsHits, 3, 'w3 qua 3 mốc tuổi không được tăng bất kỳ GET /v1/models nào');
        assert.equal(chatHits, 12);

        // 3) w5 (khi có rs-fast): 18 chat -> cộng dồn = 30 chat + 3 GET
        const w5Out = await runTrackWW5({
          baseUrl,
          dbPath: dbWithRsFast,
          ledgerPath,
          statusOpts,
          yesSpendTokens: true,
          seed: 11,
          gapMs: 0,
          sleepImpl: async () => undefined,
          log: () => undefined,
        });
        assert.equal(w5Out.sentChat, 18);
        assert.equal(w5Out.sentModelsGet, 0);
        assert.equal(chatHits, 30);
        assert.equal(modelsHits, 3);

        const persisted = JSON.parse(readFileSync(ledgerPath, 'utf8'));
        assert.equal(persisted.chatSent, 30);
        assert.equal(persisted.modelsGetSent, 3);

        // 4) Request chat thứ 31 và GET thứ 4 phải bị từ chối tuyệt đối (0 HTTP request mới)
        const w3Refused = await runTrackWW3({
          baseUrl,
          dbPath: dbWithRsFast,
          ledgerPath,
          statusOpts,
          yesSpendTokens: true,
          minAgeHours: 47.5,
          pid: 9001,
          processStartMs: baseStartMs,
          now: () => baseStartMs + 50 * 3_600_000,
          processInfo: { rssMB: 190, cpuSec: 150, ageSec: 50 * 3600 },
          log: () => undefined,
        });
        assert.equal(w3Refused.sentChat, 0);
        assert.equal(w3Refused.reason, 'insufficient_track_w_budget');

        const w1Refused = await runTrackWW1({
          baseUrl,
          dbPath: dbWithRsFast,
          ledgerPath,
          statusOpts,
          yesSpendTokens: true,
          intervalMs: 0,
          sleepImpl: async () => undefined,
          log: () => undefined,
        });
        assert.equal(w1Refused.sentModelsGet, 0);
        assert.equal(w1Refused.sentChat, 0);
        assert.equal(w1Refused.reason, 'insufficient_track_w_budget');
        assert.equal(chatHits, 30);
        assert.equal(modelsHits, 3);
      }
    );

    // 5) 3 lần 429 liên tiếp dừng ngay lập tức (stoppedEarly: '3x429') và khoá sổ cái
    let hits429 = 0;
    await withServer(
      (req, res) => {
        req.on('data', () => undefined);
        req.on('end', () => {
          hits429 += 1;
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end('{"error":"FreeUsageLimitError"}');
        });
      },
      async (port) => {
        const baseUrl = `http://127.0.0.1:${port}`;
        const ledger429 = {};
        const out429 = await runTrackWW5({
          baseUrl,
          dbPath: dbWithRsFast,
          ledger: ledger429,
          statusOpts,
          yesSpendTokens: true,
          seed: 3,
          gapMs: 0,
          sleepImpl: async () => undefined,
          log: () => undefined,
        });
        assert.ok(hits429 >= 3 && hits429 <= 4, `phải dừng ngay khi chạm ngưỡng 3x429 (thực tế=${hits429})`);
        assert.equal(out429.stoppedEarly, '3x429');
        assert.equal(ledger429.haltedReason, '3x429');

        const hitsAfterHalt = hits429;
        const afterHalt = await runTrackWW3({
          baseUrl,
          dbPath: dbWithRsFast,
          ledger: ledger429,
          statusOpts,
          yesSpendTokens: true,
          minAgeHours: 5.5,
          pid: 1234,
          processStartMs: Date.now() - 10 * 3_600_000,
          processInfo: { rssMB: 100, cpuSec: 10, ageSec: 36000 },
          log: () => undefined,
        });
        assert.equal(afterHalt.sentChat, 0);
        assert.equal(hits429, hitsAfterHalt);
      }
    );
  });

  test('CLI entrypoint hỗ trợ đầy đủ cờ --base-url, --db-path, --ledger, --interval-ms, --min-age-hours, --yes-spend-tokens', async () => {
    const dir = createTempDir();
    const dbPath = buildTempDb(dir, { hasRsFast: false });
    const statusOpts = buildCustomServerFixture(dir, 'none');
    const ledgerPath = join(dir, 'cli-ledger.json');
    let hits = 0;

    await withServer(
      (req, res) => {
        hits += 1;
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'cf/m1' }] }));
          return;
        }
        req.on('data', () => undefined);
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
        });
      },
      async (port) => {
        const baseUrl = `http://127.0.0.1:${port}`;
        const dryRes = await execFileAsync(process.execPath, [
          TOOL_PATH,
          'w1',
          '--base-url',
          baseUrl,
          '--db-path',
          dbPath,
          '--ledger',
          ledgerPath,
          '--interval-ms',
          '0',
          '--target',
          statusOpts.target,
          '--package-json',
          statusOpts.packageJson,
        ]);
        assert.equal(hits, 0);
        assert.match(dryRes.stdout, /W1_DRY_RUN/);

        const w5Res = await execFileAsync(process.execPath, [
          TOOL_PATH,
          'w5',
          '--base-url',
          baseUrl,
          '--db-path',
          dbPath,
          '--ledger',
          ledgerPath,
          '--target',
          statusOpts.target,
          '--package-json',
          statusOpts.packageJson,
          '--yes-spend-tokens',
        ]);
        assert.equal(hits, 0);
        assert.match(w5Res.stdout, /W5_RS_FAST=chưa đo reason=combo_not_in_db/);
      }
    );
  });
});
