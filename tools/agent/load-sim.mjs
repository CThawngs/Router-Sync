#!/usr/bin/env node
// tools/agent/load-sim.mjs
//
// C35 R2: controlled experiment - low RAM vs normal RAM, plus a CPU load phase.
// This is a test tool, not part of the CLI. It never writes to the router.
//
// Usage: node tools/agent/load-sim.mjs [--combo 9Router-Coder-3]
//
// Safety:
//   - Free RAM is checked at every step; stop immediately below 500 MB.
//   - The allocated buffer is released in finally, then free RAM is re-checked.
//   - If free RAM at start is below 1500 MB: print CHUA LAM and exit.
//
// Phases: A (control) -> B (RAM load) -> C (CPU load) -> D (control).

const BASE_URL = process.env.ROUTERSYNC_9ROUTER_BASE_URL || 'http://127.0.0.1:20128';
const COMBO = process.argv.includes('--combo') ? process.argv[process.argv.indexOf('--combo') + 1] : '9Router-Coder-3';

import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freeMB = () => Math.round(os.freemem() / (1024 * 1024));

let apiKey = '';
try {
  const file = process.env.ROUTERSYNC_9ROUTER_DB || path.join(process.env.APPDATA || os.homedir(), '9router', 'db', 'data.sqlite');
  const db = new Database(file, { readonly: true });
  apiKey = db.prepare('SELECT key FROM apiKeys WHERE isActive = 1 ORDER BY createdAt LIMIT 1').get().key;
  db.close();
} catch (e) {
  console.log('không đọc được api key:', e.message);
  process.exit(2);
}

async function oneCombo(label) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: COMBO, messages: [{ role: 'user', content: 'Trả lời đúng một từ: ok' }], max_tokens: 8, stream: true }),
      signal: AbortSignal.timeout(180000),
    });
    await res.text();
    return { label, header: Date.now() - t0, status: res.status, free: freeMB() };
  } catch (e) {
    return { label, header: null, status: 'ERR', free: freeMB(), error: String(e.message).slice(0, 60) };
  }
}

const results = [];
async function phase(name, count, gapSec) {
  console.log(`# pha ${name}: ${count} request, cách ${gapSec}s, RAM=${freeMB()}MB`);
  for (let i = 1; i <= count; i += 1) {
    const r = await oneCombo(`${name}#${i}`);
    results.push(r);
    console.log(`  ${r.label}\theader=${r.header ?? '-'}ms\tstatus=${r.status}\tfree=${r.free}MB`);
    if (r.header !== null && r.header > 90000) {
      console.log(`# dừng pha ${name}: request quá 90 s`);
      break;
    }
    await sleep(gapSec * 1000);
  }
}

async function main() {
  const start = freeMB();
  console.log(`# RAM trống lúc bắt đầu: ${start} MB`);
  if (start < 1500) {
    console.log(`CHUA LAM: RAM trống ${start} MB < 1500 MB (vùng nguy hiểm)`);
    return;
  }

  await phase('A-control', 5, 20);

  // Pha RAM: cấp bộ nhớ để RAM trống còn ~700–900 MB, tối đa 6 GB, dừng nếu < 500 MB.
  const targetFree = 800;
  const chunks = [];
  const beforeAlloc = freeMB();
  const toAlloc = Math.max(0, beforeAlloc - targetFree);
  const CHUNK = 256 * 1024 * 1024;
  let allocated = 0;
  try {
    while (allocated < toAlloc && allocated < 6 * 1024 * 1024 * 1024) {
      if (freeMB() < 500) break;
      const buf = Buffer.alloc(CHUNK, 1);
      chunks.push(buf);
      allocated += CHUNK;
    }
    console.log(`# đã cấp ${Math.round(allocated / 1024 / 1024)} MB, RAM trống=${freeMB()}MB`);
    await phase('B-ram-load', 5, 40);
  } finally {
    chunks.length = 0;
    if (global.gc) global.gc();
    await sleep(2000);
    console.log(`# đã nhả bộ nhớ, RAM trống hồi phục=${freeMB()}MB`);
  }

  // Pha CPU: 6/8 luồng tính toán, không ép RAM.
  const workers = [];
  const stopAt = Date.now() + 180_000;
  for (let i = 0; i < 6; i += 1) {
    workers.push(
      (async () => {
        let x = 0;
        while (Date.now() < stopAt) {
          for (let k = 0; k < 1e6; k += 1) x += Math.sqrt(k) % 7;
        }
        return x;
      })()
    );
  }
  try {
    await phase('C-cpu-load', 5, 30);
  } finally {
    void workers;
    console.log('# pha CPU kết thúc');
  }

  await phase('D-control', 5, 20);

  console.log('\n# tổng hợp');
  for (const name of ['A-control', 'B-ram-load', 'C-cpu-load', 'D-control']) {
    const xs = results.filter((r) => r.label.startsWith(name)).map((r) => r.header).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    if (!xs.length) {
      console.log(`${name}: không có mẫu`);
      continue;
    }
    const p50 = xs[Math.floor(xs.length / 2)];
    console.log(`${name}: n=${xs.length} p50=${p50}ms max=${xs[xs.length - 1]}ms`);
  }
}

main();