/**
 * packages/cli/src/commands/combos-reliability.ts
 *
 * C37 V3: độ ổn định từng bước, dựa trên `combos probe --mode step`.
 * Mỗi bước: `rounds` vòng, mỗi vòng `repeat` request, cách `gapSec` giây,
 * hạn 30 s, max_tokens 8, stream bật, tuần tự.
 */
import { perStepConclusion, type ComboProbeRow, type VerdictInput } from './combos-probe.js';

async function probeStep(
  step: string,
  opts: { maxTokens: number; timeoutMs: number; fetchImpl?: typeof fetch | undefined; baseUrl?: string | undefined }
): Promise<ComboProbeRow> {
  const base = opts.baseUrl ?? process.env.ROUTERSYNC_9ROUTER_BASE_URL ?? 'http://127.0.0.1:20128';
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const apiKey = process.env.ROUTERSYNC_9ROUTER_KEY ?? '';
  const t0 = Date.now();
  let headerMs: number | null = null;
  let status: number | null = null;
  let text = '';
  let timedOut = false;
  try {
    const res = await fetchImpl(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: step, messages: [{ role: 'user', content: 'ping' }], max_tokens: opts.maxTokens, stream: true }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    headerMs = Date.now() - t0;
    status = res.status;
    text = (await res.text()).slice(0, 300);
  } catch (err) {
    timedOut = true;
    text = err instanceof Error ? err.message : String(err);
  }
  const input: VerdictInput = {
    status,
    body: text.replace(new RegExp(apiKey, 'g'), '<KEY>').slice(0, 200),
    headerReceived: headerMs !== null,
    usageRowAdded: false,
    timedOut,
  };
  return {
    combo: '(step)',
    model: step,
    httpStatus: status,
    headerMs,
    firstByteMs: headerMs,
    totalMs: Date.now() - t0,
    verdict: perStepConclusion(input),
    detail: input.body ?? '',
    usageServedBy: null,
  };
}

export type ReliabilityLabel = 'RELIABLE' | 'SLOW' | 'RATE-LIMITED' | 'HANG' | 'DEAD';

export const RELIABLE_OK_MIN = 5;
export const SLOW_P90_MS = 5_000;
export const STEP_TIMEOUT_MS = 30_000;

export interface StepReliability {
  step: string;
  attempts: number;
  ok: number;
  rateLimited: number;
  failures: number;
  headerMs: number[];
  p50: number | null;
  p90: number | null;
  label: ReliabilityLabel;
}

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? null;
}

/** Phân loại thuần — mọi nhánh có test. Một lần treo => HANG, dù các lần khác OK. */
export function labelStep(input: {
  attempts: number;
  ok: number;
  rateLimited: number;
  timeoutOrNoHeader: number;
  p90Ms: number | null;
}): ReliabilityLabel {
  if (input.timeoutOrNoHeader > 0) return 'HANG';
  if (input.ok < 3 && input.rateLimited === 0) return 'DEAD';
  // 429 nhanh không làm combo treo, nhưng vẫn được ghi riêng để xếp sau bước RELIABLE.
  if (input.rateLimited > 0) return 'RATE-LIMITED';
  if (input.ok >= RELIABLE_OK_MIN && input.p90Ms !== null && input.p90Ms < SLOW_P90_MS) return 'RELIABLE';
  if (input.ok >= RELIABLE_OK_MIN) return 'SLOW';
  return 'DEAD';
}

export function summarizeAttempts(step: string, rows: ComboProbeRow[]): StepReliability {
  const ok = rows.filter((r) => r.verdict === 'OK').length;
  const rateLimited = rows.filter((r) => r.verdict === 'RATE-LIMITED').length;
  const timeoutOrNoHeader = rows.filter(
    (r) => r.verdict === 'TIMEOUT-NO-HEADER' || r.verdict === 'HANG-AFTER-USAGE' || r.verdict === 'HANG-NO-USAGE'
  ).length;
  const headerMs = rows.filter((r) => typeof r.headerMs === 'number').map((r) => r.headerMs as number);
  const p90 = percentile(headerMs, 90);
  return {
    step,
    attempts: rows.length,
    ok,
    rateLimited,
    failures: rows.length - ok,
    headerMs,
    p50: percentile(headerMs, 50),
    p90,
    label: labelStep({ attempts: rows.length, ok, rateLimited, timeoutOrNoHeader, p90Ms: p90 }),
  };
}

export interface ReliabilityOptions {
  from: string;
  repeat?: number;
  rounds?: number;
  gapSec?: number;
  maxMinutes?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export async function runReliability(options: ReliabilityOptions): Promise<{ steps: StepReliability[]; skipped: string[] }> {
  const log = options.log ?? ((l: string) => console.log(l));
  if (!options.from) throw new Error('--from là bắt buộc (tệp kết quả combos probe --mode step)');
  const raw = await import('node:fs').then((fs) => fs.readFileSync(options.from, 'utf8'));
  const targetSteps = raw
    .split('\n')
    .map((l) => l.trim().split('\t')[0] ?? '')
    .filter((s) => s.includes('/'))
    .filter((s, i, all) => all.indexOf(s) === i)
    .slice(0, 70);
  if (targetSteps.length === 0) throw new Error('không tìm thấy bước nào trong --from');

  const repeat = Math.max(1, Math.floor(options.repeat ?? 3));
  const rounds = Math.max(1, Math.floor(options.rounds ?? 2));
  const gapSec = Math.max(0, Math.floor(options.gapSec ?? 5));
  const budgetMs = Math.max(1, options.maxMinutes ?? 40) * 60_000;
  const t0 = Date.now();

  log(`bước cần đo: ${targetSteps.length} (giới hạn 70)`);
  const out: StepReliability[] = [];
  const skipped: string[] = [];
  for (const step of targetSteps) {
    if (Date.now() - t0 > budgetMs) {
      skipped.push(step);
      continue;
    }
    const rows: ComboProbeRow[] = [];
    for (let round = 1; round <= rounds; round += 1) {
      for (let i = 1; i <= repeat; i += 1) {
        const r = await probeStep(step, {
          maxTokens: 8,
          timeoutMs: STEP_TIMEOUT_MS,
          fetchImpl: options.fetchImpl,
          baseUrl: options.baseUrl,
        });
        rows.push(r);
        if (i < repeat || round < rounds) await new Promise((resolve) => setTimeout(resolve, gapSec * 1000));
      }
    }
    const summary = summarizeAttempts(step, rows);
    out.push(summary);
    log(`${step}\t${summary.label}\tok=${summary.ok}/${summary.attempts}\tp90=${summary.p90 ?? '-'}ms`);
  }
  if (skipped.length) log(`chưa đo: ${skipped.length} bước (hết ngân sách)`);
  return { steps: out, skipped };
}
