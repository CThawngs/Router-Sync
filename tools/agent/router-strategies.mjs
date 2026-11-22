#!/usr/bin/env node
// tools/agent/router-strategies.mjs — W0: đọc chiến lược combo/provider (chỉ đọc).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const file = process.env.ROUTERSYNC_9ROUTER_DB || path.join(process.env.APPDATA || os.homedir(), '9router', 'db', 'data.sqlite');
const db = new Database(file, { readonly: true, fileMustExist: true });
const combos = db.prepare('SELECT name, kind, models FROM combos ORDER BY name').all();
const settings = JSON.parse(db.prepare('SELECT data FROM settings WHERE id=1').get().data);
db.close();

const cs = settings.comboStrategies ?? {};
const ps = settings.providerStrategies ?? {};
const values = new Set(Object.values(cs).map((v) => (v && typeof v === 'object' ? v.fallbackStrategy : null)).filter(Boolean));
const providerValues = new Set(
  Object.values(ps).map((v) => (v && typeof v === 'object' ? v.fallbackStrategy : null)).filter(Boolean)
);
console.log(`comboStrategies: ${Object.keys(cs).length} mục, values=${[...values].join(',') || '(rỗng)'}`);
console.log(`providerStrategies: ${Object.keys(ps).length} mục, values=${[...providerValues].join(',') || '(rỗng)'}`);
console.log('combo\tkind\tsteps\tstrategy');
for (const c of combos) {
  let steps = 0;
  try {
    const j = JSON.parse(c.models);
    steps = (Array.isArray(j) ? j : j.models ?? []).length;
  } catch {}
  const v = cs[c.name];
  const strategy = v && typeof v === 'object' && v.fallbackStrategy ? String(v.fallbackStrategy) : 'mặc định';
  console.log(`${c.name}\t${c.kind ?? '(null)'}\t${steps}\t${strategy}`);
}
void fs;