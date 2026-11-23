#!/usr/bin/env node
// tools/agent/combo-finalize.mjs
// C40 X2 / C43 R2: xếp lại rs-fast/rs-max theo độ ưu tiên fallback và tách model chuyên dụng.
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
  if (!info || info.label === 'LOW-SAMPLE') return 4;
  if (info.label === 'RELIABLE') return 1;
  if (info.label === 'SLOW') return 2;
  if (info.label === 'RATE-LIMITED') return 3;
  return 5;
}

export function rankSteps(steps, rel, orderSteps = []) {
  const preferred = orderSteps.filter((step) => steps.includes(step));
  const rest = steps.filter((step) => !preferred.includes(step));
  return [...preferred, ...rankByReliability(rest, rel)];
}

function rankByReliability(steps, rel) {
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
  const i = raw.findIndex((l) => /^#\s*rs-fast\b/.test(l));
  const j = raw.findIndex((l) => /^#\s*rs-max\b/.test(l));
  const fastStart = i >= 0 ? i + 1 : 0;
  const fastEnd = j >= 0 ? j : raw.length;
  const maxStart = j >= 0 ? j + 1 : raw.length;
  return {
    fast: raw.slice(fastStart, fastEnd).filter((s) => s.includes('/') && !s.startsWith('#')),
    max: raw.slice(maxStart).filter((s) => s.includes('/') && !s.startsWith('#')),
  };
}

/**
 * C43 R2: trích danh sách các bước không chuyên dụng đạt LOW-SAMPLE, sắp theo p90Ms tăng dần.
 */
export function extractLowSampleCandidates(reliabilityTexts) {
  const texts = Array.isArray(reliabilityTexts) ? reliabilityTexts : [reliabilityTexts];
  const rel = new Map();
  for (const text of texts) {
    for (const [step, info] of parseReliabilityText(String(text ?? ''))) {
      rel.set(step, info);
    }
  }
  const candidates = [];
  for (const [step, info] of rel.entries()) {
    if (info.label !== 'LOW-SAMPLE') continue;
    if (specializedReason(step)) continue;
    candidates.push({
      step,
      p90Ms: info.p90Ms,
      ok: info.ok,
      attempts: info.attempts,
    });
  }
  candidates.sort((a, b) => {
    const pa = a.p90Ms ?? Number.POSITIVE_INFINITY;
    const pb = b.p90Ms ?? Number.POSITIVE_INFINITY;
    return pa - pb || a.step.localeCompare(b.step);
  });
  return candidates;
}

export function finalize(currentText, reliabilityTexts, orderSteps = []) {
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
  const fastOrdered = rankSteps(clean(fast), rel, orderSteps).slice(0, 12);
  const maxOrdered = rankSteps(clean(max), rel, orderSteps);
  return { fast: fastOrdered, max: maxOrdered, needsConfirmation };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const orderIndex = args.indexOf('--order-file');
  const orderSteps =
    orderIndex >= 0 && args[orderIndex + 1]
      ? readFileSync(args[orderIndex + 1], 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.includes('/') && !l.startsWith('#'))
      : [];
  const cleanArgs = orderIndex >= 0 ? args.filter((_, i) => i !== orderIndex && i !== orderIndex + 1) : args;
  const [currentFile, outFile, ...reliabilityFiles] = cleanArgs;
  if (!currentFile || !outFile || reliabilityFiles.length === 0) {
    console.error('dùng: node tools/agent/combo-finalize.mjs <current> <out> <reliability>...');
    process.exit(2);
  }
  const result = finalize(
    readFileSync(currentFile, 'utf8'),
    reliabilityFiles.map((f) => readFileSync(f, 'utf8')),
    orderSteps
  );
  mkdirSync(outFile.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  const lines = ['# rs-fast (bản thật, C40)', ...result.fast, '# rs-max (bản thật, C40)', ...result.max];
  writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
  console.log(`fast=${result.fast.length} max=${result.max.length} cần-xác-nhận=${result.needsConfirmation.length}`);
  for (const item of result.needsConfirmation) console.log(`# cần xác nhận: ${item.step} — ${item.reason}`);
  void providerOf;
}
