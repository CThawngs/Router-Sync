#!/usr/bin/env node
// tools/agent/combo-lists.mjs
// V4: lập hai danh sách combo chỉ từ bước đã đo (không gọi router).
import fs from 'node:fs';

export function parseRuns(texts) {
  const runs = texts.map((text) => {
    const map = new Map();
    for (const line of text.split('\n')) {
      const p = line.trim().split('\t');
      if (p.length < 4 || !p[0].includes('/')) continue;
      const total = Number.parseInt((p.find((x) => x.startsWith('total=')) ?? '').slice(6), 10);
      map.set(p[0], { verdict: p[1], ms: Number.isFinite(total) ? total : 0 });
    }
    return map;
  });
  return runs;
}

const HANG = new Set(['TIMEOUT-NO-HEADER', 'HANG-AFTER-USAGE', 'HANG-NO-USAGE']);
const DEAD = new Set(['EOL-GONE', 'NO-PROVIDER', 'ERROR-5XX', 'ERROR']);

export function buildLists(runs) {
  const models = new Set();
  for (const run of runs) for (const m of run.keys()) models.add(m);
  const reliable = [];
  const rateLimited = [];
  const hang = [];
  const dead = [];
  for (const m of models) {
    const verdicts = runs.map((r) => r.get(m)?.verdict);
    const times = runs.map((r) => r.get(m)?.ms).filter((n) => Number.isFinite(n) && n > 0);
    const median = times.length ? [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] : 999_999;
    if (verdicts.some((v) => HANG.has(v ?? ''))) hang.push({ step: m, ms: median });
    else if (verdicts.every((v) => v === 'OK')) reliable.push({ step: m, ms: median });
    else if (verdicts.every((v) => v === 'RATE-LIMITED')) rateLimited.push({ step: m, ms: median });
    else if (verdicts.some((v) => DEAD.has(v ?? ''))) dead.push({ step: m, ms: median });
  }
  const byTime = (a, b) => a.ms - b.ms;
  const interleave = (items) => {
    const byProvider = new Map();
    for (const it of [...items].sort(byTime)) {
      const p = it.step.slice(0, it.step.indexOf('/'));
      const arr = byProvider.get(p) ?? [];
      arr.push(it);
      byProvider.set(p, arr);
    }
    const out = [];
    let added = true;
    while (added) {
      added = false;
      for (const arr of byProvider.values()) {
        const it = arr.shift();
        if (it) {
          out.push(it);
          added = true;
        }
      }
    }
    return out;
  };
  const rsFast = [...reliable].sort(byTime).slice(0, 12).map((x) => x.step);
  const rsMax = interleave([...reliable, ...rateLimited]).map((x) => x.step);
  return { rsFast, rsMax, reliable, rateLimited, hang, dead };
}

export function maskStep(step, names) {
  let out = step;
  names.forEach((n, i) => {
    const re = new RegExp(`(?<![A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi');
    out = out.replace(re, `<private-provider-${i + 1}>`);
  });
  return out;
}

export function privateNames() {
  try {
    return JSON.parse(fs.readFileSync('.agent/private-names.local.json', 'utf8'));
  } catch {
    return [];
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const files = process.argv.slice(2);
  if (files.length < 2) {
    console.error('dùng: node tools/agent/combo-lists.mjs <run1.txt> <run2.txt>');
    process.exit(2);
  }
  const result = buildLists(parseRuns(files.map((f) => fs.readFileSync(f, 'utf8'))));
  const names = privateNames();
  console.log('# rs-fast');
  for (const s of result.rsFast) console.log(maskStep(s, names));
  console.log('# rs-max');
  for (const s of result.rsMax) console.log(maskStep(s, names));
  console.log(`# nhóm: RELIABLE=${result.reliable.length} RATE-LIMITED=${result.rateLimited.length} HANG=${result.hang.length} DEAD=${result.dead.length}`);
  // Bản thật cho chủ dự án (chỉ ghi local, không lên repo).
  fs.mkdirSync('.agent/send-final', { recursive: true });
  fs.writeFileSync(
    '.agent/send-final/combo-rs.real.txt',
    ['# rs-fast', ...result.rsFast, '# rs-max', ...result.rsMax].join('\n') + '\n',
    'utf8'
  );
}