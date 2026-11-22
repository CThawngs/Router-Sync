/**
 * packages/cli/src/commands/combos-reorder.ts
 *
 * C40 X1: reorder an existing 9Router combo without dropping a single step.
 * Rank 6 (HANG / slow 503) goes last, never removed. Pure functions only.
 */
import type { StepStat } from './combos-plan.js';
import { interleaveProviders, providerOf } from './combos-budget.js';

export type ReorderRank = 1 | 2 | 3 | 4 | 5 | 6;

export const REORDER_HEADERS: Record<ReorderRank, string> = {
  1: '# hạng 1 — RELIABLE (p90 tăng dần)',
  2: '# hạng 2 — SLOW',
  3: '# hạng 3 — RATE-LIMITED (quota; giữ lại khi quota hồi)',
  4: '# hạng 4 — chưa đo',
  5: '# hạng 5 — lỗi nhanh cứng (404/405/400/410)',
  6: '# hạng 6 — HANG / 503 chậm ≥2s (đặt cuối, KHÔNG xoá)',
};

export interface ReliabilityInfo {
  label: 'RELIABLE' | 'SLOW' | 'RATE-LIMITED' | 'HANG' | 'DEAD';
  p90Ms: number | null;
  ok: number;
  attempts: number;
}

/** Đọc output của `combos reliability` (khác định dạng với output probe). */
export function parseReliabilityText(text: string): Map<string, ReliabilityInfo> {
  const out = new Map<string, ReliabilityInfo>();
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split('\t');
    if (p.length < 3) continue;
    const label = p[1] ?? '';
    const step = p[0] ?? '';
    if (!['RELIABLE', 'SLOW', 'RATE-LIMITED', 'HANG', 'DEAD'].includes(label)) continue;
    if (!step.includes('/')) continue;
    const okText = p.find((x) => x.startsWith('ok=')) ?? '';
    const okParts = okText.slice(3).split('/').map(Number);
    const p90 = Number.parseInt((p.find((x) => x.startsWith('p90=')) ?? '').slice(4), 10);
    out.set(step, {
      label: label as ReliabilityInfo['label'],
      p90Ms: Number.isFinite(p90) && p[2] !== 'p90=-ms' ? p90 : null,
      ok: Number.isFinite(okParts[0]) ? (okParts[0] as number) : 0,
      attempts: Number.isFinite(okParts[1]) ? (okParts[1] as number) : 0,
    });
  }
  return out;
}

export interface RankInfo {
  rank: ReorderRank;
  reason: string;
}

export function stepRank(step: string, stat: StepStat | undefined, rel: ReliabilityInfo | undefined): RankInfo {
  if (rel?.label === 'HANG') {
    return { rank: 6, reason: `HANG ok=${rel.ok}/${rel.attempts} p90=${rel.p90Ms ?? '-'}ms` };
  }
  if (stat?.group === 'MOVE-END' || stat?.group === 'REMOVE') {
    return { rank: 6, reason: 'TIMEOUT-NO-HEADER/lỗi cứng ở ≥2 lượt' };
  }
  if (rel?.label === 'RATE-LIMITED' || stat?.verdicts.includes('RATE-LIMITED')) {
    return { rank: 3, reason: '429/quota — thất bại nhanh, giữ lại' };
  }
  const median = stat?.medianMs ?? 0;
  if (rel?.label === 'RELIABLE' || (stat?.group === 'KEEP' && median < 5_000)) {
    return { rank: 1, reason: `RELIABLE p90=${rel?.p90Ms ?? median}ms` };
  }
  if (rel?.label === 'SLOW' || stat?.group === 'KEEP') {
    return { rank: 2, reason: `SLOW p90=${rel?.p90Ms ?? median}ms` };
  }
  if (stat?.group === 'FAST-ERROR') {
    return { rank: 5, reason: '404/405/400 — lỗi nhanh cứng, giữ lại để xác nhận' };
  }
  return { rank: 4, reason: 'chưa đo' };
}

export interface ReorderResult {
  order: string[];
  details: Map<string, RankInfo & { oldIndex: number; newIndex: number }>;
}

/**
 * Giữ nguyên mọi bước. Trong hạng 1 sort theo p90 tăng dần; các hạng khác giữ
 * thứ tự gốc. Xen kẽ provider trong từng hạng.
 */
