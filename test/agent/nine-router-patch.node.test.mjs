// C43 / R0: kiểm thử độc lập PATCH_V2 (đỏ) & PATCH_V3 (xanh) cho 9Router 0.5.119 / 0.5.123.
// Hoàn toàn ngoại tuyến: dùng node:vm CJS chuẩn + máy chủ tạm 127.0.0.1:0, 0 gọi tới 9Router thật.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import * as patchMod from '../../tools/agent/nine-router-patch.mjs';

const execFileAsync = promisify(execFile);
const hostRequire = createRequire(import.meta.url);
const PATCH_SCRIPT_PATH = join(import.meta.dirname, '..', '..', 'tools', 'agent', 'nine-router-patch.mjs');
const PATCH_MODULE_URL = pathToFileURL(PATCH_SCRIPT_PATH).href;

/**
 * Bản mẫu sát thực tế 9router@0.5.119 và 9router@0.5.123 (custom-server.js dòng 1-7, 52-75):
 * có `const crypto = require("crypto");` ở phạm vi tệp nhưng KHÔNG có định danh trần `createHash`.
 */
function buildAuthenticCustomServerFixture({ withV1 = false } = {}) {
  const v1Line = withV1 ? '// C36 PATCH marker already present\n' : '';
  return `"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
${v1Line}void path;
void fs;
void crypto;
void pathToFileURL;

const origCreate = http.createServer.bind(http);
http.createServer = function patchedCreateServer(optsOrHandler, maybeHandler) {
  const handler = typeof optsOrHandler === "function" ? optsOrHandler : maybeHandler;
  const wrapped = (req, res) => {
    const viaProxy = Boolean(req.headers && req.headers["x-forwarded-for"]);
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  return typeof optsOrHandler === "function"
    ? origCreate(wrapped)
    : origCreate(optsOrHandler, wrapped);
};

module.exports = {
  createPatchedServer: (handler) => http.createServer(handler),
  inspectCacheKeys: () => {
    if (typeof modelsCacheV3 !== "undefined") return [...modelsCacheV3.keys()];
    if (typeof modelsCacheV2 !== "undefined") return [...modelsCacheV2.keys()];
    return [];
  },
};
`;
}

/**
 * Chạy nguồn custom-server.js trong ngữ cảnh CJS cách ly bằng node:vm:
 * chỉ mở các biến toàn cục chuẩn của CJS, KHÔNG truyền `createHash` trần trừ khi test yêu cầu.
 */
function evaluateCustomServerInVm(source, { extraGlobals = {}, envOverrides = {} } = {}) {
  const isolatedHttp = Object.assign(Object.create(http), {
    createServer: http.createServer.bind(http),
  });
  const cjsRequire = (specifier) => {
    if (specifier === 'http' || specifier === 'node:http') return isolatedHttp;
    return hostRequire(specifier);
  };
  const isolatedProcess = Object.create(process);
  Object.defineProperty(isolatedProcess, 'env', {
    value: { ...process.env, ...envOverrides },
    enumerable: true,
    configurable: true,
  });
  if (typeof process.getBuiltinModule === 'function') {
    Object.defineProperty(isolatedProcess, 'getBuiltinModule', {
      value: process.getBuiltinModule.bind(process),
      configurable: true,
    });
  }

  const cjsModule = { exports: {} };
  const sandbox = {
    require: cjsRequire,
    module: cjsModule,
    exports: cjsModule.exports,
    Buffer,
    process: isolatedProcess,
    URL,
    setTimeout,
    clearTimeout,
    Date,
    Map,
    Number,
    String,
    Boolean,
    console,
    ...extraGlobals,
  };

  if (!('createHash' in extraGlobals)) {
    assert.equal('createHash' in sandbox, false, 'sandbox chuẩn không được có createHash trần');
  }

  const context = vm.createContext(sandbox);
  const script = new vm.Script(source, { filename: 'custom-server.fixture.cjs' });
  script.runInContext(context);
  return { exports: cjsModule.exports, sandbox };
}

