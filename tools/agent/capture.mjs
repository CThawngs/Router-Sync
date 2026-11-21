#!/usr/bin/env node
// capture.mjs v3 - chạy một lệnh có giới hạn thời gian, che dữ liệu riêng tư, ghi một bản ghi JSON.
// Cách dùng:   node capture.mjs <id> -- <lệnh và đối số...>
// Đầu ra:      <dir>/<id>.out.txt, <dir>/<id>.err.txt (đã che) và một dòng JSON nối vào <dir>/records.jsonl
// Thư mục <dir> mặc định là ./.agent/evidence (đổi bằng biến RS_EVIDENCE_DIR).
// Giới hạn thời gian: RS_TIMEOUT_SEC (mặc định 900 giây). Quá hạn thì giết cả cây tiến trình, mã thoát = 124.
// Tên cổng riêng: đọc từ ./.agent/private-names.local.json (mảng chuỗi, tệp bị git bỏ qua)
// hoặc biến RS_PRIVATE_NAMES (phân tách bằng dấu phẩy). Che theo ranh giới từ.
// Mã thoát của công cụ = mã thoát của lệnh được chạy (124 khi quá hạn).
// Bản ghi có thêm: durationMs, timedOut, truncated và sys { cpus, totalMemMB, freeMemStartMB, freeMemMinMB }.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, homedir, totalmem, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (argv.length < 3 || sep !== 1) {
  console.error('Dùng: node capture.mjs <id> -- <lệnh...>');
  process.exit(2);
}
const id = argv[0];
if (!/^[A-Za-z0-9._-]+$/.test(id)) {
  console.error('id chỉ gồm chữ, số, dấu chấm, gạch dưới, gạch ngang');
  process.exit(2);
}
const command = argv.slice(sep + 1);
const evidenceDir = resolve(process.env.RS_EVIDENCE_DIR || '.agent/evidence');
mkdirSync(evidenceDir, { recursive: true });
const timeoutSec = Number(process.env.RS_TIMEOUT_SEC || 900);
const MAX_BYTES = 64 * 1024 * 1024;

// ---- danh sách cần che -------------------------------------------------
function loadPrivateNames() {
  const names = new Set();
  const file = resolve('.agent/private-names.local.json');
  if (existsSync(file)) {
    try {
      for (const n of JSON.parse(readFileSync(file, 'utf8'))) if (typeof n === 'string' && n.trim()) names.add(n.trim());
    } catch {
      console.error('private-names.local.json không đọc được');
      process.exit(2);
    }
  }
  for (const n of (process.env.RS_PRIVATE_NAMES || '').split(',')) if (n.trim()) names.add(n.trim());
  return [...names].sort((a, b) => a.localeCompare(b));
}
const privateNames = loadPrivateNames();

const pathLiterals = new Set();
for (const p of [homedir(), process.env.APPDATA, process.env.LOCALAPPDATA, process.env.USERPROFILE]) {
  if (p && p.length > 3) {
    pathLiterals.add(p);
    pathLiterals.add(p.replace(/\\/g, '/'));
    pathLiterals.add(p.replace(/\//g, '\\'));
  }
}
let userName = '';
try {
  userName = userInfo().username || '';
} catch {
  userName = '';
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const counts = { homePath: 0, userName: 0, privateName: 0, email: 0 };

function mask(text) {
  let out = text;
  for (const p of [...pathLiterals].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRe(p), 'gi'), () => {
      counts.homePath++;
      return '<HOME>';
    });
  }
  if (userName.length >= 3) {
    out = out.replace(new RegExp(escapeRe(userName), 'gi'), () => {
      counts.userName++;
      return '<USER>';
    });
  }
  privateNames.forEach((name, i) => {
    const label = `<private-provider-${i + 1}>`;
    const body = escapeRe(name).replace(/[- ]/g, '[- ]');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'gi'), () => {
      counts.privateName++;
      return label;
    });
  });
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => {
    if (/@users\.noreply\.github\.com$/i.test(m)) return m;
    counts.email++;
    return '<EMAIL>';
  });
  return out;
}