export function reorderCombo(
  order: string[],
  stats: Map<string, StepStat>,
  rel: Map<string, ReliabilityInfo>
): ReorderResult {
  const buckets = new Map<ReorderRank, Array<{ step: string; rankInfo: RankInfo; oldIndex: number }>>();
  order.forEach((step, oldIndex) => {
    const rankInfo = stepRank(step, stats.get(step), rel.get(step));
    const list = buckets.get(rankInfo.rank) ?? [];
    list.push({ step, rankInfo, oldIndex });
    buckets.set(rankInfo.rank, list);
  });

  const rank1 = buckets.get(1) ?? [];
  rank1.sort((a, b) => {
    const pa = rel.get(a.step)?.p90Ms ?? stats.get(a.step)?.medianMs ?? Number.POSITIVE_INFINITY;
    const pb = rel.get(b.step)?.p90Ms ?? stats.get(b.step)?.medianMs ?? Number.POSITIVE_INFINITY;
    return pa - pb || a.oldIndex - b.oldIndex;
  });
  buckets.set(1, rank1);

  const final: string[] = [];
  const details = new Map<string, RankInfo & { oldIndex: number; newIndex: number }>();
  for (let rank = 1; rank <= 6; rank += 1) {
    const list = buckets.get(rank as ReorderRank) ?? [];
    const interleaved = interleaveProviders(list.map((x) => x.step));
    for (const step of interleaved) {
      const entry = list.find((x) => x.step === step);
      if (!entry) continue;
      details.set(step, { ...entry.rankInfo, oldIndex: entry.oldIndex, newIndex: final.length });
      final.push(step);
    }
  }
  return { order: final, details };
}

/** Vị trí cũ -> mới của các bước HANG (dùng cho báo cáo Agent-1). */
export function hangMoves(result: ReorderResult): Array<{ step: string; oldIndex: number; newIndex: number }> {
  return [...result.details.entries()]
    .filter(([, d]) => d.rank === 6 && d.reason.startsWith('HANG'))
    .map(([step, d]) => ({ step, oldIndex: d.oldIndex, newIndex: d.newIndex }))
    .sort((a, b) => a.oldIndex - b.oldIndex);
}

/** Ghi danh sách theo hạng; mỗi dòng là một bước, kèm lý do cho hạng 6. */
export function formatReorderBody(result: ReorderResult): string[] {
  const lines: string[] = [];
  for (let rank = 1; rank <= 6; rank += 1) {
    const entries = [...result.details.entries()]
      .filter(([, d]) => d.rank === rank)
      .sort((a, b) => a[1].newIndex - b[1].newIndex);
    if (entries.length === 0) continue;
    lines.push(REORDER_HEADERS[rank as ReorderRank]);
    for (const [step, d] of entries) {
      if (rank === 6) lines.push(`# ${step}: ${d.reason} (vị trí ${d.oldIndex} -> ${d.newIndex})`);
      lines.push(step);
    }
    lines.push('');
  }
  return lines;
}

export interface OrderFile {
  steps: string[];
  comments: string[];
  blankLines: number;
}

/** Mỗi dòng là một id đầy đủ; dòng bắt đầu `#` là chú thích. */
export function parseOrderFile(text: string): OrderFile {
  const steps: string[] = [];
  const comments: string[] = [];
  let blankLines = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      blankLines += 1;
      continue;
    }
    if (trimmed.startsWith('#')) {
      comments.push(trimmed);
      continue;
    }
    if (!steps.includes(trimmed)) steps.push(trimmed);
  }
  return { steps, comments, blankLines };
}

export interface BlockedStep {
  step: string;
  reason: string;
}

export interface FileOrderResult extends ReorderResult {
  blocked: BlockedStep[];
  unknownLines: string[];
  usedFile: boolean;
}

/**
 * C40 giữ nguyên xếp hạng. Với `--order file`: bước trong tệp còn đủ điều kiện
 * đứng đầu theo đúng thứ tự tệp; bước HANG/DEAD bị chặn và được báo, không âm
 * thầm đưa lên đầu.
 */
export function reorderWithFile(
  order: string[],
  stats: Map<string, StepStat>,
  rel: Map<string, ReliabilityInfo>,
  orderFile: OrderFile | undefined
): FileOrderResult {
  const base = reorderCombo(order, stats, rel);
  if (!orderFile || orderFile.steps.length === 0) {
    return { ...base, blocked: [], unknownLines: [], usedFile: false };
  }
  const available = new Set(order);
  const blocked: BlockedStep[] = [];
  const unknownLines: string[] = [];
  const promoted: string[] = [];

  for (const step of orderFile.steps) {
    if (!available.has(step)) {
      unknownLines.push(step);
      continue;
    }
    const details = base.details.get(step);
    const label = rel.get(step)?.label;
    if (label === 'HANG' || label === 'DEAD' || details?.reason.startsWith('HANG')) {
      blocked.push({ step, reason: details?.reason ?? `nhãn độ ổn định = ${label ?? 'không rõ'}` });
      continue;
    }
    promoted.push(step);
  }

  const rest = base.order.filter((s) => !promoted.includes(s));
  const final = [...promoted, ...rest];
  const details = new Map(base.details);
  final.forEach((step, index) => {
    const old = details.get(step);
    if (old) details.set(step, { ...old, newIndex: index });
  });
  return { order: final, details, blocked, unknownLines, usedFile: true };
}

/** Kiểm tra bất biến: không mất, không nhân đôi bước nào. */
export function sameSteps(before: string[], after: string[]): boolean {
  if (before.length !== after.length) return false;
  const a = [...before].sort();
  const b = [...after].sort();
  return a.every((x, i) => x === b[i]);
}

export { providerOf };
