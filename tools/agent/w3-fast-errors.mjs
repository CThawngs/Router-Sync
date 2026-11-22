#!/usr/bin/env node
// tools/agent/w3-fast-errors.mjs
// W3: lý do các bước lỗi nhanh (404/405/400). Chỉ POST /v1/chat/completions.
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const BASE = process.env.ROUTERSYNC_9ROUTER_BASE_URL || 'http://127.0.0.1:20128';
const STEPS = ['hf/CohereLabs/c4ai-command-a-03-2025', 'hf/google/gemma-3-12b-it', 'cohere/c4ai-aya-expanse-32b', 'cohere/command-a-03-2025', 'oc/tidepool-alpha-free', 'oc/big-pickle'];

const dbFile = path.join(process.env.APPDATA || os.homedir(), '9router', 'db', 'data.sqlite');
const db = new Database(dbFile, { readonly: true });
const key = db.prepare('SELECT key FROM apiKeys WHERE isActive = 1 ORDER BY createdAt LIMIT 1').get().key;
db.close();

for (const step of STEPS) {
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: step, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: true }),
      signal: AbortSignal.timeout(30000),
    });
    const text = (await res.text()).slice(0, 1000);
    const snippet = text
      .replace(new RegExp(key, 'g'), '<KEY>')
      .replace(/[A-Za-z0-9_\-]{28,}/g, (m) => `<${m.length}>`)
      .slice(0, 160)
      .replace(/\s+/g, ' ');
    console.log(
      `${step}\tstatus=${res.status}\tcontent-type=${res.headers.get('content-type') ?? '-'}\tallow=${res.headers.get('allow') ?? '-'}\tbody=${snippet}`
    );
  } catch (err) {
    console.log(`${step}\tTHROW\t${String(err.message).slice(0, 80)}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}