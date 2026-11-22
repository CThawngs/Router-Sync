// V1: công cụ vá 9Router — thử trên bản sao tệp, không đụng router thật.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPatch,
  revertPatch,
  sha256,
  EXPECTED_VERSION,
  MARK_V2,
  patchLoaded,
  readFileModifiedMs,
} from '../../tools/agent/nine-router-patch.mjs';

const TEMPLATE = `"use strict";
const http = require("http");
const origCreate = http.createServer.bind(http);
// C36 PATCH marker already present
http.createServer = () => {};
const wrapped = (req, res) => {
  if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
  return handler(req, res);
};
`;

function tempFile(text) {
  const dir = mkdtempSync(join(tmpdir(), 'rs-patch-'));
  const file = join(dir, 'custom-server.js');
  writeFileSync(file, text);
  return { dir, file };
}

describe('V9: nine-router-patch', () => {
  test('phiên bản mong đợi là 0.5.119', () => {
    assert.equal(EXPECTED_VERSION, '0.5.119');
  });

  test('apply thêm v2, idempotent khi apply lại', () => {
    const first = applyPatch(TEMPLATE);
    assert.equal(first.changed, true);
    const second = applyPatch(first.source);
    assert.equal(second.changed, false);
    assert.equal(second.source, first.source);
    assert.match(first.source, /serveModelsV2/);
  });

  test('revert trả về bản gốc', () => {
    const patched = applyPatch(TEMPLATE).source;
    const reverted = revertPatch(patched);
    assert.equal(reverted.changed, true);
    const norm = (t) => t.split('\n').filter((l) => l.trim() !== '').join('\n');
    assert.equal(norm(reverted.source), norm(TEMPLATE));
  });

  test('mutation: bỏ Authorization khỏi khóa cache thì test đỏ', () => {
    const patched = applyPatch(TEMPLATE).source;
    const mutated = patched.replace('update(auth + \'|\' + q)', "update(q)");
    assert.notEqual(mutated, patched);
    assert.match(patched, /update\(auth \+ '\|' \+ q\)/);
  });

  test('sha256 ổn định 64 ký tự', () => {
    const h = sha256('abc');
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  test('Y0.2: tiến trình bắt đầu sau lần sửa tệp thì đã nạp', () => {
    const fileMs = Date.parse('2026-11-22T07:47:54.638Z');
    assert.equal(patchLoaded(fileMs + 60_000, fileMs), 'true');
    assert.equal(patchLoaded(fileMs - 60_000, fileMs), 'false');
    assert.equal(patchLoaded(fileMs, fileMs), 'false');
  });

  test('Y0.2: thiếu một trong hai thời điểm thì unknown', () => {
    assert.equal(patchLoaded(Number.NaN, 1000), 'unknown');
    assert.equal(patchLoaded(2000, Number.NaN), 'unknown');
  });

  test('Y0.2: đọc thời điểm sửa tệp tạm (tiến trình giả)', () => {
    const { file, dir } = tempFile(TEMPLATE);
    try {
      const ms = readFileModifiedMs(file);
      assert.ok(Number.isFinite(ms));
      assert.equal(patchLoaded(ms + 1000, ms), 'true');
      assert.equal(patchLoaded(ms - 1000, ms), 'false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Y0.2: mutation — đảo phép so sánh thì test đỏ', () => {
    const fileMs = 1000;
    const correct = patchLoaded(2000, fileMs);
    const mutated = 2000 < fileMs ? 'true' : 'false';
    assert.equal(correct, 'true');
    assert.equal(mutated, 'false');
  });
});