/** Gọi trực tiếp hàm lắng nghe request của http.Server để bắt lỗi đồng bộ trong node:vm. */
function invokeRequestSync(server, { method = 'GET', url = '/v1/models', headers = {} } = {}) {
  const listeners = server.listeners('request');
  assert.equal(listeners.length, 1);
  const chunks = [];
  const resHeaders = new Map();
  const fakeReq = { method, url, headers: { ...headers } };
  const fakeRes = {
    statusCode: 200,
    headersSent: false,
    setHeader(k, v) {
      resHeaders.set(String(k).toLowerCase(), v);
    },
    getHeader(k) {
      return resHeaders.get(String(k).toLowerCase());
    },
    write(chunk) {
      this.headersSent = true;
      if (chunk && typeof chunk !== 'function') {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return true;
    },
    end(chunk) {
      this.headersSent = true;
      if (chunk && typeof chunk !== 'function') {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    },
  };
  listeners[0](fakeReq, fakeRes);
  return {
    statusCode: fakeRes.statusCode,
    headers: Object.fromEntries(resHeaders.entries()),
    body: Buffer.concat(chunks).toString('utf8'),
  };
}

/** Mở máy chủ tạm trên 127.0.0.1:0 và đóng sạch kết nối khi xong. */
async function withEphemeralServer(server, run) {
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

function httpRequest({ port, method = 'GET', path = '/', headers = {}, body = '', timeoutMs = 600 }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { connection: 'close', ...headers },
        agent: false,
      },
      (res) => {
        const parts = [];
        res.on('data', (chunk) => parts.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts).toString('utf8'),
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`httpRequest timeout after ${timeoutMs}ms: ${method} ${path}`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function tempFile(text) {
  const dir = mkdtempSync(join(tmpdir(), 'rs-patch-'));
  const file = join(dir, 'custom-server.js');
  writeFileSync(file, text);
  return { dir, file };
}

describe('R0 (a): PATCH_V2 ném ReferenceError trong sandbox CJS node:vm chuẩn', () => {
  test('(a.1) applyPatchV2 xuất đầy đủ và ném ReferenceError: createHash is not defined trên GET /v1/models', () => {
    assert.equal(patchMod.MARK_V2, 'C37 PATCH v2');
    assert.equal(typeof patchMod.PATCH_V2, 'string');
    assert.match(patchMod.PATCH_V2, /\bcreateHash\('sha256'\)/);
    assert.equal(typeof patchMod.applyPatchV2, 'function');

    const fixture = buildAuthenticCustomServerFixture({ withV1: true });
    const v2 = patchMod.applyPatchV2(fixture);
    assert.equal(v2.changed, true);
    assert.ok(v2.source.includes(patchMod.MARK_V2));

    let handlerCalls = 0;
    const { exports: mod } = evaluateCustomServerInVm(v2.source);
    const server = mod.createPatchedServer((_req, res) => {
      handlerCalls += 1;
      res.end('{"object":"list","data":[]}');
    });

    assert.throws(
      () => invokeRequestSync(server, { method: 'GET', url: '/v1/models' }),
      { name: 'ReferenceError', message: /createHash is not defined/ }
    );
    assert.equal(handlerCalls, 0);
  });

  test('(a.2) đột biến lập trình: tiêm createHash trần vào sandbox làm PATCH_V2 không còn ném lỗi', () => {
    assert.equal(typeof patchMod.applyPatchV2, 'function');
    const v2 = patchMod.applyPatchV2(buildAuthenticCustomServerFixture({ withV1: false }));
    const { createHash: hostCreateHash } = hostRequire('node:crypto');

    const { exports: leakyMod } = evaluateCustomServerInVm(v2.source, {
      extraGlobals: { createHash: hostCreateHash },
    });
    const leakyServer = leakyMod.createPatchedServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"object":"list","data":[{"id":"m1"}]}');
    });

    const out = invokeRequestSync(leakyServer, { method: 'GET', url: '/v1/models' });
    assert.equal(out.statusCode, 200);
    assert.equal(out.headers['x-9r-models-cache'], 'miss');
  });
});

describe('R0 (b): PATCH_V3 chạy sạch trong cùng sandbox CJS node:vm và cô lập khóa cache 64-hex', () => {
  test('(b.1) applyPatch chèn MARK_V3 chạy sạch cho cả mẫu có MARK_V1 (0.5.119) và không có MARK_V1 (0.5.123)', () => {
    assert.equal(patchMod.MARK_V3, 'C43 PATCH v3');
    assert.equal(typeof patchMod.PATCH_V3, 'string');
    assert.equal(/\b(?<!\.)createHash\s*\(/.test(patchMod.PATCH_V3), false, 'PATCH_V3 cấm gọi createHash trần');

    for (const withV1 of [true, false]) {
      const base = buildAuthenticCustomServerFixture({ withV1 });
      const applied = patchMod.applyPatch(base);
      assert.equal(applied.changed, true);
      assert.ok(applied.source.includes(patchMod.MARK_V3));
      assert.equal(applied.source.includes(patchMod.MARK_V2), false);

      // Idempotent khi gọi applyPatch lần hai
      const second = patchMod.applyPatch(applied.source);
      assert.equal(second.changed, false);
      assert.equal(second.source, applied.source);

      const { exports: mod } = evaluateCustomServerInVm(applied.source);
      const server = mod.createPatchedServer((_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end('{"object":"list","data":[{"id":"gpt-4o"}]}');
      });

      const r1 = invokeRequestSync(server, {
        method: 'GET',
        url: '/v1/models?limit=1',
        headers: { authorization: 'Bearer alpha-1' },
      });
      const r2 = invokeRequestSync(server, {
        method: 'GET',
        url: '/v1/models?limit=1',
        headers: { authorization: 'Bearer beta-2' },
      });
      const r3 = invokeRequestSync(server, {
        method: 'GET',
        url: '/v1/models?limit=2',
        headers: { authorization: 'Bearer alpha-1' },
      });

      assert.equal(r1.statusCode, 200);
      assert.equal(r1.headers['x-9r-models-cache'], 'miss');
      assert.equal(r2.headers['x-9r-models-cache'], 'miss');
      assert.equal(r3.headers['x-9r-models-cache'], 'miss');

      const keys = Array.from(mod.inspectCacheKeys());
      assert.equal(keys.length, 3);
      for (const k of keys) assert.match(k, /^[0-9a-f]{64}$/);
      assert.deepEqual(keys, [
        patchMod.sha256('Bearer alpha-1|limit=1'),
        patchMod.sha256('Bearer beta-2|limit=1'),
        patchMod.sha256('Bearer alpha-1|limit=2'),
      ]);

      // Khôi phục hoàn nguyên bảo toàn MARK_V1 (nếu có) và khớp byte-for-byte bản gốc
      const reverted = patchMod.revertPatch(applied.source);
      assert.equal(reverted.changed, true);
      assert.equal(reverted.source.includes(patchMod.MARK_V3), false);
      assert.equal(reverted.source.includes('serveModelsV3'), false);
      assert.equal(reverted.source.includes(patchMod.MARK_V1), withV1);
      assert.equal(reverted.source, base);
      assert.equal(patchMod.revertPatch(reverted.source).changed, false);
    }
  });

  test('(b.2) nâng cấp trực tiếp MARK_V2 -> MARK_V3 và revert sạch về bản gốc', () => {
    assert.equal(typeof patchMod.applyPatchV2, 'function');
    const base = buildAuthenticCustomServerFixture({ withV1: true });
    const v2 = patchMod.applyPatchV2(base);
    assert.ok(v2.source.includes(patchMod.MARK_V2));

    const upgraded = patchMod.applyPatch(v2.source);
    assert.equal(upgraded.changed, true);
    assert.ok(upgraded.source.includes(patchMod.MARK_V3));
    assert.equal(upgraded.source.includes(patchMod.MARK_V2), false);
    assert.equal(upgraded.source.includes('serveModelsV2'), false);
    assert.ok(upgraded.source.includes('serveModelsV3'));
    assert.ok(upgraded.source.includes(patchMod.MARK_V1));

    const { exports: mod } = evaluateCustomServerInVm(upgraded.source);
    const server = mod.createPatchedServer((_req, res) => {
      res.statusCode = 200;
      res.end('{"object":"list","data":[]}');
    });
    const resp = invokeRequestSync(server, { method: 'GET', url: '/v1/models' });
    assert.equal(resp.statusCode, 200);
    assert.equal(resp.headers['x-9r-models-cache'], 'miss');

    const revertedFromV2 = patchMod.revertPatch(v2.source);
    assert.equal(revertedFromV2.changed, true);
    assert.equal(revertedFromV2.source.includes(patchMod.MARK_V2), false);
    assert.equal(revertedFromV2.source, base);

    const revertedFromV3 = patchMod.revertPatch(upgraded.source);
    assert.equal(revertedFromV3.changed, true);
    assert.equal(revertedFromV3.source, base);
  });

  test('(b.3) đột biến lập trình: thay helper băm bằng createHash trần hoặc bỏ auth khỏi khóa đều bị bắt', () => {
    const patched = patchMod.applyPatch(buildAuthenticCustomServerFixture({ withV1: false })).source;
    assert.ok(patched.includes(patchMod.MARK_V3));

    // Đột biến 1: đổi lời gọi helper sang createHash('sha256') trần -> ném ReferenceError trong vm
    const bareHashMutant = patched.replace(/_rsCreateHash\('sha256'\)/g, "createHash('sha256')");
    assert.notEqual(bareHashMutant, patched);
    const { exports: brokenMod } = evaluateCustomServerInVm(bareHashMutant);
    const brokenServer = brokenMod.createPatchedServer((_req, res) => res.end('{}'));
    assert.throws(
      () => invokeRequestSync(brokenServer, { method: 'GET', url: '/v1/models' }),
      { name: 'ReferenceError', message: /createHash is not defined/ }
    );

    // Đột biến 2: bỏ auth khỏi update(auth + '|' + q) -> rò rỉ cache giữa 2 Authorization khác nhau
    const noAuthMutant = patched.replace("update(auth + '|' + q)", 'update(q)');
    assert.notEqual(noAuthMutant, patched);
    const { exports: leakyAuthMod } = evaluateCustomServerInVm(noAuthMutant);
    let upstreamCount = 0;
    const leakyAuthServer = leakyAuthMod.createPatchedServer((req, res) => {
      upstreamCount += 1;
      res.statusCode = 200;
      res.end(JSON.stringify({ who: req.headers.authorization }));
    });
    invokeRequestSync(leakyAuthServer, {
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer alpha-1' },
    });
    const leaked = invokeRequestSync(leakyAuthServer, {
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer beta-2' },
    });
    assert.equal(upstreamCount, 1, 'bản đột biến bỏ auth đã trả nhầm cache của người dùng khác');
    assert.equal(leaked.headers['x-9r-models-cache'], 'hit');
  });
});

describe('R0 (c): máy chủ tạm 127.0.0.1:0 — GET /v1/models lần 1 miss, lần 2 hit, lỗi != 200 không lưu cache', () => {
  test('(c.1) HTTP 127.0.0.1:0 trả miss rồi hit trong TTL (handlerCalls === 1) và không cache mã 401/500', async () => {
    const base = buildAuthenticCustomServerFixture({ withV1: false });
    const patched = patchMod.applyPatch(base);
    assert.ok(patched.source.includes(patchMod.MARK_V3));

    let handlerCalls = 0;
    let nextStatus = 200;
    const payload = JSON.stringify({ object: 'list', data: [{ id: 'claude-sonnet-4' }] });

    const { exports: mod } = evaluateCustomServerInVm(patched.source, {
      envOverrides: { RS_MODELS_CACHE_TTL_MS: '60000' },
    });
    const server = mod.createPatchedServer((_req, res) => {
      handlerCalls += 1;
      res.statusCode = nextStatus;
      res.setHeader('content-type', 'application/json');
      res.end(nextStatus === 200 ? payload : JSON.stringify({ error: `status-${nextStatus}` }));
    });

    await withEphemeralServer(server, async (port) => {
      // Lần 1: miss, gọi handler gốc đúng 1 lần
      const first = await httpRequest({
        port,
        method: 'GET',
        path: '/v1/models',
        headers: { Authorization: 'Bearer alpha-1' },
      });
      assert.equal(first.statusCode, 200);
      assert.equal(first.headers['x-9r-models-cache'], 'miss');
      assert.equal(first.body, payload);
      assert.equal(handlerCalls, 1);

      // Lần 2 cùng khóa trong TTL: hit, KHÔNG gọi lại handler gốc
      const second = await httpRequest({
        port,
        method: 'GET',
        path: '/v1/models',
        headers: { Authorization: 'Bearer alpha-1' },
      });
      assert.equal(second.statusCode, 200);
      assert.equal(second.headers['x-9r-models-cache'], 'hit');
      assert.equal(second.body, payload);
      assert.equal(handlerCalls, 1);

      // Khóa mới trả 401 rồi 500 -> KHÔNG được lưu vào cache
      nextStatus = 401;
      const unauth = await httpRequest({
        port,
        method: 'GET',
        path: '/v1/models',
        headers: { Authorization: 'Bearer denied-key' },
      });
      assert.equal(unauth.statusCode, 401);
      assert.equal(handlerCalls, 2);

      nextStatus = 500;
      const err500 = await httpRequest({
        port,
        method: 'GET',
        path: '/v1/models',
        headers: { Authorization: 'Bearer denied-key' },
      });
      assert.equal(err500.statusCode, 500);
      assert.equal(handlerCalls, 3);

      // Khi upstream hồi phục 200 cho cùng khóa đó, vẫn gọi thật vì 401/500 trước đó không bị cache
      nextStatus = 200;
      const recovered = await httpRequest({
        port,
        method: 'GET',
        path: '/v1/models',
        headers: { Authorization: 'Bearer denied-key' },
      });
      assert.equal(recovered.statusCode, 200);
      assert.equal(recovered.headers['x-9r-models-cache'], 'miss');
      assert.equal(handlerCalls, 4);
    });
  });

  test('(c.2) đột biến lập trình: bỏ modelsCacheV3.set khiến lần gọi thứ 2 vẫn miss và tăng handlerCalls', () => {
    const patched = patchMod.applyPatch(buildAuthenticCustomServerFixture()).source;
    const noSetMutant = patched.replace(/modelsCacheV3\.set\([^;]+;/, 'void 0;');
    assert.notEqual(noSetMutant, patched);

    let calls = 0;
    const { exports: mod } = evaluateCustomServerInVm(noSetMutant);
    const server = mod.createPatchedServer((_req, res) => {
      calls += 1;
      res.statusCode = 200;
      res.end('{"data":[]}');
    });
    invokeRequestSync(server, { method: 'GET', url: '/v1/models' });
    const second = invokeRequestSync(server, { method: 'GET', url: '/v1/models' });
    assert.equal(calls, 2);
    assert.equal(second.headers['x-9r-models-cache'], 'miss');
  });
});

describe('R0 (d): các đường dẫn khác /v1/models đi thẳng qua handler gốc, không chạm cache', () => {
  test('(d.1) POST /v1/chat/completions, POST /v1/models, GET /api/health, GET /v1/models/gpt-4o bỏ qua nhánh vá', async () => {
    const patched = patchMod.applyPatch(buildAuthenticCustomServerFixture({ withV1: true }));
    assert.ok(patched.source.includes(patchMod.MARK_V3));

    const seen = [];
    const { exports: mod } = evaluateCustomServerInVm(patched.source);
    const server = mod.createPatchedServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ route: `${req.method} ${req.url}`, viaProxy: req.headers['x-9r-via-proxy'] ?? null }));
    });

    await withEphemeralServer(server, async (port) => {
      const bypassCases = [
        { method: 'POST', path: '/v1/chat/completions', body: '{"model":"gpt-4o","messages":[]}' },
        { method: 'POST', path: '/v1/models', body: '{}' },
        { method: 'GET', path: '/api/health', body: '' },
        { method: 'GET', path: '/v1/models/gpt-4o', body: '' },
      ];

      for (const tc of bypassCases) {
        const r = await httpRequest({
          port,
          method: tc.method,
          path: tc.path,
          headers: { 'x-forwarded-for': '127.0.0.1' },
          body: tc.body,
        });
        assert.equal(r.statusCode, 200);
        assert.equal(r.headers['x-9r-models-cache'], undefined, `${tc.method} ${tc.path} không được gắn x-9r-models-cache`);
        const parsed = JSON.parse(r.body);
        assert.equal(parsed.viaProxy, '1');
      }

      assert.equal(mod.inspectCacheKeys().length, 0, 'các request bypass không được ghi vào modelsCacheV3');
      assert.equal(seen.length, 4);

      // Ngược lại, GET /api/v1/models ĐƯỢC đi qua bộ nhớ đệm v3
      const apiModels1 = await httpRequest({ port, method: 'GET', path: '/api/v1/models' });
      const apiModels2 = await httpRequest({ port, method: 'GET', path: '/api/v1/models' });
      assert.equal(apiModels1.headers['x-9r-models-cache'], 'miss');
      assert.equal(apiModels2.headers['x-9r-models-cache'], 'hit');
      assert.equal(seen.length, 5);
      assert.equal(mod.inspectCacheKeys().length, 1);
    });
  });

  test('(d.2) đột biến lập trình: nới lỏng isModelsListV3 sang startsWith hoặc bỏ kiểm tra GET sẽ làm hỏng bypass', () => {
    const patched = patchMod.applyPatch(buildAuthenticCustomServerFixture()).source;
    const overbroadMutant = patched.replace(
      "m === 'GET' && (p === '/v1/models' || p === '/api/v1/models')",
      "p.startsWith('/v1/models')"
    );
    assert.notEqual(overbroadMutant, patched);

    const { exports: mod } = evaluateCustomServerInVm(overbroadMutant);
    const server = mod.createPatchedServer((_req, res) => {
      res.statusCode = 200;
      res.end('{"id":"gpt-4o"}');
    });

    const detail = invokeRequestSync(server, { method: 'GET', url: '/v1/models/gpt-4o' });
    const postModels = invokeRequestSync(server, { method: 'POST', url: '/v1/models' });
    assert.equal(detail.headers['x-9r-models-cache'], 'miss');
    assert.equal(postModels.headers['x-9r-models-cache'], 'hit');
  });
});

