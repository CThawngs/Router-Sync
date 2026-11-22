#!/usr/bin/env node
// tools/agent/router-process.mjs
//
// T0: thông tin tiến trình 9Router (chỉ đọc) + năm tiến trình tốn RSS nhất.
// Không in key; tên tiến trình không thuộc danh sách công khai thì ghi <proc-N>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const KNOWN_PROCESS_NAMES = new Set([
  'node', 'code', 'chrome', 'msedge', 'explorer', 'powershell', 'pwsh', 'svchost', 'system',
  'memory compression', 'searchindexer', 'antimalware service executable', 'dwm', 'csrss', 'wininit',
  'services', 'lsass', 'fontdrvhost', 'conhost', 'audiodg', 'sihost', 'taskhostw', 'runtimebroker',
  'startmenuexperiencehost', 'shellinfrastructure', 'textinputhost', 'securityhealthservice',
]);

const base = path.join(process.env.APPDATA || os.homedir(), '9router');
const launcher = JSON.parse(fs.readFileSync(path.join(base, 'launcher.pid'), 'utf8'));
const pid = launcher.serverPid;

function ps(...args) {
  return execFileSync('powershell', ['-NoProfile', '-Command', ...args], { encoding: 'utf8' });
}

const raw = ps(
  `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){"{0}|{1}|{2}|{3}|{4}" -f $p.StartTime.ToString('o'), [math]::Round(((Get-Date)-$p.StartTime).TotalHours,2), [math]::Round($p.WorkingSet64/1MB,0), [math]::Round($p.PrivateMemorySize64/1MB,0), [math]::Round($p.CPU,0)} else {"NOT_FOUND"}`
).trim();
const [start, ageH, rss, priv, cpu] = raw.split('|');
console.log(`pid=${pid} cliPid=${launcher.cliPid} port=${launcher.port}`);
console.log(`start=${start} ageHours=${ageH} rssMB=${rss} privateMB=${priv} cpuSec=${cpu}`);
const children = ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Measure-Object).Count`).trim();
console.log(`children=${children}`);
console.log(`freeMB=${Math.round(os.freemem() / 1048576)} totalMB=${Math.round(os.totalmem() / 1048576)}`);

const top = ps(
  `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 | ForEach-Object { "{0}|{1}" -f $_.ProcessName, [math]::Round($_.WorkingSet64/1MB,0) }`
)
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
let unknown = 0;
console.log('# top5 RSS (tên tiến trình và MB)');
for (const line of top) {
  const [name, mb] = line.split('|');
  const safe = KNOWN_PROCESS_NAMES.has(String(name).toLowerCase()) ? String(name) : `<proc-${++unknown}>`;
  console.log(`${safe}\t${mb}MB`);
}

export { KNOWN_PROCESS_NAMES };