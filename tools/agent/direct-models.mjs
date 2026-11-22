#!/usr/bin/env node
// tools/agent/direct-models.mjs
// T3: gọi thẳng các model đã phục vụ các combo chậm/treo, không qua combo.
import { spawnSync } from 'node:child_process';

const CLI = 'packages/cli/dist/index.js';
const MODELS = [
  'tidepool-alpha-free',
  'glm-5.3-flash',
  'nemotron-3.5-super-vl',
  'gemini-4-hydrogen',
  'ernie-5.5-flash-preview',
];
const TOKENS = [8, 64];

for (const model of MODELS) {
  for (const maxTokens of TOKENS) {
    const res = spawnSync(
      process.execPath,
      [
        CLI, 'combos', 'probe', '--mode', 'step',
        '--only', model,
        '--max-tokens', String(maxTokens),
        '--repeat', '3',
        '--yes-spend-tokens',
        '--json',
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
    const raw = res.stdout ?? '';
    const start = raw.indexOf('{');
    let verdicts = [];
    let headers = [];
    try {
      const report = start >= 0 ? JSON.parse(raw.slice(start)) : {};
      verdicts = (report.rows ?? []).map((r) => r.verdict);
      headers = (report.rows ?? []).map((r) => r.headerMs);
    } catch {}
    if (verdicts.length === 0) {
      console.log(`${model}\tmt=${maxTokens}\tKHÔNG TÌM THẤY BƯỚC`);
      continue;
    }
    const ok = headers.filter((h) => typeof h === 'number');
    const med = ok.length ? [...ok].sort((a, b) => a - b)[Math.floor(ok.length / 2)] : null;
    console.log(
      `${model}\tmt=${maxTokens}\tn=${verdicts.length}\tverdicts=${verdicts.join(',')}\theaders=${headers.join(',')}ms\tmedian=${med ?? '-'}ms`
    );
  }
}