describe('R0 (e): chứng minh treo client khi PATCH_V2 gặp uncaughtException & cổng phiên bản 0.5.119/0.5.123', () => {
  test('(e.1) tiến trình con 127.0.0.1:0 + PATCH_V2 + process.on(uncaughtException): GET /v1/models treo (0 byte, headersSent=false) nhưng POST /v1/chat/completions vẫn sống 200 OK', async () => {
    assert.equal(typeof patchMod.applyPatchV2, 'function');

    const childScript = `
      import http from 'node:http';
      import vm from 'node:vm';
      import { createRequire } from 'node:module';

      const patchMod = await import(process.env.RS_TEST_PATCH_MODULE_URL);
      const cjsRequire = createRequire(process.env.RS_TEST_PATCH_MODULE_URL);

      const fixture = \`"use strict";
const http = require("http");
const crypto = require("crypto");
void crypto;
const origCreate = http.createServer.bind(http);
http.createServer = function(handler) {
  const wrapped = (req, res) => {
    const viaProxy = false;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  return origCreate(wrapped);
};
module.exports = { createPatchedServer: (h) => http.createServer(h) };
\`;

      const v2 = patchMod.applyPatchV2(fixture);
      const uncaught = [];
      // Tương đương router-server.js:719-722: bắt uncaughtException, ghi log và KHÔNG thoát tiến trình.
      process.on('uncaughtException', (err) => {
        uncaught.push({ name: err?.name ?? 'Error', message: String(err?.message ?? err) });
      });

      const isolatedHttp = Object.assign(Object.create(http), {
        createServer: http.createServer.bind(http),
      });
      const cjsMod = { exports: {} };
      const ctx = vm.createContext({
        require: (id) => (id === 'http' || id === 'node:http' ? isolatedHttp : cjsRequire(id)),
        module: cjsMod,
        exports: cjsMod.exports,
        Buffer,
        process,
        URL,
        setTimeout,
        clearTimeout,
        Date,
        Map,
        Number,
        String,
        console,
      });
      new vm.Script(v2.source).runInContext(ctx);

      let handlerCalls = 0;
      let modelsResRef = null;
      const server = cjsMod.exports.createPatchedServer((req, res) => {
        handlerCalls += 1;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, path: req.url, method: req.method }));
      });

      // Ghi nhận đối tượng res thực tế của /v1/models trước khi listener chính chạy
      const [wrappedListener] = server.listeners('request');
      server.removeAllListeners('request');
      server.on('request', (req, res) => {
        if (req.url === '/v1/models') modelsResRef = res;
        wrappedListener(req, res);
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      // 1) Gửi GET /v1/models với timeout ngắn 220ms -> phải treo, nhận 0 byte, headersSent === false
      const modelsOutcome = await new Promise((resolve) => {
        let bytes = 0;
        let gotResponse = false;
        let timedOut = false;
        const req = http.get({ host: '127.0.0.1', port, path: '/v1/models', agent: false }, (res) => {
          gotResponse = true;
          res.on('data', (c) => { bytes += c.length; });
          res.on('end', () => resolve({ timedOut, gotResponse, bytes }));
        });
        req.setTimeout(220, () => {
          timedOut = true;
          req.destroy();
        });
        req.on('error', () => {
          resolve({ timedOut, gotResponse, bytes });
        });
      });

      const headersSentAfterModels = modelsResRef ? modelsResRef.headersSent : null;
      const handlerCallsAfterModels = handlerCalls;

      // 2) Ngay sau đó gửi POST /v1/chat/completions -> tiến trình server vẫn sống và trả 200 OK
      const chatOutcome = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/v1/chat/completions',
            headers: { 'content-type': 'application/json', connection: 'close' },
            agent: false,
          },
          (res) => {
            const parts = [];
            res.on('data', (c) => parts.push(c));
            res.on('end', () => resolve({
              statusCode: res.statusCode,
              body: Buffer.concat(parts).toString('utf8'),
            }));
          }
        );
        req.on('error', reject);
        req.end('{"model":"gpt-4o","messages":[]}');
      });

      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));

      process.stdout.write(JSON.stringify({
        modelsOutcome,
        headersSentAfterModels,
        handlerCallsAfterModels,
        uncaught,
        chatOutcome,
        handlerCallsFinal: handlerCalls,
      }));
    `;

    const startedAt = Date.now();
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', childScript],
      {
        env: { ...process.env, RS_TEST_PATCH_MODULE_URL: PATCH_MODULE_URL },
        timeout: 5000,
      }
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 2000, `tiến trình con phải đóng sạch dưới 2s (thực tế ${elapsedMs}ms)`);

    const report = JSON.parse(stdout);
    assert.equal(report.modelsOutcome.timedOut, true);
    assert.equal(report.modelsOutcome.gotResponse, false);
    assert.equal(report.modelsOutcome.bytes, 0);
    assert.equal(report.headersSentAfterModels, false);
    assert.equal(report.handlerCallsAfterModels, 0);
    assert.equal(report.uncaught.length, 1);
    assert.equal(report.uncaught[0].name, 'ReferenceError');
    assert.match(report.uncaught[0].message, /createHash is not defined/);
    assert.equal(report.chatOutcome.statusCode, 200);
    assert.deepEqual(JSON.parse(report.chatOutcome.body), {
      ok: true,
      path: '/v1/chat/completions',
      method: 'POST',
    });
    assert.equal(report.handlerCallsFinal, 1);
  });

  test('(e.2) cổng phiên bản hỗ trợ 0.5.119 & 0.5.123, từ chối 0.5.124, và kiểm tra neo custom-server.js + CLI status/dry-run', () => {
    assert.equal(patchMod.EXPECTED_VERSION, '0.5.119');
    assert.deepEqual(patchMod.SUPPORTED_VERSIONS, ['0.5.119', '0.5.123']);
    assert.equal(typeof patchMod.isSupportedVersion, 'function');

    assert.equal(patchMod.isSupportedVersion('0.5.119'), true);
    assert.equal(patchMod.isSupportedVersion('0.5.123'), true);
    assert.equal(patchMod.isSupportedVersion('0.5.124'), false);
    assert.equal(patchMod.isSupportedVersion('0.5.118'), false);
    assert.equal(patchMod.isSupportedVersion(''), false);
    assert.equal(patchMod.isSupportedVersion(null), false);
    assert.equal(patchMod.isSupportedVersion(undefined), false);

    // Đột biến lập trình: chấp nhận 0.5.124 phải bị phát hiện
    const mutatedVersions = [...patchMod.SUPPORTED_VERSIONS, '0.5.124'];
    const mutatedPredicate = (v) => typeof v === 'string' && mutatedVersions.includes(v);
    assert.notEqual(mutatedPredicate('0.5.124'), patchMod.isSupportedVersion('0.5.124'));

    // Thiếu 1 trong 2 neo bắt buộc trong custom-server.js đều phải ném lỗi
    const valid = buildAuthenticCustomServerFixture();
    const missingAnchor1 = valid.replace('const origCreate = http.createServer.bind(http);', '// missing origCreate');
    const missingAnchor2 = valid.replace('if (viaProxy) req.headers["x-9r-via-proxy"] = "1";', '// missing viaProxy');
    assert.throws(() => patchMod.applyPatch(missingAnchor1), /không tìm thấy điểm chèn custom-server\.js/);
    assert.throws(() => patchMod.applyPatch(missingAnchor2), /không tìm thấy điểm gọi handler/);
    assert.throws(() => patchMod.applyPatchV2(missingAnchor1), /không tìm thấy điểm chèn custom-server\.js/);
    assert.throws(() => patchMod.applyPatchV2(missingAnchor2), /không tìm thấy điểm gọi handler/);

    // Kiểm tra CLI status & dry-run trong thư mục APPDATA giả lập ở tmpdir (KHÔNG ghi router thật)
    const fakeAppData = mkdtempSync(join(tmpdir(), 'rs-appdata-'));
    try {
      const appDir = join(fakeAppData, 'npm', 'node_modules', '9router', 'app');
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, 'custom-server.js'), valid, 'utf8');

      for (const ver of ['0.5.119', '0.5.123']) {
        writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: '9router', version: ver }), 'utf8');
        const statusRun = spawnSync(process.execPath, [PATCH_SCRIPT_PATH, 'status'], {
          encoding: 'utf8',
          env: { ...process.env, APPDATA: fakeAppData },
        });
        assert.equal(statusRun.status, 0);
        assert.match(statusRun.stdout, new RegExp(`version=${ver.replace(/\./g, '\\.')}`));
        assert.match(statusRun.stdout, /patchV1=false patchV2=false patchV3=false/);

        const dryApply = spawnSync(process.execPath, [PATCH_SCRIPT_PATH, 'apply', '--dry-run'], {
          encoding: 'utf8',
          env: { ...process.env, APPDATA: fakeAppData },
        });
        assert.equal(dryApply.status, 0);
        assert.match(dryApply.stdout, /dry-run:/);
        assert.match(dryApply.stdout, /KHÔNG GHI/);
      }

      // Phiên bản 0.5.124 phải bị TỪ CHỐI
      writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: '9router', version: '0.5.124' }), 'utf8');
      const rejected = spawnSync(process.execPath, [PATCH_SCRIPT_PATH, 'apply', '--dry-run'], {
        encoding: 'utf8',
        env: { ...process.env, APPDATA: fakeAppData },
      });
      assert.equal(rejected.status, 0);
      assert.match(rejected.stdout, /TỪ CHỐI: phiên bản 0\.5\.124 không nằm trong 0\.5\.119, 0\.5\.123/);
    } finally {
      rmSync(fakeAppData, { recursive: true, force: true });
    }
  });
});

