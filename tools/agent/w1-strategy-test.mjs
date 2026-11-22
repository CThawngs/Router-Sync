#!/usr/bin/env node
// tools/agent/w1-strategy-test.mjs
// W1: so sánh combo round-robin vs fallback bằng tên combo thật (không gọi model lẻ).
import { spawnSync } from 'node:child_process';

const CLI = 'packages/cli/dist/index.js';
const COMBOS = [
  '9Router-Agent',
  '9Router-Combo-1',
  'free-model',
  'nvidia-models',
  '9Router-Agent-1',
  '9Router-Coder-3',
];
const REPS = 4;
const GAP_SEC = 20;

const results = new Map();
for (const name of COMBOS) results.set(name, []);

function probe(combo) {
  const res = spawnSync(
    process.execPath,
    [
      CLI, 'combos', 'probe', '--mode', 'combo',
      '--combo', combo,
      '--yes-spend-tokens',
      '--stop-after-sec', '90',
      '--strategy-report',
      '--json',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  const raw = res.stdout ?? '';
  const i = raw.indexOf('{');
  try {
    const report = JSON.parse(i >= 0 ? raw.slice(i) : '{}');
    return { row: report.rows?.[0] ?? null, strategies: report.strategies ?? {} };
  } catch {
    return { row: null, strategies: {} };
  }
}

for (let rep = 1; rep <= REPS; rep += 1) {
  for (const combo of COMBOS) {
    const list = results.get(combo);
    // Dừng combo này nếu đã treo 2 lần liên tiếp.
    if (list.length >= 2 && list.at(-1)?.hang && list.at(-2)?.hang) {
      console.log(`# bỏ ${combo} ở lượt ${rep}: đã treo 2 lần liên tiếp`);
      continue;
    }
    const { row, strategies } = probe(combo);
    const verdict = row?.verdict ?? 'NO-RESULT';
    const hang = verdict.includes('HANG');
    const entry = { rep, verdict, header: row?.headerMs ?? null, usage: row?.usageServedBy ?? null, hang };
    list.push(entry);
    console.log(
      `${combo}\t${strategies[combo] ?? '?'}\t#${rep}\t${verdict}\theader=${entry.header ?? '-'}ms\tusage=${entry.usage ?? '-'}`
    );
    await new Promise((r) => setTimeout(r, GAP_SEC * 1000));
  }
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
console.log('\n# tổng hợp');
for (const [combo, list] of results) {
  const ok = list.filter((x) => !x.hang && x.header !== null);
  const headers = ok.map((x) => x.header);
  console.log(
    `${combo}\tn=${list.length}\tOK=${ok.length}\tHANG=${list.filter((x) => x.hang).length}\tp50=${med(headers) ?? '-'}ms\tmax=${headers.length ? Math.max(...headers) : '-'}ms`
  );
}