#!/usr/bin/env node
// tools/agent/models-probe.mjs
// T1: đo thời gian và CPU của router cho mỗi GET /v1/models.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const BASE = process.env.ROUTERSYNC_9ROUTER_BASE_URL || 'http://127.0.0.1:20128';
const CALLS = Number(process.env.PROBE_CALLS || 6);
const GAP = Number(process.env.PROBE_GAP_SEC || 20);

function pid() {
  const file = path.join(process.env.APPDATA || os.homedir(), '9router', 'launcher.pid');
  return JSON.parse(fs.readFileSync(file, 'utf8')).serverPid;
}
const ROUTER_PID = pid();

function cpu() {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `$p=Get-Process -Id ${ROUTER_PID} -ErrorAction SilentlyContinue; if($p){"{0}|{1}" -f [math]::Round($p.CPU,2), [math]::Round($p.WorkingSet64/1MB,0)} else {"0|0"}`],
    { encoding: 'utf8' }
  ).trim().split('\n')[0] ?? '0|0';
  const [c, rss] = out.split('|');
  return { cpu: Number(c) || 0, rss: Number(rss) || 0 };
}

function usageCount() {
  const dbPath = path.join(process.env.APPDATA || os.homedir(), '9router', 'db', 'data.sqlite');
  try {
    const db = new Database(dbPath, { readonly: true });
    const n = db.prepare('SELECT COUNT(*) n FROM usageHistory').get().n;
    db.close();
    return n;
  } catch {
    return 0;
  }
}

const rows = [];
for (let i = 1; i <= CALLS; i += 1) {
  const before = cpu();
  const beforeUsage = usageCount();
  const t0 = Date.now();
  let bytes = 0;
  let models = 0;
  let status = null;
  try {
    const res = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(20000) });
    status = res.status;
    const text = await res.text();
    bytes = Buffer.byteLength(text);
    try {
      const j = JSON.parse(text);
      models = Array.isArray(j.data) ? j.data.length : 0;
    } catch {}
  } catch {
    status = 'ERR';
  }
  const ms = Date.now() - t0;
  const after = cpu();
  const delta = Math.round((after.cpu - before.cpu) * 100) / 100;
  rows.push({ i, ms, cpuSec: delta, ratio: ms > 0 ? Math.round((delta * 1000 / ms) * 100) / 100 : null, bytes, models, status, usageAdded: usageCount() - beforeUsage });
  console.log(
    `#${i}\tms=${ms}\tcpuSec=${delta}\tratio=${rows[rows.length - 1].ratio}\tbytes=${bytes}\tmodels=${models}\tstatus=${status}\tusageAdded=${rows[rows.length - 1].usageAdded}`
  );
  if (i < CALLS) await new Promise((r) => setTimeout(r, GAP * 1000));
}

const s = (arr) => [...arr].sort((a, b) => a - b);
const med = (arr) => {
  const x = s(arr);
  return x[Math.floor(x.length / 2)] ?? 0;
};
console.log(
  `\nTỔNG HỢP n=${rows.length} medianMs=${med(rows.map((r) => r.ms))} medianCpuSec=${med(rows.map((r) => r.cpuSec))} medianRatio=${med(rows.filter((r) => r.ratio !== null).map((r) => r.ratio ?? 0))} bytes=${rows[0]?.bytes} models=${rows[0]?.models}`
);