describe('V9 & Y0.2: bảo toàn hành vi nền của nine-router-patch', () => {
  test('sha256 ổn định 64 ký tự', () => {
    const h = patchMod.sha256('abc');
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  test('Y0.2: tiến trình bắt đầu sau lần sửa tệp thì đã nạp', () => {
    const fileMs = Date.parse('2026-11-22T07:47:54.638Z');
    assert.equal(patchMod.patchLoaded(fileMs + 60_000, fileMs), 'true');
    assert.equal(patchMod.patchLoaded(fileMs - 60_000, fileMs), 'false');
    assert.equal(patchMod.patchLoaded(fileMs, fileMs), 'false');
  });

  test('Y0.2: thiếu một trong hai thời điểm thì unknown', () => {
    assert.equal(patchMod.patchLoaded(Number.NaN, 1000), 'unknown');
    assert.equal(patchMod.patchLoaded(2000, Number.NaN), 'unknown');
  });

  test('Y0.2: đọc thời điểm sửa tệp tạm (tiến trình giả)', () => {
    const { file, dir } = tempFile(buildAuthenticCustomServerFixture());
    try {
      const ms = patchMod.readFileModifiedMs(file);
      assert.ok(Number.isFinite(ms));
      assert.equal(patchMod.patchLoaded(ms + 1000, ms), 'true');
      assert.equal(patchMod.patchLoaded(ms - 1000, ms), 'false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Y0.2: mutation — đảo phép so sánh thì test đỏ', () => {
    const fileMs = 1000;
    const correct = patchMod.patchLoaded(2000, fileMs);
    const mutated = 2000 < fileMs ? 'true' : 'false';
    assert.equal(correct, 'true');
    assert.equal(mutated, 'false');
  });
});
