#!/usr/bin/env node
// tools/agent/nine-router-patch.mjs
//
// V1: công cụ áp dụng/hoàn tác bản vá cache /v1/models cho 9Router 0.5.119.
//
//   node tools/agent/nine-router-patch.mjs status
//   node tools/agent/nine-router-patch.mjs apply --dry-run
//   node tools/agent/nine-router-patch.mjs apply --yes-write-router
//   node tools/agent/nine-router-patch.mjs revert --yes-write-router
//
// Ghi thật chỉ khi CÓ cờ --yes-write-router và RS_OWNER_CONFIRMED=chạy do chủ dự án đặt.
// Mặc định dry-run; không bao giờ tự ghi.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const EXPECTED_VERSION = '0.5.119';
export const MARK_V1 = 'C36 PATCH';
export const MARK_V2 = 'C37 PATCH v2';

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function routerPaths() {
  const appData = process.env.APPDATA || path.join(os.homedir(), '.config');
  const appDir = path.join(appData, 'npm', 'node_modules', '9router', 'app');
  return { appDir, target: path.join(appDir, 'custom-server.js'), packageJson: path.join(appDir, 'package.json') };
}

export function readVersion(packagePath) {
  try {
    return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Y0.2: bản vá trong tệp chỉ có hiệu lực sau khi tiến trình router khởi động lại.
 * So sánh thời điểm tiến trình bắt đầu với thời điểm tệp được sửa lần cuối.
 */
export function patchLoaded(processStartMs, fileModifiedMs) {
  if (!Number.isFinite(processStartMs) || !Number.isFinite(fileModifiedMs)) return 'unknown';
  return processStartMs > fileModifiedMs ? 'true' : 'false';
}

/** Thời điểm tiến trình bắt đầu (ms). Trả NaN khi không đọc được. */
export function readProcessStartMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Number.NaN;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){$p.StartTime.ToUniversalTime().ToString('o')}`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const ms = Date.parse(String(out).trim());
      return Number.isFinite(ms) ? ms : Number.NaN;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ms = Date.parse(String(out).trim());
    return Number.isFinite(ms) ? ms : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/** Thời điểm sửa tệp cuối cùng (ms). Trả NaN khi không đọc được. */
export function readFileModifiedMs(file) {
  try {
    const ms = fs.statSync(file).mtimeMs;
    return Number.isFinite(ms) ? ms : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function isoOrDash(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'không đọc được';
}

/**
 * Bản vá v2: cache khóa theo sha256(Authorization + query). Không có khóa trùng
 * thì request đi qua handler gốc — cổng xác thực của 9Router vẫn chạy.
 */
export const PATCH_V2 = `
// ${MARK_V2}: auth-keyed cache for GET /v1/models.
// Apply with tools/agent/nine-router-patch.mjs. Owner approval required.
const MODELS_TTL = (() => {
  const n = Number(process.env.RS_MODELS_CACHE_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60_000;
})();
const MODELS_CACHE_MAX_KEYS = 20;
let modelsCacheV2 = new Map();
function modelCacheKey(req) {
  const auth = String(req.headers && req.headers.authorization ? req.headers.authorization : '');
  const q = String(req.url || '').split('?').slice(1).join('?');
  return createHash('sha256').update(auth + '|' + q).digest('hex');
}
function isModelsListV2(req) {
  const m = String(req.method || 'GET').toUpperCase();
  const p = String(req.url || '').split('?')[0];
  return m === 'GET' && (p === '/v1/models' || p === '/api/v1/models');
}
function serveModelsV2(req, res, handler) {
  if (MODELS_TTL === 0) return handler(req, res);
  const key = modelCacheKey(req);
  const hit = modelsCacheV2.get(key);
  if (hit && Date.now() - hit.at < MODELS_TTL) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-9r-models-cache', 'hit');
    res.end(hit.body);
    return;
  }
  const chunks = [];
  const w = res.write.bind(res);
  const e = res.end.bind(res);
  res.write = function (chunk, ...rest) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return w(chunk, ...rest);
  };
  res.end = function (chunk, ...rest) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (res.statusCode === 200 && chunks.length) {
      if (modelsCacheV2.size >= MODELS_CACHE_MAX_KEYS) {
        const oldest = [...modelsCacheV2.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) modelsCacheV2.delete(oldest[0]);
      }
      modelsCacheV2.set(key, { at: Date.now(), body: Buffer.concat(chunks) });
    }
    return e(chunk, ...rest);
  };
  res.setHeader('x-9r-models-cache', 'miss');
  return handler(req, res);
}
// ${MARK_V2} end
`;

export function applyPatch(source) {
  if (source.includes(MARK_V2)) return { source, changed: false };
  const anchor = 'const origCreate = http.createServer.bind(http);';
  if (!source.includes(anchor)) throw new Error('không tìm thấy điểm chèn custom-server.js');
  let out = source.replace(anchor, PATCH_V2 + '\n' + anchor);
  const call = 'if (viaProxy) req.headers["x-9r-via-proxy"] = "1";';
  if (!out.includes(call)) throw new Error('không tìm thấy điểm gọi handler');
  out = out.replace(call, `${call}\n    if (isModelsListV2(req)) return serveModelsV2(req, res, handler);`);
  return { source: out, changed: true };
}

export function revertPatch(source) {
  if (!source.includes(MARK_V2)) return { source, changed: false };
  let out = source;
  const start = out.indexOf('// ' + MARK_V2);
  const endMark = '// ' + MARK_V2 + ' end';
  const end = out.indexOf(endMark, start);
  if (start >= 0 && end >= 0) out = out.slice(0, start) + out.slice(out.indexOf('\n', end) + 1);
  out = out.split('\n').filter((l) => !l.includes('if (isModelsListV2(req)) return serveModelsV2(req, res, handler);')).join('\n');
  return { source: out, changed: true };
}

function canWrite(argv, env) {
  if (!argv.includes('--yes-write-router')) return false;
  return env.RS_OWNER_CONFIRMED === 'chạy';
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { target, packageJson } = routerPaths();
  if (!fs.existsSync(target)) {
    console.log('không tìm thấy 9Router trên máy này');
    return;
  }
  const version = readVersion(packageJson);
  const source = fs.readFileSync(target, 'utf8');
  const hasV1 = source.includes(MARK_V1);
  const hasV2 = source.includes(MARK_V2);

  if (cmd === 'status') {
    const appData = process.env.APPDATA || path.join(os.homedir(), '.config');
    let pid = Number.NaN;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(appData, '9router', 'launcher.pid'), 'utf8'));
      if (typeof parsed.serverPid === 'number') pid = parsed.serverPid;
    } catch {
      pid = Number.NaN;
    }
    const processStartMs = readProcessStartMs(pid);
    const fileModifiedMs = readFileModifiedMs(target);
    console.log(`version=${version ?? 'không đọc được'}`);
    console.log(`patchV1=${hasV1} patchV2=${hasV2}`);
    console.log(`sha256=${sha256(source)}`);
    console.log(`target=9router/app/custom-server.js`);
    console.log(`processStart=${isoOrDash(processStartMs)}`);
    console.log(`fileModified=${isoOrDash(fileModifiedMs)}`);
    console.log(`loaded=${patchLoaded(processStartMs, fileModifiedMs)}`);
    return;
  }

  if (version !== EXPECTED_VERSION) {
    console.log(`TỪ CHỐI: phiên bản ${version ?? '?'} khác ${EXPECTED_VERSION}`);
    return;
  }

  if (cmd === 'apply') {
    const { source: next, changed } = applyPatch(source);
    if (!changed) {
      console.log('đã có bản vá v2, không đổi gì (idempotent)');
      return;
    }
    console.log(`dry-run: thêm ${next.length - source.length} byte, sha256 mới=${sha256(next)}`);
    console.log('hiện tại: patchV1=' + hasV1 + ' patchV2=' + hasV2);
    if (!canWrite(argv, process.env)) {
      console.log('KHÔNG GHI: cần --yes-write-router và RS_OWNER_CONFIRMED=chạy');
      return;
    }
    const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backup, source, 'utf8');
    console.log('backup=' + backup.replace(process.env.APPDATA || '', '<APPDATA>'));
    fs.writeFileSync(target, next, 'utf8');
    const check = fs.readFileSync(target, 'utf8');
    console.log(`đã ghi, verify sha256=${sha256(check)} ${sha256(check) === sha256(next) ? 'OK' : 'KHÔNG KHỚP'}`);
    console.log('KHÔNG khởi động lại router; chủ dự án tự quyết.');
    return;
  }

  if (cmd === 'revert') {
    const { source: next, changed } = revertPatch(source);
    if (!changed) {
      console.log('không có bản vá v2 để hoàn tác');
      return;
    }
    console.log(`dry-run revert: sha256 mới=${sha256(next)}`);
    if (!canWrite(argv, process.env)) {
      console.log('KHÔNG GHI: cần --yes-write-router và RS_OWNER_CONFIRMED=chạy');
      return;
    }
    const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backup, source, 'utf8');
    fs.writeFileSync(target, next, 'utf8');
    console.log(`đã hoàn tác v2, verify sha256=${sha256(fs.readFileSync(target, 'utf8'))}`);
    return;
  }

  console.log('dùng: nine-router-patch.mjs status | apply [--dry-run] [--yes-write-router] | revert [--yes-write-router]');
  void execFileSync;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();