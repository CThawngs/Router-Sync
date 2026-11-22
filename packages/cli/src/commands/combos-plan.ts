/**
 * packages/cli/src/commands/combos-plan.ts
 *
 * C33 N3: build a trimming plan for a combo from one or more `combos probe`
 * step runs. Read-only: it opens the 9Router database read-only and writes a
 * plan file. It never writes to the router.
 *
 * Groups (N3.1):
 *   REMOVE     hard error in at least two runs more than a minute apart
 *              (EOL-GONE, or NO-PROVIDER with a matching message)
 *   MOVE-END   TIMEOUT-NO-HEADER in at least two runs
 *   KEEP       OK in two runs, ordered by measured time
 *   FAST-ERROR 404/405/400 — listed only, never a removal reason
 *   UNTESTED   everything else (ABSENT, UNVERIFIABLE, NOT-LISTED, NOT-IN-CATALOG)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { locateRouterDb } from '@routersync/core';
import { readRouterState } from './combos-probe.js';

export type ProbeVerdict =
  | 'OK'
  | 'EOL-GONE'
  | 'NO-PROVIDER'
  | 'RATE-LIMITED'
  | 'AUTH'
  | 'TIMEOUT-NO-HEADER'
  | 'HANG-AFTER-USAGE'
  | 'ERROR-5XX'
  | 'ERROR';

export type PlanGroup = 'REMOVE' | 'MOVE-END' | 'KEEP' | 'FAST-ERROR' | 'UNTESTED';

export interface ProbeRow {
  model: string;
  verdict: ProbeVerdict;
  ms: number;
  startedAt: string | null;
}

/** Parse one `combos probe --mode step` text output. */
export function parseProbeText(text: string): ProbeRow[] {
  const rows: ProbeRow[] = [];
  let startedAt: string | null = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('bắt đầu=')) {
      startedAt = t.slice('bắt đầu='.length).split(' ')[0] ?? null;
      continue;
    }
    const p = t.split('\t');
    if (p.length < 4) continue;
    const model = p[0];
    if (!model || !model.includes('/')) continue;
    const verdict = p[1] as ProbeVerdict;
    const total = Number.parseInt((p.find((x) => x.startsWith('total=')) ?? '').slice(6), 10);
    rows.push({ model, verdict, ms: Number.isFinite(total) ? (total as number) : 0, startedAt });
  }
  return rows;
}

export interface StepStat {
  model: string;
  runs: number;
  startedAts: string[];
  verdicts: ProbeVerdict[];
  medianMs: number;
  okCount: number;
  timeoutCount: number;
  hangCount: number;
  hardCount: number;
  fastErrorCount: number;
  group: PlanGroup;
}

