// R2 + R1.1: kiểm thử cô lập cho tools/agent/c43-track-r.mjs (127.0.0.1:0 + os.tmpdir(), 0 chạm router thật).
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBetterSqlite3 } from '../../packages/core/dist/index.js';
import { applyPatch, applyPatchV2 } from '../../tools/agent/nine-router-patch.mjs';
import {
  MAX_TRACK_R_REQUESTS,
  MAX_R1_CONSECUTIVE_429,
  DEFAULT_R1_TIMEOUT_MS,
  DEFAULT_R1_GAP_MS,
  checkR1Gate,
  classifyR1Matrix,
  runR1Matrix,
  runR2Offline,
} from '../../tools/agent/c43-track-r.mjs';

const tempDirs = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'rs-track-r-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const W4_FIXTURE = [
  'bước cần đo: 39 (giới hạn 70)',
  'cf/@cf/meta/llama-3.2-3b-instruct\tRELIABLE\tok=6/6\tp90=674ms',
  'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast\tRELIABLE\tok=6/6\tp90=719ms',
  'cf/@cf/mistralai/mistral-small-3.1-24b-instruct\tRELIABLE\tok=6/6\tp90=986ms',
  'cf/@cf/zai-org/glm-4.7-flash\tRELIABLE\tok=6/6\tp90=3080ms',
  'gemini/gemini-3.8-flash\tHANG\tok=0/6\tp90=3777ms',
  'gemini/gemini-4-hydrogen\tHANG\tok=1/6\tp90=17020ms',
  'groq/allam-2-7b\tRELIABLE\tok=6/6\tp90=1682ms',
  'groq/openai/gpt-oss-120b\tRELIABLE\tok=6/6\tp90=3122ms',
  'groq/openai/gpt-oss-20b\tRELIABLE\tok=6/6\tp90=684ms',
  'groq/qwen/qwen3.8-27b\tRELIABLE\tok=6/6\tp90=1525ms',
  'kc/nvidia/nemotron-3-ultra-550b-a55b:free\tRELIABLE\tok=6/6\tp90=2257ms',
  'nvidia/google/gemma-4-31b-it\tHANG\tok=0/6\tp90=-ms',
  'nvidia/meta/muse-glimmer-30b\tHANG\tok=0/6\tp90=-ms',
  'nvidia/nvidia/ising-calibration-1.5-31b\tRELIABLE\tok=6/6\tp90=895ms',
  'nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning\tRELIABLE\tok=6/6\tp90=1777ms',
  'nvidia/nvidia/nemotron-3-ultra-550b-a55b\tRELIABLE\tok=6/6\tp90=2243ms',
  'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b\tRELIABLE\tok=6/6\tp90=1754ms',
  'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b\tRELIABLE\tok=6/6\tp90=1884ms',
  'nvidia/nvidia/riva-translate-4b-instruct-v2\tRELIABLE\tok=6/6\tp90=1597ms',
  'nvidia/poolside/laguna-xs-2.1\tRELIABLE\tok=6/6\tp90=1653ms',
  'nvidia/stepfun-ai/step-5-preview\tHANG\tok=4/6\tp90=5354ms',
  'nvidia/z-ai/glm-5.3-flash\tHANG\tok=0/6\tp90=-ms',
].join('\n');

const X2_FIXTURE = [
  'oc/big-pickle\tRATE-LIMITED\tok=0/1\tp90=1597ms\tquota=1',
  'openrouter/baidu/ernie-5.5-flash-preview:free\tDEAD\tok=1/1\tp90=3312ms',
  'oc/deepseek-v4.1-flash-free\tRATE-LIMITED\tok=0/1\tp90=449ms\tquota=1',
  'openrouter/inclusionai/ling-3.2-flash:free\tDEAD\tok=0/1\tp90=5584ms',
  'oc/hy4-flash-free\tRATE-LIMITED\tok=0/1\tp90=791ms\tquota=1',
  'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free\tDEAD\tok=1/1\tp90=994ms',
  'oc/iceman-free\tRATE-LIMITED\tok=0/1\tp90=457ms\tquota=1',
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free\tDEAD\tok=1/1\tp90=1274ms',
  'oc/longcat-2.5-free\tRATE-LIMITED\tok=0/1\tp90=417ms\tquota=1',
  'openrouter/nvidia/nemotron-3.5-lightning:free\tDEAD\tok=1/1\tp90=872ms',
  'oc/mimo-v2.6-flash-free\tRATE-LIMITED\tok=0/1\tp90=2619ms\tquota=1',
  'openrouter/nvidia/nemotron-3.5-super-vl:free\tDEAD\tok=1/1\tp90=901ms',
  'oc/nemotron-3.5-lightning-free\tRATE-LIMITED\tok=0/1\tp90=583ms\tquota=1',
  'openrouter/openrouter/free\tDEAD\tok=1/1\tp90=845ms',
  'oc/nemotron-3.5-super-vl-free\tRATE-LIMITED\tok=0/1\tp90=2575ms\tquota=1',
  'openrouter/recursive/flint-v1.0:free\tDEAD\tok=1/1\tp90=1219ms',
  'oc/tidepool-alpha-free\tRATE-LIMITED\tok=0/1\tp90=1854ms\tquota=1',
].join('\n');

