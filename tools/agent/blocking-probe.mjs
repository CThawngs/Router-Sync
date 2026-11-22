#!/usr/bin/env node
// tools/agent/blocking-probe.mjs
// T2: /v1/models có làm chậm request khác không.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const BASE = process.env.ROUTERSYNC_9ROUTER_BASE_URL || 'http://127.0.0.1:20128';
const MODEL = 'groq/qwen/qwen3.8-27b';
const dbFile = path.join(process.env.APPDATA || os.homedir(), '9router', 'db', 'data.sqlite');
const db = new Database(dbFile, { readonly: true });
const key = db.prepare('SELECT key FROM apiKeys WHERE isActive = 1 ORDER BY createdAt LIMIT 1').get().key;
db.close();

async function direct() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: true }),
      signal: AbortSignal.timeout(60000),
    });
    const h = Date.now() - t0;
    await res.text();
    return { headerMs: h, status: res.status };
  } catch {
    return { headerMs: null, status: 'ERR' };
  }
}

async function modelsCall() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(20000) });
    await res.text();
    return Date.now() - t0;
  } catch {
    return Date.now() - t0;
  }
}

const results = { control: [], concurrent: [] };
for (const phase of ['control', 'concurrent']) {
  for (let i = 1; i <= 5; i += 1) {
    let extra = null;
    let pending = null;
    if (phase === 'concurrent') {
      pending = modelsCall();
      await new Promise((r) => setTimeout(r, 1000));
    }
    const r = await direct();
    if (pending) extra = await pending;
    results[phase].push({ ...r, modelsMs: extra });
    console.log(`${phase}#${i}\theader=${r.headerMs ?? '-'}ms\tstatus=${r.status}\tmodelsMs=${extra ?? '-'}ms`);
    await new Promise((r) => setTimeout(r, 15000));
  }
}

const med = (arr) => {
  const x = [...arr].sort((a, b) => a - b);
  return x[Math.floor(x.length / 2)] ?? 0;
};
for (const phase of ['control', 'concurrent']) {
  const xs = results[phase].filter((r) => r.headerMs !== null).map((r) => r.headerMs);
  console.log(`PHASE ${phase}: n=${xs.length} p50=${med(xs)}ms max=${Math.max(0, ...xs)}ms`);
}

// Biến thể combo: một request combo đang chờ và một lần /v1/models giữa chừng.
const t0 = Date.now();
const combo = fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: '9Router-Coder-3', messages: [{ role: 'user', content: 'Trả lời đúng một từ: ok' }], max_tokens: 8, stream: true }),
  signal: AbortSignal.timeout(120000),
}).then(async (res) => ({ headerAt: Date.now() - t0, status: res.status, text: await res.text() }));
await new Promise((r) => setTimeout(r, 5000));
const modelsDuring = await modelsCall();
console.log(`combo-variant: /v1/models trong lúc combo chờ = ${modelsDuring}ms`);
try {
  const c = await Promise.race([combo, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 125000))]);
  console.log(`combo-variant: header=${c.headerAt}ms status=${c.status}`);
} catch {
  console.log('combo-variant: KHÔNG CÓ HEADER trong 120 s');
}

void fs;