const HARD: ReadonlySet<ProbeVerdict> = new Set(['EOL-GONE', 'NO-PROVIDER']);
const FAST_ERROR: ReadonlySet<ProbeVerdict> = new Set(['ERROR', 'AUTH', 'RATE-LIMITED', 'ERROR-5XX']);

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length === 1) return s[0] ?? 0;
  return Math.round(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

/**
 * Merge several probe runs into one stat per step and assign a group.
 * `minGapMs` is the required spacing between the two runs that agree on a hard
 * error (N3.1: more than one minute apart).
 */
export function buildStats(runs: ProbeRow[][], minGapMs = 60_000): Map<string, StepStat> {
  const byModel = new Map<string, { rows: ProbeRow[]; runIndex: Map<string, number> }>();
  runs.forEach((rows, runIdx) => {
    for (const r of rows) {
      const cur = byModel.get(r.model) ?? { rows: [] as ProbeRow[], runIndex: new Map<string, number>() };
      cur.rows.push(r);
      cur.runIndex.set(r.startedAt ?? `run${runIdx}`, runIdx);
      byModel.set(r.model, cur);
    }
  });

  const out = new Map<string, StepStat>();
  for (const [model, { rows, runIndex }] of byModel) {
    const verdicts = rows.map((r) => r.verdict);
    const hardRows = rows.filter((r) => HARD.has(r.verdict));
    // Hai lượt cách nhau hơn một phút: so startedAt của hai bản ghi khác lượt.
    let hardAgreed = false;
    if (hardRows.length >= 2) {
      const stamps = rows.map((r) => Date.parse(r.startedAt ?? '')).filter((n) => Number.isFinite(n));
      for (let i = 0; i < hardRows.length && !hardAgreed; i += 1) {
        for (let j = i + 1; j < hardRows.length; j += 1) {
          const rowA0 = hardRows[i];
          const rowB0 = hardRows[j];
          if (!rowA0 || !rowB0) continue;
          if (runIndex.get(rowA0.startedAt ?? '') === runIndex.get(rowB0.startedAt ?? '')) continue;
          const rowA = hardRows[i];
          const rowB = hardRows[j];
          if (!rowA || !rowB) continue;
          const a = Date.parse(rowA.startedAt ?? '');
          const b = Date.parse(rowB.startedAt ?? '');
          if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) >= minGapMs) hardAgreed = true;
        }
      }
      // Không có startedAt (đầu vào cũ): coi hai lượt là đủ nếu khác file.
      if (!hardAgreed && stamps.length === 0 && hardRows.length >= 2) hardAgreed = true;
    }
    const okCount = verdicts.filter((v) => v === 'OK').length;
    const timeoutCount = verdicts.filter((v) => v === 'TIMEOUT-NO-HEADER').length;
    const hangCount = verdicts.filter((v) => v === 'HANG-AFTER-USAGE').length;
    const hardCount = hardRows.length;
    const fastErrorCount = verdicts.filter((v) => FAST_ERROR.has(v)).length;

    let group: PlanGroup = 'UNTESTED';
    if (hardCount >= 2 && hardAgreed) group = 'REMOVE';
    else if (timeoutCount >= 2) group = 'MOVE-END';
    else if (okCount >= 2) group = 'KEEP';
    else if (fastErrorCount >= 1) group = 'FAST-ERROR';

    out.set(model, {
      model,
      runs: rows.length,
      startedAts: [...new Set(rows.map((r) => r.startedAt ?? ''))],
      verdicts,
      medianMs: median(rows.map((r) => r.ms)),
      okCount,
      timeoutCount,
      hangCount,
      hardCount,
      fastErrorCount,
      group,
    });
  }
  return out;
}

/** N0 model: time to header = sum of measured times up to and including the first KEEP step. */
export function predictHeaderMs(order: string[], stats: Map<string, StepStat>): number | null {
  let sum = 0;
  for (const step of order) {
    const st = stats.get(step);
    sum += st?.medianMs ?? 0;
    if (st?.group === 'KEEP') return sum;
  }
  return null;
}

export interface PlanVariant {
  name: string;
  steps: string[];
  predictedHeaderMs: number | null;
  /** C34 Q0.4 */
  note?: string | undefined;
  removed: number;
  movedToEnd: number;
}

export interface ComboPlan {
  combo: string;
  order: string[];
  planA: PlanVariant;
  planB: PlanVariant;
  kept: string[];
  remove: string[];
  moveEnd: string[];
  fastError: string[];
  untested: string[];
}

