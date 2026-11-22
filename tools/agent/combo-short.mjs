#!/usr/bin/env node
// tools/agent/combo-short.mjs
//
// T0: thử ngắn hai combo, hạn 60 s mỗi cái. Không in key, không ghi router.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const BASE = process.env.ROUTERSYNC_9ROUTER_BASE_URL || 'http://127.0.0.1:20128';
const COMBOS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['9Router-Coder-3', '9Router-Agent-1'];

const dbFile = path.join(process.env.APPDATA || os.homedir(), '9router', 'db', 'data.sqlite');
const db = new Database(dbFile, { readonly: true });
const key = db.prepare('SELECT key FROM apiKeys WHERE isActive = 1 ORDER BY createdAt LIMIT 1').get().key;
db.close();

for (const combo of COMBOS) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: combo, messages: [{ role: 'user', content: 'Trả lời đúng một từ: ok' }], max_tokens: 8, stream: true }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    const firstUsage = text.match(/"usage_at_ms":(\d+)/);
    console.log(
      `${combo}\theader=${Date.now() - t0}ms\tstatus=${res.status}\tservedBy=${firstUsage ? firstUsage[1] + 'ms' : '-'}`
    );
  } catch (err) {
    console.log(`${combo}\tNO-HEADER\tms=${Date.now() - t0}\t${String(err.message).split(key).join('<KEY>').slice(0, 60)}`);
  }
}
console.log(`# freeMB=${Math.round(os.freemem() / 1048576)}`);
void fs;