// ---- chạy lệnh có giới hạn thời gian ------------------------------------
const MB = 1024 * 1024;
const sys = {
  cpus: availableParallelism ? availableParallelism() : cpus().length,
  totalMemMB: Math.round(totalmem() / MB),
  freeMemStartMB: Math.round(freemem() / MB),
  freeMemMinMB: Math.round(freemem() / MB),
};
const sampler = setInterval(() => {
  const f = Math.round(freemem() / MB);
  if (f < sys.freeMemMinMB) sys.freeMemMinMB = f;
}, 1000);

function killTree(pid) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* tiến trình đã thoát */
  }
}

const startedAt = new Date().toISOString();
const t0 = Date.now();
const outChunks = [];
const errChunks = [];
let outBytes = 0;
let errBytes = 0;
let truncated = false;
let timedOut = false;
let spawnError = '';

const child = spawn(command[0], command.slice(1), {
  shell: process.platform === 'win32',
  detached: process.platform !== 'win32',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
const timer = setTimeout(() => {
  timedOut = true;
  killTree(child.pid);
}, timeoutSec * 1000);

function collect(chunks, getBytes, setBytes) {
  return (buf) => {
    if (getBytes() >= MAX_BYTES) {
      truncated = true;
      return;
    }
    chunks.push(buf);
    setBytes(getBytes() + buf.length);
  };
}
child.stdout.on('data', collect(outChunks, () => outBytes, (n) => (outBytes = n)));
child.stderr.on('data', collect(errChunks, () => errBytes, (n) => (errBytes = n)));
child.on('error', (e) => {
  spawnError = e.message;
});

child.on('close', (code) => {
  clearTimeout(timer);
  clearInterval(sampler);
  const endedAt = new Date().toISOString();
  const exitCode = timedOut ? 124 : typeof code === 'number' ? code : 1;
  const stdout = mask(Buffer.concat(outChunks).toString('utf8'));
  const stderr = mask(
    Buffer.concat(errChunks).toString('utf8') +
      (spawnError ? `\n[spawn-error] ${spawnError}` : '') +
      (timedOut ? `\n[capture] quá hạn ${timeoutSec} giây, đã dừng cả cây tiến trình` : ''),
  );
  writeFileSync(join(evidenceDir, `${id}.out.txt`), stdout, 'utf8');
  writeFileSync(join(evidenceDir, `${id}.err.txt`), stderr, 'utf8');
  const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
  const lines = (s) => (s === '' ? 0 : s.split(/\r?\n/).length);
  const record = {
    id,
    command: mask(command.join(' ')),
    startedAt,
    endedAt,
    durationMs: Date.now() - t0,
    exitCode,
    timedOut,
    truncated,
    stdout: { file: `${id}.out.txt`, sha256: sha(stdout), lines: lines(stdout), bytes: Buffer.byteLength(stdout) },
    stderr: { file: `${id}.err.txt`, sha256: sha(stderr), lines: lines(stderr), bytes: Buffer.byteLength(stderr) },
    masked: { ...counts, privateNamesLoaded: privateNames.length },
    sys,
  };
  appendFileSync(join(evidenceDir, 'records.jsonl'), JSON.stringify(record) + '\n', 'utf8');
  console.log(
    `[capture] ${id} exit=${exitCode}${timedOut ? ' (QUÁ HẠN)' : ''} ${Math.round(record.durationMs / 100) / 10}s stdout=${record.stdout.lines} dòng, stderr=${record.stderr.lines} dòng, freeMemMin=${sys.freeMemMinMB}MB, sha256(stdout)=${record.stdout.sha256.slice(0, 12)}`,
  );
  process.exit(exitCode);
});