export function buildComboPlan(combo: string, order: string[], stats: Map<string, StepStat>): ComboPlan {
  const groupOf = (s: string): PlanGroup => stats.get(s)?.group ?? 'UNTESTED';
  const remove = order.filter((s) => groupOf(s) === 'REMOVE');
  const moveEnd = order.filter((s) => groupOf(s) === 'MOVE-END');
  const keep = order.filter((s) => groupOf(s) === 'KEEP');
  const fastError = order.filter((s) => groupOf(s) === 'FAST-ERROR');
  const untested = order.filter((s) => groupOf(s) === 'UNTESTED');

  // Phương án A: bản gọn của chính combo — bỏ nhóm gỡ, đưa nhóm timeout xuống cuối.
  const middle = order.filter((s) => groupOf(s) !== 'REMOVE' && groupOf(s) !== 'MOVE-END');
  const planASteps = [...middle, ...moveEnd];

  // Phương án B: chỉ gồm bước OK hai lượt, sắp theo thời gian tăng dần.
  const planBSteps = [...keep].sort((a, b) => (stats.get(a)?.medianMs ?? 0) - (stats.get(b)?.medianMs ?? 0));

  return {
    combo,
    order,
    planA: {
      name: `${combo} (gọn)`,
      steps: planASteps,
      predictedHeaderMs: predictHeaderMs(planASteps, stats),
      note: MODEL_CAVEAT,
      removed: remove.length,
      movedToEnd: moveEnd.length,
    },
    planB: {
      name: `${combo} (chỉ bước OK)`,
      steps: planBSteps,
      predictedHeaderMs: predictHeaderMs(planBSteps, stats),
      note: MODEL_CAVEAT,
      removed: order.length - planBSteps.length,
      movedToEnd: 0,
    },
    kept: keep,
    remove,
    moveEnd,
    fastError,
    untested,
  };
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Như trên nhưng không ném khi tệp không tồn tại (DB chưa từng mở được). */
function sha256IfExists(file: string | undefined): string {
  if (!file) return '(không có)';
  try {
    return sha256File(file);
  } catch {
    return '(không đọc được)';
  }
}

export interface PlanFile {
  generatedAt: string;
  router: string;
  sourceDb: string;
  sourceDbSha256: string;
  probeRuns: Array<{ file: string; rows: number }>;
  minGapMinutes: number;
  counts: Record<PlanGroup, number>;
  /** C34 Q0.4: cảnh báo về độ tin cậy của predictedHeaderMs. */
  modelCaveat: string;
  combos: ComboPlan[];
  note: string;
}

export interface PlanOptions {
  router?: string | undefined;
  from: string[];
  out: string;
  minGapMinutes?: number;
  log?: (line: string) => void;
  readState?: () => { combos: Array<{ name: string; steps: string[] }>; dbPath?: string | undefined };
}

/** C34 Q0.4: dự đoán chỉ tính phần trước bước phục vụ. */
export const MODEL_CAVEAT =
  'predictedHeaderMs chỉ cộng thời gian các bước trước bước phục vụ, bỏ qua phần chờ sau khi usageHistory đã ghi (C34: 80–130 s). Vì vậy đây là cận dưới, không phải thời gian dự kiến. Sai số mô hình ở C33: trung vị 33.7%, tối đa 80.8%.';

const NOTE =
  'Kế hoạch, không phải thay đổi. Không có lệnh nào ghi vào router ở đây. ' +
  'Không xoá bước theo ABSENT / UNVERIFIABLE / NOT-LISTED-UPSTREAM / NOT-IN-CATALOG. ' +
  'Nhóm REMOVE cần chủ dự án xác nhận; nhóm MOVE-END chỉ là gợi ý thứ tự.';

export function runCombosPlan(options: PlanOptions): PlanFile {
  const log = options.log ?? ((l: string) => console.log(l));
  if (!options.out) throw new Error('--out là bắt buộc');
  const runs = options.from.map((file) => ({ file, rows: parseProbeText(readFileSync(file, 'utf8')) }));
  if (runs.length === 0) throw new Error('không có file kết quả probe nào đọc được');

  const state = options.readState ? options.readState() : readComboOrder(options.router ?? '9router');
  const stats = buildStats(
    runs.map((r) => r.rows),
    (options.minGapMinutes ?? 1) * 60_000
  );

  const counts: Record<PlanGroup, number> = { REMOVE: 0, 'MOVE-END': 0, KEEP: 0, 'FAST-ERROR': 0, UNTESTED: 0 };
  for (const s of stats.values()) counts[s.group] += 1;

  const combos = state.combos.map((c) => buildComboPlan(c.name, c.steps, stats));
  const plan: PlanFile = {
    generatedAt: new Date().toISOString(),
    router: options.router ?? '9router',
    // Chỉ ghi tên tệp: đường dẫn tuyệt đối để lộ đường dẫn cá nhân khi gói bằng chứng đi xa.
    sourceDb: state.dbPath ? basename(state.dbPath) : '(không xác định)',
    sourceDbSha256: sha256IfExists(state.dbPath),
    // Chỉ tên tệp, không phải đường dẫn đầy đủ.
    probeRuns: runs.map((r) => ({ file: basename(r.file), rows: r.rows.length })),
    minGapMinutes: options.minGapMinutes ?? 1,
    counts,
    modelCaveat: MODEL_CAVEAT,
    combos,
    note: NOTE,
  };

  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  log(`đã ghi kế hoạch: ${options.out} (${combos.length} combo)`);
  log(`nhóm: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  return plan;
}

function readComboOrder(router: string): { combos: Array<{ name: string; steps: string[] }>; dbPath?: string | undefined } {
  const st = readRouterState();
  let dbPath: string | undefined;
  try {
    dbPath = locateRouterDb(router === 'omniroute' ? 'omniroute' : '9router');
  } catch {
    dbPath = undefined;
  }
  return { combos: st.combos.map((c) => ({ name: c.name, steps: c.steps })), dbPath };
}