const COMBO_RS_C40 = [
  '# rs-fast (bản thật, C40)',
  'cf/@cf/meta/llama-3.2-3b-instruct',
  'groq/openai/gpt-oss-20b',
  'nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'kc/nvidia/nemotron-3-ultra-550b-a55b:free',
  'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'groq/qwen/qwen3.8-27b',
  'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
  'cf/@cf/mistralai/mistral-small-3.1-24b-instruct',
  'groq/allam-2-7b',
  'cf/@cf/zai-org/glm-4.7-flash',
  'groq/openai/gpt-oss-120b',
  '# rs-max (bản thật, C40)',
  'cf/@cf/meta/llama-3.2-3b-instruct',
  'groq/openai/gpt-oss-20b',
  'nvidia/poolside/laguna-xs-2.1',
  'kc/nvidia/nemotron-3-ultra-550b-a55b:free',
  'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'groq/qwen/qwen3.8-27b',
  'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
  'cf/@cf/mistralai/mistral-small-3.1-24b-instruct',
  'groq/allam-2-7b',
  'nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'cf/@cf/zai-org/glm-4.7-flash',
  'groq/openai/gpt-oss-120b',
  'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b',
  'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
].join('\n');

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
  return { target, packageJson };
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
      'track-r-key',
      'key-track-r-secret',
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
  try {
    return await run(addr.port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

describe('R2 + R1.1: tools/agent/c43-track-r.mjs', () => {
  test('hằng số bảo vệ khớp đặc tả C43/C43A', () => {
    assert.equal(MAX_TRACK_R_REQUESTS, 40);
    assert.equal(MAX_R1_CONSECUTIVE_429, 3);
    assert.equal(DEFAULT_R1_TIMEOUT_MS, 60_000);
    assert.equal(DEFAULT_R1_GAP_MS, 30_000);
  });

  test('Bước 1 (runR2Offline): tính lại ngoại tuyến 22 dòng w4 + 17 dòng x2, 0 request mạng', () => {
    const dir = createTempDir();
    const w4File = join(dir, 'w4.txt');
    const x2File = join(dir, 'x2.txt');
    const listsFile = join(dir, 'combo-rs.txt');
    writeFileSync(w4File, W4_FIXTURE, 'utf8');
    writeFileSync(x2File, X2_FIXTURE, 'utf8');
    writeFileSync(listsFile, COMBO_RS_C40, 'utf8');

    const logs = [];
    const summary = runR2Offline({ w4Path: w4File, x2Path: x2File, listsPath: listsFile, log: (l) => logs.push(l) });
    assert.equal(summary.changesCount, 7);
    assert.equal(summary.rsFastUnchanged, true);
    assert.deepEqual(summary.keptDead, ['openrouter/inclusionai/ling-3.2-flash:free']);
    assert.equal(summary.lowSampleCandidates.length, 7);
    assert.equal(summary.lowSampleCandidates[0].step, 'openrouter/openrouter/free');
    assert.equal(summary.lowSampleCandidates[0].p90Ms, 845);
    assert.equal(summary.lowSampleCandidates[6].p90Ms, 3312);
    assert.ok(logs.join('\n').includes('rsFastUnchanged=true'));
  });

  test('Bước 2 (checkR1Gate): chặn patchV2=true, chặn cổng đóng, chặn thiếu cờ và gửi đúng 0 GET /v1/models', async () => {
    const dir = createTempDir();
    const dbPath = buildTempDb(dir, { hasRsFast: false, ponytailEnabled: true });
    let httpHits = 0;

    await withServer(
      (_req, res) => {
        httpHits += 1;
        res.end('{}');
      },
      async (port) => {
        const baseUrl = `http://127.0.0.1:${port}`;
        const v2Files = buildCustomServerFixture(dir, 'v2');
        const logsV2 = [];
        const gateV2 = await checkR1Gate({
          baseUrl,
          dbPath,
          statusOpts: { target: v2Files.target, packageJson: v2Files.packageJson, pid: -1 },
          liveR1: true,
          yesSpendTokens: true,
          log: (l) => logsV2.push(l),
        });
        assert.equal(gateV2.allowed, false);
        assert.equal(gateV2.gate.patchV2, true);
        assert.ok(logsV2.some((l) => l.startsWith('R1_GATE ') && l.includes('patchV2=true') && l.includes('portListening=true')));
        assert.ok(logsV2.some((l) => l.startsWith('R1_STATUS=chưa đo reason=')));
        assert.equal(httpHits, 0, 'checkR1Gate không được gửi bất kỳ HTTP request nào');

        const v3Files = buildCustomServerFixture(dir, 'v3');
        const logsClosed = [];
        const gateClosed = await checkR1Gate({
          baseUrl: 'http://127.0.0.1:1',
          dbPath,
          statusOpts: { target: v3Files.target, packageJson: v3Files.packageJson, pid: -1 },
          tcpCheck: async () => false,
          liveR1: true,
          yesSpendTokens: true,
          log: (l) => logsClosed.push(l),
        });
        assert.equal(gateClosed.allowed, false);
        assert.ok(logsClosed.some((l) => l.startsWith('R1_STATUS=chưa đo reason=')));

        const logsNoFlag = [];
        const gateNoFlag = await checkR1Gate({
          baseUrl,
          dbPath,
          statusOpts: { target: v3Files.target, packageJson: v3Files.packageJson, pid: -1 },
          liveR1: false,
          yesSpendTokens: false,
          log: (l) => logsNoFlag.push(l),
        });
        assert.equal(gateNoFlag.allowed, false);
        assert.ok(logsNoFlag.some((l) => l.startsWith('R1_STATUS=chưa đo reason=')));
        assert.equal(httpHits, 0);
      }
    );
  });

  test('Bước 3 (runR1Matrix): chạy đủ 18 mẫu (3+3+6+6), 0 GET /v1/models, tôn trọng trần <= 40 và gapMs=30000 mặc định', async () => {
    const dir = createTempDir();
    const dbPath = buildTempDb(dir, { hasRsFast: false, ponytailEnabled: true });
    const v3Files = buildCustomServerFixture(dir, 'v3');
    const received = [];
    const sleepCalls = [];

    await withServer(
      (req, res) => {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          const parsed = raw ? JSON.parse(raw) : {};
          received.push({ method: req.method, url: req.url, body: parsed });
          const db = openBetterSqlite3(dbPath);
          try {
            db.prepare(
              'INSERT INTO usageHistory (timestamp, provider, model, status, promptTokens, completionTokens) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(new Date().toISOString(), 'cf', 'm1', 'ok', parsed.stream ? 2912 : 18, 4);
          } finally {
            db.close();
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"choices":[{"message":{"content":"ok"}}]}');
        });
      },
      async (port) => {
        const logs = [];
        const out = await runR1Matrix({
          baseUrl: `http://127.0.0.1:${port}`,
          dbPath,
          statusOpts: { target: v3Files.target, packageJson: v3Files.packageJson, pid: -1 },
          liveR1: true,
          yesSpendTokens: true,
          seed: 42,
          timeoutMs: 1000,
          sleepImpl: async (ms) => {
            sleepCalls.push(ms);
          },
          pollSleepImpl: async () => new Promise((r) => setTimeout(r, 10)),
          log: (l) => logs.push(l),
        });

        assert.equal(received.some((r) => r.url?.includes('/v1/models')), false, 'tuyệt đối không gọi GET /v1/models');
        assert.equal(received.length, 18);
        assert.ok(received.every((r) => r.body.max_tokens === 8 && r.body.messages?.[0]?.content === 'Trả lời đúng một từ: ok'));
        assert.ok(sleepCalls.includes(DEFAULT_R1_GAP_MS), 'mặc định gapMs phải là 30000 ms giữa các ô');
        assert.equal(out.totalRequests, 18);
        assert.equal(out.combos['9Router-Agent-1'].rows.length, 18);
        assert.equal(out.combos['9Router-Agent-1'].classification.label, 'không tái hiện trong 18 mẫu');
        assert.ok(logs.some((l) => l.includes('R1_RS_FAST=chưa đo reason=combo_not_in_db')));
        assert.equal(logs.join('\n').includes('key-track-r-secret'), false);
      }
    );
  });

  test('Bước 3: KHÔNG dừng ở lần treo đầu tiên, phát hiện "nghi đường stream" kèm cảnh báo nhiễu ponytailEnabled + promptTokens', async () => {
    const dir = createTempDir();
    const dbPath = buildTempDb(dir, { hasRsFast: false, ponytailEnabled: true });
    const v3Files = buildCustomServerFixture(dir, 'v3');

    await withServer(
      (req, res) => {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          const parsed = JSON.parse(raw);
          const db = openBetterSqlite3(dbPath);
          try {
            db.prepare(
              'INSERT INTO usageHistory (timestamp, provider, model, status, promptTokens, completionTokens) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(new Date().toISOString(), 'cf', 'm1', 'ok', parsed.stream ? 2912 : 18, 4);
          } finally {
            db.close();
          }
          if (parsed.stream === true) {
            // Cố ý treo không trả header để kiểm tra chạy hết đủ 18 mẫu + phát hiện nghi đường stream
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"choices":[{"message":{"content":"ok"}}]}');
        });
      },
      async (port) => {
        const logs = [];
        const out = await runR1Matrix({
          baseUrl: `http://127.0.0.1:${port}`,
          dbPath,
          statusOpts: { target: v3Files.target, packageJson: v3Files.packageJson, pid: -1 },
          liveR1: true,
          yesSpendTokens: true,
          seed: 7,
          timeoutMs: 60,
          gapMs: 0,
          sleepImpl: async () => undefined,
          pollSleepImpl: async () => new Promise((r) => setTimeout(r, 15)),
          log: (l) => logs.push(l),
        });

        const agent = out.combos['9Router-Agent-1'];
        assert.equal(agent.rows.length, 18, 'không được dừng sớm ở lần treo đầu tiên');
        assert.equal(agent.classification.label, 'nghi đường stream');
        assert.ok(agent.classification.confounderNote);
        assert.match(agent.classification.confounderNote, /ponytailEnabled=true/);
        assert.match(agent.classification.confounderNote, /2912/);
        assert.match(agent.classification.confounderNote, /18/);
        assert.ok(logs.some((l) => l.includes('ponytailEnabled=true') && l.includes('2912') && l.includes('18')));
      }
    );

    const concOnly = classifyR1Matrix(
      [
        { stream: true, concurrency: 1, verdict: 'OK', promptTokens: 2912 },
        { stream: false, concurrency: 1, verdict: 'OK', promptTokens: 18 },
        { stream: true, concurrency: 2, verdict: 'HANG-NO-USAGE', promptTokens: null },
      ],
      { stoppedEarly: null, ponytailEnabled: true }
    );
    assert.equal(concOnly.label, 'do đồng thời');
  });

  test('Bước 3: dừng ngay lập tức khi gặp 3 lần 429 liên tiếp và ép trần <= 40 request', async () => {
    const dir = createTempDir();
    const dbPath = buildTempDb(dir, { hasRsFast: true, ponytailEnabled: true });
    const v3Files = buildCustomServerFixture(dir, 'v3');
    let hits429 = 0;

    await withServer(
      (req, res) => {
        req.on('data', () => undefined);
        req.on('end', () => {
          hits429 += 1;
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end('{"error":"rate limited"}');
        });
      },
      async (port) => {
        const out = await runR1Matrix({
          baseUrl: `http://127.0.0.1:${port}`,
          dbPath,
          statusOpts: { target: v3Files.target, packageJson: v3Files.packageJson, pid: -1 },
          liveR1: true,
          yesSpendTokens: true,
          seed: 1,
          timeoutMs: 500,
          gapMs: 0,
          sleepImpl: async () => undefined,
          log: () => undefined,
        });
        assert.ok(hits429 >= 3 && hits429 <= 4, `phải dừng ngay sau ô chạm ngưỡng >=3 lần 429 (thực tế=${hits429})`);
        assert.equal(out.stoppedEarly, '3x429');
        assert.equal(out.combos['9Router-Agent-1'].classification.label, 'dừng sớm (3 lần 429 liên tiếp)');
      }
    );

    let capHits = 0;
    await withServer(
      (req, res) => {
        req.on('data', () => undefined);
        req.on('end', () => {
          capHits += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"choices":[{"message":{"content":"ok"}}]}');
        });
      },
      async (port) => {
        const outCap = await runR1Matrix({
          baseUrl: `http://127.0.0.1:${port}`,
          dbPath,
          statusOpts: { target: v3Files.target, packageJson: v3Files.packageJson, pid: -1 },
          liveR1: true,
          yesSpendTokens: true,
          maxRequests: 10,
          seed: 2,
          timeoutMs: 500,
          gapMs: 0,
          sleepImpl: async () => undefined,
          log: () => undefined,
        });
        assert.ok(capHits <= 10 && outCap.totalRequests <= MAX_TRACK_R_REQUESTS);
        assert.match(String(outCap.stoppedEarly), /^cap=/);
      }
    );
  });
});
