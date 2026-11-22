#!/usr/bin/env node
// tools/agent/combo-finalize.mjs
// C40 X2: xếp lại rs-fast/rs-max theo độ ưu tiên fallback và tách model chuyên dụng.
// Chỉ đọc file; ghi bản thật vào .agent/send-final/, bản che do mask-reorder lo.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { interleaveProviders, providerOf } from '../../packages/cli/dist/commands/combos-budget.js';
import { parseReliabilityText } from '../../packages/cli/dist/commands/combos-reorder.js';

export const SPECIALIZED_RE = /calibration|translate|embed|rerank|guard|tts|stt|asr|image/i;

export function specializedReason(step) {
  const hit = String(step).match(SPECIALIZED_RE);
  if (!hit) return null;
  return `tên chứa "${hit[0]}" — suy luận từ tên, không phải số đo; cần chủ dự án xác nhận`;
}

/** Hạng thấp = ưu tiên cao. */
export function priority(step, rel) {
  const info = rel.get(step);
  if (!info) return 4;
  if (info.label === 'RELIABLE') return 1;
  if (info.label === 'SLOW') return 2;
  if (info.label === 'RATE-LIMITED') return 3;
  return 5;
}

export function rankSteps(steps, rel) {
  const groups = new Map();
  steps.forEach((step, index) => {
    const p = priority(step, rel);
    const list = groups.get(p) ?? [];
    list.push({ step, index, p90: rel.get(step)?.p90Ms ?? Number.POSITIVE_INFINITY });
    groups.set(p, list);
  });
  const out = [];
  for (const rank of [...groups.keys()].sort((a, b) => a - b)) {
    const list = groups.get(rank);
    list.sort((a, b) => a.p90 - b.p90 || a.index - b.index);
    out.push(...interleaveProviders(list.map((x) => x.step)));
  }
  return out;
}

export function splitLists(text) {
  const raw = text.split(/\r?\n/).map((l) => l.trim());
  const i = raw.indexOf('# rs-fast');
  const j = raw.indexOf('# rs-max');
  return {
    fast: raw.slice(i + 1, j).filter((s) => s.includes('/')),
    max: raw.slice(j + 1).filter((s) => s.includes('/')),
  };
}

export function finalize(currentText, reliabilityTexts) {
  const rel = new Map();
  for (const text of reliabilityTexts) {
    for (const [step, info] of parseReliabilityText(text)) rel.set(step, info);
  }
  const { fast, max } = splitLists(currentText);
  const needsConfirmation = [];
  const clean = (steps) =>
    steps.filter((step) => {
      const reason = specializedReason(step);
      if (reason) {
        if (!needsConfirmation.some((x) => x.step === step)) needsConfirmation.push({ step, reason });
        return false;
      }
      return true;
    });
  const fastOrdered = rankSteps(clean(fast), rel).slice(0, 12);
  const maxOrdered = rankSteps(clean(max), rel);
  return { fast: fastOrdered, max: maxOrdered, needsConfirmation };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [currentFile, outFile, ...reliabilityFiles] = process.argv.slice(2);
  if (!currentFile || !outFile || reliabilityFiles.length === 0) {
    console.error('dùng: node tools/agent/combo-finalize.mjs <current> <out> <reliability>...');
    process.exit(2);
  }
  const result = finalize(
    readFileSync(currentFile, 'utf8'),
    reliabilityFiles.map((f) => readFileSync(f, 'utf8'))
  );
  mkdirSync(outFile.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  const lines = ['# rs-fast (bản thật, C40)', ...result.fast, '# rs-max (bản thật, C40)', ...result.max];
  writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
  console.log(`fast=${result.fast.length} max=${result.max.length} cần-xác-nhận=${result.needsConfirmation.length}`);
  for (const item of result.needsConfirmation) console.log(`# cần xác nhận: ${item.step} — ${item.reason}`);
  void providerOf;
}
